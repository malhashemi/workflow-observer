import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transcripts, type RetainedEvidence } from "./transcripts";
import { Effect } from "effect";
import { combineUsage, summarizeUsage, normalizeUsage } from "./pricing";
import { PRICING_REVISION } from "./pricing-rules";
import type { Catalog } from "./catalog";
import type { RecordData, RunSummary, SessionSummary } from "./types";
import { DEFAULT_WINDOW, cutoffFor, type WindowDays } from "./windows";

export type SessionRun = RunSummary & { transcripts: string[] };
type Kind = "workflow" | "parent" | "other";
interface Evidence {
  kind: Kind;
  messages: Record<string, RecordData>;
}

export function sessionUsage(parts: Evidence[], session: string, catalog: Catalog) {
  const unique = new Map<string, { kind: Kind; record: RecordData; conflict: boolean }>();
  const signature = (r: RecordData) => JSON.stringify([r.model, normalizeUsage(r.usage ?? {})]);
  const priority = { workflow: 0, parent: 1, other: 2 };
  for (const part of parts) {
    for (const [id, message] of Object.entries(part.messages)) {
      if (message.sessionId && message.sessionId !== session) continue;
      const previous = unique.get(id);
      if (!previous) unique.set(id, { kind: part.kind, record: message, conflict: false });
      else {
        // Use the later recorded correction, independent of file traversal order.
        const [older, newer] =
          (previous.record.time ?? 0) > (message.time ?? 0)
            ? [message, previous.record]
            : [previous.record, message];
        unique.set(id, {
          kind: priority[part.kind] < priority[previous.kind] ? part.kind : previous.kind,
          record: { ...older, ...newer, usage: { ...older.usage, ...newer.usage } },
          conflict:
            (message.time ?? 0) > (previous.record.time ?? 0)
              ? false
              : (message.time ?? 0) < (previous.record.time ?? 0)
                ? previous.conflict
                : previous.conflict || signature(previous.record) !== signature(message),
        });
      }
    }
  }
  const buckets: Record<Kind, Record<string, RecordData>> = {
    workflow: Object.create(null),
    parent: Object.create(null),
    other: Object.create(null),
  };
  let conflictingRequests = 0;
  for (const [id, { kind, record, conflict }] of unique) {
    if (conflict) conflictingRequests++;
    else buckets[kind][id] = record;
  }
  const workflowUsage = summarizeUsage(buckets.workflow, catalog);
  const parentUsage = summarizeUsage(buckets.parent, catalog);
  const otherUsage = summarizeUsage(buckets.other, catalog);
  return {
    workflowUsage,
    parentUsage,
    otherUsage,
    usage: combineUsage([workflowUsage, parentUsage, otherUsage]),
    conflictingRequests,
  };
}

