import { Database } from "bun:sqlite";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Effect, Data } from "effect";
import { analyzePlan, mergePhases } from "./plans";
import { Transcripts } from "./transcripts";
import { combineUsage, summarizeUsage, emptyUsage } from "./pricing";
import { PRICING_REVISION } from "./pricing-rules";
import { Sessions, type SessionRun } from "./sessions";
import { WindowDemand, DEFAULT_WINDOW, cutoffFor, type WindowDays } from "./windows";
import { agentState, stateOf, workflowStatus } from "./status";
import type { Catalog } from "./catalog";
import type { Run, Agent, RecordData, RunSummary } from "./types";
class IndexError extends Data.TaggedError("IndexError")<{ path: string; message: string }> {}
const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const directories = async (p: string) =>
  (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
const json = async (p: string) => JSON.parse(await readFile(p, "utf8"));
export function runKey(root: string, project: string, session: string, id: string) {
  return createHash("sha256")
    .update(JSON.stringify([root, project, session, id]))
    .digest("hex")
    .slice(0, 24);
}
export { stateOf } from "./status";
export interface ScanInputs {
  roots: readonly string[];
  catalog: Catalog;
  windows: WindowDays[];
  now: number;
}
export interface ScanOutcome {
  state: "complete" | "partial";
  windows: WindowDays[];
  errors: string[];
  finishedAt: number;
  results: Record<number, { state: "complete" | "partial"; errors: string[] }>;
}
export class Indexer {
  db: Database;
  readonly indexId: string;
  get evidenceStamp() {
    return { indexId: this.indexId, evidenceRevision: this.evidenceGeneration };
  }
  transcripts: Transcripts;
  sessions: Sessions;
  readonly windows = new WindowDemand();
  readonly updatedWindows = new Map<WindowDays, number>();
  sources: { path: string; state: string; runs: number; error?: string }[] = [];
  errors: string[] = [];
  scanning = false;
  lastScan = 0;
  evidenceGeneration = 0;
  constructor(
    readonly roots: string[],
    dataDir: string,
    readonly catalog: Catalog,
  ) {
    this.db = new Database(join(dataDir, "observer.sqlite"), { create: true });
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS index_identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    this.db.query("INSERT OR IGNORE INTO index_identity VALUES (1,?)").run(randomUUID());
    this.indexId = (
      this.db.query("SELECT value FROM index_identity WHERE id=1").get() as { value: string }
    ).value;
    this.db.run(
      "CREATE TABLE IF NOT EXISTS runs (key TEXT PRIMARY KEY, modified REAL, fingerprint TEXT, data TEXT)",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS runs_modified ON runs(modified DESC)");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS run_summaries (key TEXT PRIMARY KEY, modified REAL, session_key TEXT, data TEXT)",
    );
    this.db.run("CREATE INDEX IF NOT EXISTS summaries_modified ON run_summaries(modified DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS summaries_session ON run_summaries(session_key)");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS run_artifacts (key TEXT PRIMARY KEY, stamp TEXT, modified REAL)",
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS run_locations (key TEXT PRIMARY KEY, root TEXT,
      project TEXT, session TEXT, id TEXT, sessionDir TEXT, dir TEXT, finalPath TEXT, modified REAL)`);
    this.db.run("CREATE TABLE IF NOT EXISTS observer_meta (key TEXT PRIMARY KEY, value INTEGER)");
    this.db.run("INSERT OR IGNORE INTO observer_meta VALUES ('evidenceGeneration',0)");
    this.evidenceGeneration = (
      this.db.query("SELECT value FROM observer_meta WHERE key='evidenceGeneration'").get() as {
        value: number;
      }
    ).value;
    this.transcripts = new Transcripts(this.db);
    this.sessions = new Sessions(this.db, this.transcripts, catalog);
    // Migrate only identities; do not hydrate full historical run payloads.
    for (const row of this.db
      .query(`SELECT key, modified, json_extract(data,'$.id') AS id,
      json_extract(data,'$.sessionInfo.transcript') AS parent FROM run_summaries
      WHERE key NOT IN (SELECT key FROM run_locations)`)
      .all() as RecordData[]) {
      if (!row.parent) continue;
      const sessionDir = row.parent.slice(0, -6);
      this.rememberLocation(
        {
          root: dirname(dirname(dirname(row.parent))),
          project: basename(dirname(row.parent)),
          session: basename(sessionDir),
          id: row.id,
          sessionDir,
          dir: join(sessionDir, "subagents", "workflows", row.id),
          finalPath: join(sessionDir, "workflows", row.id + ".json"),
        },
        row.key,
        row.modified,
      );
    }
  }
  get scan() {
    return Effect.suspend(() =>
      this.scanWith({
        roots: [...this.roots],
        catalog: this.catalog.snapshot(),
        windows: this.windows.active(),
        now: Date.now(),
      }),
    );
  }
  scanWith(inputs: ScanInputs): Effect.Effect<ScanOutcome, unknown> {
    return Effect.gen(this, function* () {
      if (this.scanning) return yield* Effect.fail(new Error("A scan is already running"));
      this.scanning = true;
      this.errors = [];
      const { windows, roots, catalog, now } = inputs;
      const since = cutoffFor(Math.max(...windows) as WindowDays, now);
      const windowErrors = new Map(windows.map((days) => [days, [] as string[]]));
      const report = (issues: string[], modified = Infinity) => {
        for (const days of windows)
          if (modified >= cutoffFor(days, now)) windowErrors.get(days)!.push(...issues);
      };
      return yield* Effect.gen(this, function* () {
        yield* this.invalidateUnavailableEffect;
        const descriptors: RecordData[] = [];
        const discovered = new Map<string, Set<string>>();
        this.sources = [];
        for (const root of roots) {
          const source = {
            path: root,
            state: "connected",
            runs: 0,
            error: undefined as string | undefined,
          };
          this.sources.push(source);
          yield* Effect.tryPromise(async () => {
            for (const project of await directories(join(root, "projects"))) {
              const projectDir = join(root, "projects", project);
              for (const session of await directories(projectDir)) {
                const sessionDir = join(projectDir, session);
                const liveDir = join(sessionDir, "subagents", "workflows");
                const finalDir = join(sessionDir, "workflows");
                const live = await directories(liveDir).catch(() => []);
                const final = (await readdir(finalDir).catch(() => []))
                  .filter((n) => n.startsWith("wf_") && n.endsWith(".json"))
                  .map((n) => n.slice(0, -5));
                for (const id of new Set([...live.filter((n) => n.startsWith("wf_")), ...final])) {
                  const d = {
                    root,
                    project,
                    session,
                    id,
                    sessionDir,
                    dir: join(liveDir, id),
                    finalPath: join(finalDir, id + ".json"),
                  };
                  const sessionKey = runKey(root, project, session, "session");
                  const ids = discovered.get(sessionKey) ?? new Set<string>();
                  ids.add(runKey(root, project, session, id));
                  discovered.set(sessionKey, ids);
                  if (await this.recentArtifact(d, since)) {
                    descriptors.push(d);
                    source.runs++;
                  }
                }
              }
            }
          }).pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                source.state = "unavailable";
                source.error = String(e);
              }),
            ),
          );
        }
        // Recheck known recent runs even when an entire folder or profile disappears.
        const selected = new Set(
          descriptors.map((d) => runKey(d.root, d.project, d.session, d.id)),
        );
        for (const d of this.db
          .query("SELECT * FROM run_locations WHERE modified>=?")
          .all(since) as RecordData[])
          if (roots.includes(d.root) && !selected.has(d.key)) descriptors.push(d);
        const currentKeys = new Set(
          descriptors.map((d) => runKey(d.root, d.project, d.session, d.id)),
        );
        yield* Effect.forEach(
          descriptors,
          (d) =>
            Effect.tryPromise({
              try: () => this.readRun(d, catalog),
              catch: (e) => new IndexError({ path: d.dir, message: String(e) }),
            }).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => {
                  this.errors.push(`${e.path}: ${e.message}`);
                  report([`${e.path}: ${e.message}`], d.artifactModified || d.modified || Infinity);
                }),
              ),
            ),
          { concurrency: 2, discard: true },
        );
        // Frozen history: only known run identities inside the requested window.
        const retained = (
          this.db.query("SELECT * FROM run_locations WHERE modified>=?").all(since) as RecordData[]
        ).filter((d) => !roots.includes(d.root));
        const retainedKeys = new Set(retained.map((d) => d.key));
        for (const d of retained) {
          yield* Effect.tryPromise(() => this.repriceRetained(d, catalog)).pipe(
            Effect.tap((issues) =>
              Effect.sync(() => {
                report(issues, d.modified);
              }),
            ),
            Effect.catchAll((e) =>
              Effect.sync(() => {
                this.errors.push(`Retained run ${d.id}: ${String(e)}`);
                report([`Retained run ${d.id}: ${String(e)}`], d.modified);
              }),
            ),
          );
        }
        for (const days of windows) {
          const cutoff = cutoffFor(days, now);
          const groups = new Map<string, SessionRun[]>();
          for (const run of this.summaries(cutoff)) {
            if (!run.sessionInfo || (!currentKeys.has(run.key) && !retainedKeys.has(run.key)))
              continue;
            const group = groups.get(run.sessionInfo.key) ?? [];
            group.push(run);
            groups.set(run.sessionInfo.key, group);
          }
          yield* Effect.forEach(
            [...groups.entries()],
            ([key, runs]) =>
              Effect.tryPromise(() => {
                const known = this.db
                  .query("SELECT key FROM run_summaries WHERE session_key=?")
                  .all(key) as { key: string }[];
                const all = new Set([...(discovered.get(key) ?? []), ...known.map((r) => r.key)]);
                const excluded = [...all].filter((key) => !runs.some((r) => r.key === key)).length;
                return this.sessions.refresh(
                  runs,
                  days,
                  cutoff,
                  excluded,
                  catalog,
                  retainedKeys.has(runs[0].key),
                );
              }).pipe(
                Effect.tap((issues) =>
                  Effect.sync(() => {
                    windowErrors.get(days)!.push(...issues);
                  }),
                ),
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    this.errors.push(`Session ${runs[0].session}: ${String(e)}`);
                    windowErrors.get(days)!.push(`Session ${runs[0].session}: ${String(e)}`);
                  }),
                ),
              ),
            { concurrency: 2, discard: true },
          );
          this.updatedWindows.set(days, Date.now());
        }
        const generation = this.evidenceGeneration;
        yield* this.invalidateUnavailableEffect;
        if (generation !== this.evidenceGeneration)
          report([
            "Evidence changed during this pass; affected estimates were cleared and need another update.",
          ]);
        this.lastScan = Math.max(Date.now(), this.lastScan + 1);
        report(this.sources.filter((s) => s.error).map((s) => `${s.path}: ${s.error}`));
        const results = Object.fromEntries(
          [...windowErrors].map(([days, errors]) => [
            days,
            {
              state: errors.length ? ("partial" as const) : ("complete" as const),
              errors: [...new Set(errors)],
            },
          ]),
        );
        const errors = [...new Set([...windowErrors.values()].flat())];
        return {
          state: errors.length ? ("partial" as const) : ("complete" as const),
          windows,
          errors,
          results,
          finishedAt: this.lastScan,
        };
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.scanning = false;
          }),
        ),
      );
    });
  }
  private async recentArtifact(d: RecordData, since: number) {
    const files = (await readdir(d.dir).catch(() => [] as string[])).filter(
      (name) => name === "journal.jsonl" || /^agent-.+\.(jsonl|meta\.json)$/.test(name),
    );
    const entries = await Promise.all(
      [...files.map((f) => join(d.dir, f)), d.finalPath].map(async (path) => {
        const info = await stat(path).catch(() => null);
        return { path, info };
      }),
    );
    const stamp = JSON.stringify(
      entries.map(({ path, info }) => [path, info?.ino, info?.size, info?.mtimeMs]),
    );
    const key = runKey(d.root, d.project, d.session, d.id);
    const known = this.db
      .query("SELECT stamp, modified FROM run_artifacts WHERE key=?")
      .get(key) as { stamp: string; modified: number } | null;
    d.artifactStamp = stamp;
    d.artifactModified = Math.max(0, ...entries.map((e) => e.info?.mtimeMs ?? 0));
    // Directory mtimes alone miss appends to existing agent files in resumed runs.
    return known?.stamp === stamp ? known.modified >= since : d.artifactModified >= since;
  }
  async readRun(d: RecordData, catalog = this.catalog.snapshot()) {
    const key = runKey(d.root, d.project, d.session, d.id);
    const previous = this.get(key);
    const files: string[] = await readdir(d.dir).catch(() => [] as string[]);
    const parentPath = d.sessionDir + ".jsonl";
    const parentEvidence = await Effect.runPromise(
      this.transcripts.readCurrent({ kind: "parent", path: parentPath, session: d.session }),
    );
    const parent = parentEvidence.data;
    const title = parent?.title ?? { name: null, nameSource: null };
    const invocation = { ...parent?.runs?.[d.id] };
    const hasFinal = await exists(d.finalPath);
    const warnings: string[] = [];
    if (!parent)
      warnings.push("Parent transcript unavailable. Cached content deleted; usage excluded.");
    let final: RecordData = {};
    if (hasFinal)
      try {
        final = await json(d.finalPath);
      } catch {
        warnings.push("Final record is unreadable; showing recorded agent evidence.");
      }
    // Resolve the same source path for freshness checks and plan analysis.
    let sourcePath = final.scriptPath || invocation.scriptPath || "";
    if (!sourcePath) {
      const scripts = await readdir(join(d.sessionDir, "workflows", "scripts")).catch(() => []);
      const match = scripts.find((n) => n.endsWith(`${d.id}.js`));
      if (match) sourcePath = join(d.sessionDir, "workflows", "scripts", match);
    }
    if (sourcePath) sourcePath = resolve(invocation.cwd || parent?.cwd || d.root, sourcePath);
    const stamps = await Promise.all(
      [
        ...files.map((n) => join(d.dir, n)),
        ...(hasFinal ? [d.finalPath] : []),
        ...(sourcePath ? [sourcePath] : []),
      ].map((p) =>
        stat(p).then(
          (s) => `${p}:${s.ino}:${s.size}:${s.mtimeMs}`,
          () => p,
        ),
      ),
    );
    const fingerprint = JSON.stringify([
      "observer-index-v14",
      PRICING_REVISION,
      title,
      parentEvidence.stamp,
      this.evidenceGeneration,
      stamps,
      invocation,
      catalog.fingerprint,
      final.status ? 0 : Math.floor(Date.now() / 60000),
    ]);
    const old = this.db
      .query("SELECT fingerprint FROM runs WHERE key=?")
      .get(key) as RecordData | null;
    if (old?.fingerprint === fingerprint) {
      const row = this.db.query("SELECT modified FROM runs WHERE key=?").get(key) as {
        modified: number;
      };
      this.rememberArtifact(d, key, row.modified);
      return;
    }
    const journalEvidence = await Effect.runPromise(
      this.transcripts.readCurrent({ kind: "journal", path: join(d.dir, "journal.jsonl") }),
    );
    const journal = journalEvidence.data ?? { entries: [] };
    const progress = (final.workflowProgress ?? []).filter(
      (p: RecordData) => p.type === "workflow_agent",
    );
    const ids = new Set<string>([
      ...files.filter((n) => /^agent-.+\.jsonl$/.test(n)).map((n) => n.slice(6, -6)),
      ...progress.map((p: RecordData) => p.agentId).filter(Boolean),
      ...journal.entries.map((e: RecordData) => e.agentId).filter(Boolean),
      ...(previous?.agents.map((a) => a.id) ?? []),
    ]);
    const agents: Agent[] = [];
    for (const id of ids) {
      const metaPath = join(d.dir, `agent-${id}.meta.json`);
      const transcript = join(d.dir, `agent-${id}.jsonl`);
      let meta: RecordData = {};
      if (await exists(metaPath))
        try {
          meta = await json(metaPath);
        } catch {
          warnings.push(`Unreadable metadata for ${id}`);
        }
      const p = progress.find((p: RecordData) => p.agentId === id) ?? {};
      const started =
        journal.entries.find((e: RecordData) => e.type === "started" && e.agentId === id) ?? {};
      const result = journal.entries.findLast(
        (e: RecordData) => e.type === "result" && e.agentId === id,
      );
      const evidence = await Effect.runPromise(
        this.transcripts.readCurrent({ kind: "agent", path: transcript }),
      );
      const raw = evidence.data;
      const prior = previous?.agents.find((a) => a.id === id);
      const usage = summarizeUsage(raw?.messages ?? {}, catalog);
      const modified = raw?.modified || p.lastProgressAt || prior?.modified || 0;
      const state = agentState({
        progress: p,
        journal: journal.entries.filter((e: RecordData) => e.agentId === id),
        transcript: raw,
        modified,
        finalState: final.status ? stateOf(final.status) : null,
        now: Date.now(),
      });
      const label = meta.description || started.label || p.label || prior?.label || id;
      const phase =
        meta.workflowPhase || started.phase || p.phaseTitle || prior?.phase || "Unassigned";
      agents.push({
        id,
        label,
        phase,
        model: meta.model || p.model || prior?.model || "Not recorded",
        availability: evidence.status,
        models: usage.groups.map((g) => g.model),
        state,
        started: raw?.started || p.startedAt || prior?.started || 0,
        modified,
        duration:
          p.durationMs ??
          (raw?.started ? Math.max(0, modified - raw.started) : (prior?.duration ?? 0)),
        usage,
        task: raw ? raw.task || p.promptPreview || "" : "",
        result: raw ? (result?.result ?? p.resultPreview ?? null) : null,
        latestText: raw?.latestText ?? "",
        events: (raw?.events ?? []).map((e: RecordData) => ({
          ...e,
          agent: label,
          inputText: e.detail,
          outputText: e.output,
          detail: e.detail + (e.output ? "\n\nRESULT\n" + e.output : ""),
        })),
        toolCount: raw ? raw.toolCount || p.toolCalls || 0 : 0,
        transcript,
        metadataSource: meta.description
          ? "agent metadata"
          : started.label
            ? "workflow journal"
            : p.label
              ? "final workflow progress"
              : "agent ID (label missing)",
        reportedTokens: raw ? (p.tokens ?? null) : null,
        warnings: [
          ...(!raw
            ? [
                "Transcript unavailable. Cached content deleted; usage excluded from current estimates.",
              ]
            : []),
          ...(raw?.parseErrors
            ? [`${raw.parseErrors} malformed or oversized transcript lines skipped`]
            : []),
          ...(!usage.requests ? ["No recorded request usage available."] : []),
        ],
      });
    }
    let source =
      typeof final.script === "string"
        ? final.script
        : typeof invocation.script === "string"
          ? invocation.script
          : "";
    const cwd = invocation.cwd || parent?.cwd || previous?.cwd || "";
    let sourceNote = source ? "Recorded inline workflow source." : "";
    let plan: RecordData = {};
    if (!source && sourcePath) {
      try {
        const actual = await realpath(sourcePath);
        const info = await stat(actual);
        if (!info.isFile()) throw new Error("workflow source is not a regular file");
        if (info.size > 2 * 1024 * 1024) throw new Error("source exceeds 2 MB");
        source = await readFile(actual, "utf8");
        sourceNote =
          "Current source file, statically analyzed. It may have changed since this run.";
      } catch (e) {
        sourceNote = `Source unavailable: ${String(e)}`;
      }
    }
    if (source)
      try {
        plan = analyzePlan(
          source,
          invocation.args ?? final.args,
          typeof final.defaultModel === "string" ? final.defaultModel : undefined,
        );
        if (invocation.args !== undefined || final.args !== undefined)
          sourceNote += " Planned metadata uses recorded invocation arguments.";
        if (!final.summary && !invocation.summary) invocation.summary = plan.meta?.description;
      } catch {
        warnings.push(
          "Source could not be statically analyzed. Recorded phases are still available.",
        );
      }
    const phases = mergePhases(final.phases ?? [], plan);
    for (const a of agents)
      if (!phases.some((p: RecordData) => p.title === a.phase))
        phases.push({ title: a.phase, detail: "Recorded at runtime" });
    const modified =
      Math.max(0, ...agents.map((a) => a.modified), Date.parse(final.timestamp) || 0) ||
      d.artifactModified ||
      previous?.modified ||
      0;
    const start =
      final.startTime ||
      invocation.time ||
      Math.min(...agents.map((a) => a.started).filter(Boolean)) ||
      0;
    const status = workflowStatus(final.status, final.result, agents);
    const worktree = cwd.match(/\/.t3\/worktrees\/([^/]+)/)?.[1];
    const project = worktree || basename(cwd) || "Unresolved project";
    const missingUsage = agents.filter((a) => !a.usage.requests).length;
    if (missingUsage)
      warnings.push(
        `${missingUsage} agents have no per-request usage. Token totals and costs cover only recorded requests.`,
      );
    const run: Run = {
      key,
      id: d.id,
      profile: basename(d.root),
      project,
      cwd,
      session: d.session,
      sessionInfo: {
        key: runKey(d.root, d.project, d.session, "session"),
        ...title,
        transcript: parentPath,
      },
      name: final.workflowName || plan.name || (hasFinal ? d.id : previous?.name || d.id),
      summary: final.summary || invocation.summary || "",
      ...status,
      started: Number.isFinite(start) ? start : 0,
      modified,
      duration: final.durationMs ?? (Number.isFinite(start) ? Math.max(0, modified - start) : 0),
      agents: agents.sort((a, b) => a.started - b.started),
      phases,
      usage: combineUsage(agents.map((a) => a.usage)),
      pricingAsOf: catalog.updated,
      sourcePath,
      source:
        source.length > 180000
          ? source.slice(0, 180000) +
            "\n[Preview truncated; full content remains in the source file.]"
          : source,
      sourceNote,
      result: final.result ?? null,
      warnings,
      indexed: Date.now(),
      finalPath: hasFinal ? d.finalPath : "",
      reportedTokens: final.totalTokens ?? null,
    };
    this.db
      .query("INSERT OR REPLACE INTO runs VALUES (?,?,?,?)")
      .run(key, modified, fingerprint, JSON.stringify(run));
    this.remember(run);
    this.rememberArtifact(d, key, modified);
    this.rememberLocation(d, key, modified);
  }
  private async repriceRetained(d: RecordData, catalog: Catalog) {
    const previous = this.get(d.key);
    if (!previous) return ["No retained workflow snapshot for " + d.id];
    const refs = [
      { kind: "parent" as const, path: d.sessionDir + ".jsonl", session: d.session },
      { kind: "journal" as const, path: join(d.dir, "journal.jsonl") },
      ...previous.agents.map((a) => ({ kind: "agent" as const, path: a.transcript })),
    ];
    const evidence = await Promise.all(
      refs.map((ref) => Effect.runPromise(this.transcripts.readRetained(ref))),
    );
    const revoked = await Effect.runPromise(this.invalidateUnavailableEffect);
    for (const item of evidence)
      if (revoked.has(item.ref.path)) {
        const inspection = await Effect.runPromise(this.transcripts.inspect(item.ref));
        Object.assign(item, inspection, {
          data: null,
          retained: "absent",
          reason: inspection.reason ?? "Retained evidence was invalidated during this update",
        });
      }
    const run = this.get(d.key)!;
    const execution =
      run.executionState === undefined
        ? run.finalPath
          ? run.state
          : undefined
        : run.executionState;
    const issues: string[] = [];
    run.agents = run.agents.map((a) => {
      const item = evidence.find((e) => e.ref.path === a.transcript)!;
      const usage = summarizeUsage(item.data?.messages ?? {}, catalog);
      const warning = item.data
        ? null
        : `${a.label}: ${item.reason ?? "No compatible retained evidence"}. Usage excluded.`;
      if (warning) issues.push(warning);
      const journal = (evidence[1].data?.entries ?? []).filter(
        (e: RecordData) => e.agentId === a.id,
      );
      return {
        ...a,
        state:
          run.executionState === undefined && (journal.length || item.data?.runtimeState)
            ? agentState({
                progress: ["failed", "interrupted"].includes(a.state) ? { state: a.state } : {},
                journal,
                transcript: item.data,
                modified: a.modified,
                finalState: execution ? stateOf(execution) : null,
                now: Date.now(),
              })
            : a.state,
        availability: item.status,
        usage,
        models: usage.groups.map((g) => g.model),
        warnings: [
          ...a.warnings.filter((w) => !w.startsWith("Retained evidence:")),
          ...(warning ? ["Retained evidence: " + warning] : []),
        ],
      };
    });
    const parent = evidence[0];
    if (!parent.data) {
      issues.push(`Parent: ${parent.reason ?? "No compatible retained evidence"}. Usage excluded.`);
      if (run.sessionInfo) {
        run.sessionInfo.name = null;
        run.sessionInfo.nameSource = null;
      }
    }
    run.usage = combineUsage(run.agents.map((a) => a.usage));
    Object.assign(run, workflowStatus(execution, run.result, run.agents));
    run.pricingAsOf = catalog.updated;
    run.warnings = [
      ...run.warnings.filter((w) => !w.startsWith("Unwatched history:")),
      "Unwatched history: estimates use previously indexed requests only.",
      ...issues.map((w) => "Unwatched history: " + w),
    ];
    const fingerprint = JSON.stringify([
      "retained-v2",
      PRICING_REVISION,
      catalog.fingerprint,
      evidence.map((e) => e.stamp),
    ]);
    const old = this.db.query("SELECT fingerprint FROM runs WHERE key=?").get(run.key) as {
      fingerprint: string;
    };
    if (old.fingerprint !== fingerprint) {
      run.indexed = Math.max(Date.now(), run.indexed + 1);
      this.db
        .query("UPDATE runs SET fingerprint=?,data=? WHERE key=?")
        .run(fingerprint, JSON.stringify(run), run.key);
      this.remember(run);
    }
    return issues;
  }
  private rememberLocation(d: RecordData, key: string, modified: number) {
    this.db
      .query("INSERT OR REPLACE INTO run_locations VALUES (?,?,?,?,?,?,?,?,?)")
      .run(key, d.root, d.project, d.session, d.id, d.sessionDir, d.dir, d.finalPath, modified);
  }
  private invalidateUnavailableEffect = Effect.tryPromise(async () => {
    const { generation, sources } = await Effect.runPromise(this.transcripts.inspect());
    if (generation === this.evidenceGeneration) return new Set<string>();
    const missing = new Set(
      sources
        .filter((s) => (s.invalidatedAt ?? 0) > this.evidenceGeneration)
        .map((s) => s.ref.path),
    );
    const affectedSessions = new Set<string>();
    for (const location of this.db.query("SELECT * FROM run_locations").all() as RecordData[]) {
      const parent = location.sessionDir + ".jsonl";
      if (!missing.has(parent) && ![...missing].some((p) => p.startsWith(location.dir + "/")))
        continue;
      const run = this.get(location.key);
      if (!run) continue;
      // Immediately evict derived content, including snapshots outside the active window.
      // Current scans reconstruct available evidence; identities remain navigable.
      run.agents = run.agents.map((a) => ({
        ...a,
        task: "",
        result: null,
        latestText: "",
        events: [],
        toolCount: 0,
        reportedTokens: null,
        models: [],
        usage: emptyUsage(),
        availability: missing.has(a.transcript)
          ? sources.find((s) => s.ref.path === a.transcript)!.status
          : a.availability,
        warnings: [
          "Evidence invalidated after a transcript became unavailable; current sources will be rechecked.",
        ],
      }));
      run.usage = emptyUsage();
      run.phases = [];
      run.summary = "";
      run.source = "";
      run.sourceNote = "Cached source cleared after a transcript became unavailable.";
      run.result = null;
      run.outcome = null;
      run.reportedTokens = null;
      if (missing.has(parent) && run.sessionInfo) {
        run.sessionInfo.name = null;
        run.sessionInfo.nameSource = null;
      }
      run.warnings = [
        "Transcript unavailable or retained evidence incompatible. Cached evidence deleted; usage excluded until sources are rechecked.",
      ];
      run.indexed = Math.max(Date.now(), run.indexed + 1);
      this.db
        .query("UPDATE runs SET fingerprint='',data=? WHERE key=?")
        .run(JSON.stringify(run), run.key);
      this.remember(run);
      if (run.sessionInfo) affectedSessions.add(run.sessionInfo.key);
    }
    for (const row of this.db.query("SELECT key,files FROM session_windows").all() as {
      key: string;
      files: string;
    }[])
      if ((JSON.parse(row.files) as string[]).some((p) => missing.has(p)))
        affectedSessions.add(row.key);
    for (const key of affectedSessions) {
      for (const row of this.db
        .query("SELECT days,data FROM session_windows WHERE key=?")
        .all(key) as { days: number; data: string }[]) {
        const summary = JSON.parse(row.data);
        summary.usage = emptyUsage();
        summary.parentUsage = emptyUsage();
        summary.workflowUsage = emptyUsage();
        summary.otherUsage = emptyUsage();
        if (missing.has(summary.transcript)) {
          summary.name = null;
          summary.nameSource = null;
        }
        summary.warnings = [
          "Transcript unavailable. Cached usage excluded until current sources are rechecked.",
        ];
        summary.indexed = Date.now();
        this.db
          .query("UPDATE session_windows SET fingerprint='',data=? WHERE key=? AND days=?")
          .run(JSON.stringify(summary), key, row.days);
      }
    }
    this.evidenceGeneration = generation;
    this.db
      .query("UPDATE observer_meta SET value=? WHERE key='evidenceGeneration'")
      .run(generation);
    return missing;
  });
  private rememberArtifact(d: RecordData, key: string, modified: number) {
    if (d.artifactStamp)
      this.db
        .query("INSERT OR REPLACE INTO run_artifacts VALUES (?,?,?)")
        .run(key, d.artifactStamp, modified);
  }
  private remember(r: Run) {
    const { agents, source: _source, result: _result, ...summary } = r;
    const compact: SessionRun = {
      ...summary,
      agentCount: agents.length,
      activeAgents: agents.filter((a) => a.state === "running").length,
      transcripts: agents.map((a) => a.transcript),
    };
    this.db
      .query("INSERT OR REPLACE INTO run_summaries VALUES (?,?,?,?)")
      .run(r.key, r.modified, r.sessionInfo?.key ?? null, JSON.stringify(compact));
  }
  private summaries(since: number): SessionRun[] {
    // Migrate only matching legacy rows. No full history hydration on startup or polling.
    this.db
      .query(`INSERT OR IGNORE INTO run_summaries
      SELECT r.key, r.modified, json_extract(r.data, '$.sessionInfo.key'),
        json_set(json_remove(r.data, '$.agents', '$.source', '$.result'),
          '$.agentCount', json_array_length(r.data, '$.agents'),
          '$.activeAgents', (SELECT count(*) FROM json_each(r.data, '$.agents') WHERE json_extract(value, '$.state')='running'),
          '$.transcripts', json((SELECT json_group_array(json_extract(value, '$.transcript')) FROM json_each(r.data, '$.agents'))))
      FROM runs r WHERE r.modified>=? AND NOT EXISTS (SELECT 1 FROM run_summaries s WHERE s.key=r.key)`)
      .run(since);
    return (
      this.db
        .query("SELECT data FROM run_summaries WHERE modified>=? ORDER BY modified DESC")
        .all(since) as { data: string }[]
    ).map(({ data }) => JSON.parse(data));
  }
  list(days: WindowDays = DEFAULT_WINDOW, now = Date.now()): RunSummary[] {
    return this.summaries(cutoffFor(days, now)).map(({ transcripts: _transcripts, ...run }) => run);
  }
  get(key: string, since = 0): Run | null {
    const row = this.db
      .query("SELECT data FROM runs WHERE key=? AND modified>=?")
      .get(key, since) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }
}