export class Sessions {
  constructor(
    readonly db: Database,
    readonly transcripts: Transcripts,
    readonly catalog: Catalog,
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS session_windows (key TEXT, days INTEGER, modified REAL, fingerprint TEXT, files TEXT, data TEXT, PRIMARY KEY(key,days))",
    );
    db.run("CREATE INDEX IF NOT EXISTS session_windows_modified ON session_windows(days,modified)");
  }
  list(days: WindowDays = DEFAULT_WINDOW, runs?: RunSummary[]) {
    const keys = runs ? new Set(runs.map((r) => r.key)) : null;
    const sessions = (
      this.db
        .query("SELECT data FROM session_windows WHERE days=? AND modified>=?")
        .all(days, cutoffFor(days)) as { data: string }[]
    ).map(({ data }) => JSON.parse(data) as SessionSummary);
    return keys
      ? sessions.filter(
          (s) =>
            s.runKeys.length &&
            s.runKeys.every((key) => keys.has(key)) &&
            runs!.filter((r) => r.sessionInfo?.key === s.key).length === s.runKeys.length,
        )
      : sessions;
  }
  async refresh(
    runs: SessionRun[],
    days: WindowDays = DEFAULT_WINDOW,
    cutoff = cutoffFor(days),
    excludedWorkflows = 0,
    catalog = this.catalog.snapshot(),
    retained = false,
  ) {
    const info = runs[0].sessionInfo!;
    const old = this.db
      .query("SELECT fingerprint, files, data FROM session_windows WHERE key=? AND days=?")
      .get(info.key, days) as { fingerprint: string; files: string; data: string } | null;
    const dir = info.transcript.slice(0, -6);
    let listingError = false;
    const discovered = (
      retained
        ? []
        : await readdir(join(dir, "subagents")).catch((e) => {
            listingError = e.code !== "ENOENT";
            return [];
          })
    )
      .filter((name) => /^agent-.+\.jsonl$/.test(name))
      .map((name) => join(dir, "subagents", name));
    const workflowFiles = new Set(runs.flatMap((r) => r.transcripts));
    // Across date windows, membership can only come from already indexed sessions.
    const savedFiles = retained
      ? (
          this.db.query("SELECT files FROM session_windows WHERE key=?").all(info.key) as {
            files: string;
          }[]
        ).flatMap((r) => JSON.parse(r.files))
      : old
        ? JSON.parse(old.files)
        : [];
    const candidates = [...new Set<string>([...savedFiles, ...discovered])];
    const retainedEvidence = new Map<string, RetainedEvidence>();
    const readRetained = async (path: string, parent = false) => {
      if (!retainedEvidence.has(path))
        retainedEvidence.set(
          path,
          await Effect.runPromise(
            this.transcripts.readRetained(
              parent ? { kind: "parent", path, session: runs[0].session } : { kind: "agent", path },
            ),
          ),
        );
      return retainedEvidence.get(path)!;
    };
    const otherFiles = new Set<string>();
    for (const path of candidates) {
      const inspection = retained
        ? await readRetained(path)
        : await Effect.runPromise(this.transcripts.inspect({ kind: "agent", path }));
      const modified = inspection.modified;
      if (modified >= cutoff) otherFiles.add(path);
    }
    const excludedAgents = candidates.length - otherFiles.size;
    const paths = [info.transcript, ...workflowFiles, ...otherFiles];
    const stamps = await Promise.all(
      paths.map(async (path) => {
        const ref =
          path === info.transcript
            ? { kind: "parent" as const, path, session: runs[0].session }
            : { kind: "agent" as const, path };
        return (
          retained
            ? await readRetained(path, path === info.transcript)
            : await Effect.runPromise(this.transcripts.inspect(ref))
        ).stamp;
      }),
    );
    const fingerprint = JSON.stringify([
      "session-window-v3",
      retained,
      PRICING_REVISION,
      days,
      excludedWorkflows,
      excludedAgents,
      listingError,
      stamps,
      runs.map((r) => [r.key, r.indexed]),
      catalog.fingerprint,
    ]);
    if (old?.fingerprint === fingerprint)
      return retained
        ? (JSON.parse(old.data).warnings as string[]).filter((w) =>
            w.startsWith("Retained evidence:"),
          )
        : listingError
          ? ["The agent directory could not be listed; discovery is incomplete."]
          : [];
    const retainedIssues: string[] = [];
    let unavailable = 0;
    let missingAgents = 0;
    let parseErrors = 0;
    const evidence: Evidence[] = [];
    const read = async (path: string, parent = false): Promise<RecordData> => {
      const current = retained
        ? await readRetained(path, parent)
        : await Effect.runPromise(
            this.transcripts.readCurrent(
              parent ? { kind: "parent", path, session: runs[0].session } : { kind: "agent", path },
            ),
          );
      if (!current.data) {
        if (current.status !== "available") unavailable++;
        if (retained)
          retainedIssues.push(
            `Retained evidence: ${path}: ${current.reason ?? "No compatible retained evidence"}. Usage excluded.`,
          );
      }
      const raw = current.data ?? { messages: {} };
      parseErrors += raw.parseErrors ?? 0;
      return raw;
    };
    const parent = await read(info.transcript, true);
    evidence.push({ kind: "parent", messages: parent.messages ?? {} });
    for (const [kind, files] of [
      ["workflow", workflowFiles],
      ["other", otherFiles],
    ] as const) {
      for (const path of files) {
        const raw = await read(path);
        const messages = raw.messages ?? {};
        if (!summarizeUsage(messages, catalog).requests) missingAgents++;
        evidence.push({ kind, messages });
      }
    }
    const accounting = sessionUsage(evidence, runs[0].session, catalog);
    const warnings = [
      ...(retained ? ["Unwatched history: estimates use previously indexed requests only."] : []),
      ...retainedIssues,
      ...(excludedWorkflows
        ? [
            `${excludedWorkflows} older workflows are outside this time window; their usage is excluded.`,
          ]
        : []),
      ...(excludedAgents
        ? [`${excludedAgents} older agents are outside this time window; their usage is excluded.`]
        : []),
      ...(accounting.conflictingRequests
        ? [
            `${accounting.conflictingRequests} response IDs have conflicting usage with no recorded ordering; excluded from totals.`,
          ]
        : []),
      ...(!accounting.parentUsage.requests ? ["No parent conversation usage recorded."] : []),
      ...(listingError
        ? ["The agent directory could not be listed; discovery is incomplete."]
        : []),
      ...(runs.some((r) => r.agentCount === 0)
        ? ["Some workflows have no recorded agent evidence."]
        : []),
      ...(missingAgents ? [`${missingAgents} agents have no recorded request usage.`] : []),
      ...(unavailable
        ? [
            `${unavailable} transcript files unavailable. Cached content deleted; unavailable usage is excluded.`,
          ]
        : []),
      ...(parseErrors ? [`${parseErrors} malformed or oversized transcript lines skipped.`] : []),
    ];
    const session: SessionSummary = {
      ...info,
      ...(retained
        ? {
            name: parent.title ? info.name : null,
            nameSource: parent.title ? info.nameSource : null,
          }
        : (parent.title ?? { name: null, nameSource: null })),
      id: runs[0].session,
      profile: runs[0].profile,
      project: runs[0].project,
      cwd: runs[0].cwd,
      runKeys: runs.map((r) => r.key),
      windowDays: days,
      excludedWorkflows,
      started: Math.min(...runs.map((r) => r.started).filter(Boolean)) || 0,
      modified:
        retained && old
          ? JSON.parse(old.data).modified
          : Math.max(parent.modified || 0, ...runs.map((r) => r.modified)),
      ...accounting,
      warnings,
      pricingAsOf: catalog.updated,
      indexed: Date.now(),
    };
    if (!Number.isFinite(session.started)) session.started = 0;
    this.db
      .query("INSERT OR REPLACE INTO session_windows VALUES (?,?,?,?,?,?)")
      .run(
        info.key,
        days,
        session.modified,
        fingerprint,
        JSON.stringify([...otherFiles]),
        JSON.stringify(session),
      );
    return [
      ...retainedIssues,
      ...(listingError
        ? ["The agent directory could not be listed; discovery is incomplete."]
        : []),
    ];
  }
}
