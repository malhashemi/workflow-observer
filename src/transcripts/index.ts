import { open, stat } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { RecordData } from "../types";
import {
  initialAgent,
  reduceAgent,
  initialParent,
  parentReducer,
  parentTitle,
  AGENT_STATUS_REVISION,
} from "./reducers";

export type TranscriptRef =
  | { kind: "parent"; path: string; session: string }
  | { kind: "agent" | "journal"; path: string };
export type Availability = "available" | "missing" | "unreadable";
export interface Inspection {
  ref: TranscriptRef;
  status: Availability;
  modified: number;
  stamp: string;
  reason: string | null;
  invalidated: boolean;
  invalidatedAt?: number;
}
export type RetainedEvidence = Inspection & {
  data: RecordData | null;
  retained: "compatible" | "absent" | "incompatible";
};
export type CurrentEvidence = Inspection &
  ({ status: "available"; data: RecordData } | { status: "missing" | "unreadable"; data: null });
const REVISION = "transcript-evidence-v1";
const identity = (ref: TranscriptRef) =>
  JSON.stringify([REVISION, ref.kind, "session" in ref ? ref.session : null]);
const metadata = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;
const record = (value: unknown): value is RecordData =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function compatible(data: unknown, ref: TranscriptRef): data is RecordData {
  if (!record(data)) return false;
  if (ref.kind === "journal") return Array.isArray(data.entries);
  if (!record(data.messages) || !Object.values(data.messages).every(record)) return false;
  return ref.kind === "parent"
    ? data.session === ref.session && record(data.calls) && record(data.runs) && record(data.title)
    : Array.isArray(data.events) && record(data.toolIds) && typeof data.toolCount === "number";
}

/** The only transcript seam: inspect metadata (or all known refs), and read current evidence.
 * Filesystem failures are data; database failures fail the Effect. No retained-content fallback.
 */
export class Transcripts {
  private pending = new Map<string, Promise<unknown>>();
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS transcript_evidence (
      path TEXT PRIMARY KEY, kind TEXT, session TEXT, status TEXT, modified REAL,
      stamp TEXT, identity TEXT, inode TEXT, size INTEGER, offset INTEGER, dropping INTEGER, state TEXT)`);
    db.run(
      "CREATE TABLE IF NOT EXISTS transcript_clock (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER)",
    );
    db.run("INSERT OR IGNORE INTO transcript_clock VALUES (1,0)");
    db.run(
      "CREATE TABLE IF NOT EXISTS transcript_invalidations (path TEXT PRIMARY KEY, generation INTEGER)",
    );
    // Legacy payloads lack the new identity/availability contract. Retain only refs, then
    // reparse available files on demand. This migration never hydrates transcript bodies.
    if (db.query("SELECT name FROM sqlite_master WHERE name='files'").get()) {
      db.transaction(() => {
        for (const { path, modified } of db.query("SELECT path,modified FROM files").all() as {
          path: string;
          modified: number;
        }[]) {
          const name = basename(path);
          const kind =
            name === "journal.jsonl" ? "journal" : name.startsWith("agent-") ? "agent" : "parent";
          db.query(
            "INSERT OR IGNORE INTO transcript_evidence (path,kind,session,status,modified) VALUES (?,?,?,'unknown',?)",
          ).run(path, kind, kind === "parent" ? name.slice(0, -6) : null, modified);
        }
        db.run("DROP TABLE files");
      })();
    }
  }
  inspect(): Effect.Effect<{ generation: number; sources: Inspection[] }, unknown>;
  inspect(ref: TranscriptRef): Effect.Effect<Inspection, unknown>;
  inspect(
    ref?: TranscriptRef,
  ): Effect.Effect<Inspection | { generation: number; sources: Inspection[] }, unknown> {
    return Effect.tryPromise(async () => {
      if (ref) return this.serial(ref.path, () => this.probe(ref));
      const refs = this.db
        .query("SELECT path,kind,session FROM transcript_evidence")
        .all() as TranscriptRef[];
      const results: Inspection[] = [];
      for (const item of refs) results.push(await this.serial(item.path, () => this.probe(item)));
      return {
        generation: (
          this.db.query("SELECT generation FROM transcript_clock WHERE id=1").get() as {
            generation: number;
          }
        ).generation,
        sources: results.map((item) => ({
          ...item,
          invalidatedAt:
            (
              this.db
                .query("SELECT generation FROM transcript_invalidations WHERE path=?")
                .get(item.ref.path) as { generation: number } | null
            )?.generation ?? 0,
        })),
      };
    });
  }
  readRetained(ref: TranscriptRef): Effect.Effect<RetainedEvidence, unknown> {
    return Effect.tryPromise(() =>
      this.serial(ref.path, async () => {
        const check = await this.probe(ref);
        if (check.status !== "available")
          return { ...check, data: null, retained: "absent" as const };
        const old = this.db
          .query("SELECT * FROM transcript_evidence WHERE path=?")
          .get(ref.path) as RecordData;
        let data: RecordData | null = null;
        try {
          data = old.state ? JSON.parse(old.state) : null;
        } catch {
          /* Reject a damaged cache. */
        }
        // Same metadata or ordinary append: never read bytes or advance the saved cursor.
        // Like incremental reading, this cannot detect an in-place rewrite followed by growth.
        let sourceCompatible = false;
        try {
          const file = await open(ref.path, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const info = await file.stat();
            const current = await stat(ref.path);
            if (
              !info.isFile() ||
              current.dev !== info.dev ||
              current.ino !== info.ino ||
              current.size < info.size
            )
              throw new Error("Transcript changed during inspection");
            sourceCompatible =
              old.stamp === `${identity(ref)}:${metadata(info)}` ||
              (old.inode === `${info.dev}:${info.ino}` && info.size > old.size);
          } finally {
            await file.close();
          }
        } catch (error) {
          return { ...this.unavailable(ref, error), data: null, retained: "absent" as const };
        }
        if (
          old.identity === identity(ref) &&
          compatible(data, ref) &&
          Number.isSafeInteger(old.size) &&
          old.size >= 0 &&
          Number.isSafeInteger(old.offset) &&
          old.offset >= 0 &&
          old.offset <= old.size &&
          sourceCompatible
        )
          return {
            ...check,
            stamp: old.stamp,
            modified: old.modified,
            data,
            retained: "compatible" as const,
          };
        const invalidated = this.reject(ref) || check.invalidated;
        const retained =
          old.state || check.invalidated ? ("incompatible" as const) : ("absent" as const);
        return {
          ...check,
          modified: old.modified,
          data: null,
          invalidated,
          retained,
          stamp: `${identity(ref)}:no-compatible-evidence`,
          reason:
            "No compatible retained evidence. Usage excluded; rewatch this profile to rebuild.",
        };
      }),
    );
  }
  readCurrent(ref: TranscriptRef): Effect.Effect<CurrentEvidence, unknown> {
    return Effect.tryPromise(() =>
      this.serial(ref.path, async (): Promise<CurrentEvidence> => {
        const check = await this.probe(ref);
        if (check.status !== "available") return { ...check, status: check.status, data: null };
        const old = this.db
          .query("SELECT * FROM transcript_evidence WHERE path=?")
          .get(ref.path) as RecordData;
        let saved: RecordData | null = null;
        try {
          const parsed = old.state ? JSON.parse(old.state) : null;
          if (
            compatible(parsed, ref) &&
            Number.isSafeInteger(old.offset) &&
            old.offset >= 0 &&
            old.offset <= old.size
          )
            saved = parsed;
        } catch {
          /* Reparse a damaged cache. */
        }
        // Usage parsing is unchanged, so older saved requests remain compatible for
        // frozen repricing. Current reads reparse once to populate runtime status.
        const sameIdentity =
          old.identity === identity(ref) &&
          (ref.kind !== "agent" || saved?.statusRevision === AGENT_STATUS_REVISION);
        if (saved && sameIdentity && old.stamp === check.stamp)
          return { ...check, status: "available", data: saved };
        let payload: { data: RecordData; offset: number; dropping: boolean; info: Stats };
        try {
          const file = await open(ref.path, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const info = await file.stat();
            if (!info.isFile()) throw new Error("Not a regular file");
            const inode = `${info.dev}:${info.ino}`;
            const append = saved && sameIdentity && old.inode === inode && info.size > old.size;
            const data: RecordData = append
              ? saved!
              : ref.kind === "parent"
                ? initialParent(ref.session)
                : ref.kind === "agent"
                  ? initialAgent()
                  : { entries: [] };
            let offset = append ? old.offset : 0;
            let dropping = append ? !!old.dropping : false;
            let pending = Buffer.alloc(0);
            let position = offset;
            while (position < info.size) {
              const buffer = Buffer.alloc(Math.min(256 * 1024, info.size - position));
              const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
              if (!bytesRead) throw new Error("Transcript changed during reading");
              position += bytesRead;
              pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
              let end: number;
              while ((end = pending.indexOf(10)) >= 0) {
                const line = pending.subarray(0, end);
                offset += end + 1;
                pending = pending.subarray(end + 1);
                if (dropping) {
                  dropping = false;
                  continue;
                }
                if (!line.length) continue;
                try {
                  const row = JSON.parse(line.toString("utf8"));
                  if (row && typeof row === "object") {
                    if (ref.kind === "parent") parentReducer(data, row);
                    else if (ref.kind === "agent") reduceAgent(data, row);
                    else data.entries.push(row);
                  }
                } catch {
                  data.parseErrors = (data.parseErrors ?? 0) + 1;
                }
              }
              if (pending.length > 8 * 1024 * 1024) {
                offset += pending.length;
                pending = Buffer.alloc(0);
                if (!dropping) data.parseErrors = (data.parseErrors ?? 0) + 1;
                dropping = true;
              }
            }
            const current = await stat(ref.path);
            if (current.dev !== info.dev || current.ino !== info.ino || current.size < info.size)
              throw new Error("Transcript changed during reading");
            if (ref.kind === "parent") data.title = parentTitle(data);
            payload = { data, offset, dropping, info };
          } finally {
            await file.close();
          }
        } catch (error) {
          return { ...this.unavailable(ref, error), data: null };
        }
        const { data, info, offset, dropping } = payload;
        const stamp = `${identity(ref)}:${metadata(info)}`;
        this.db
          .query(`UPDATE transcript_evidence SET status='available', modified=?, stamp=?, identity=?,
        inode=?, size=?, offset=?, dropping=?, state=? WHERE path=?`)
          .run(
            info.mtimeMs,
            stamp,
            identity(ref),
            `${info.dev}:${info.ino}`,
            info.size,
            offset,
            Number(dropping),
            JSON.stringify(data),
            ref.path,
          );
        return { ...check, status: "available", modified: info.mtimeMs, stamp, data };
      }),
    );
  }
  private reject(ref: TranscriptRef) {
    const old = this.db
      .query("SELECT identity FROM transcript_evidence WHERE path=?")
      .get(ref.path) as { identity: string } | null;
    if (old?.identity === "retained:rejected") return false;
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE transcript_evidence SET state=NULL,offset=NULL,dropping=NULL,identity='retained:rejected',stamp=NULL,inode=NULL,size=NULL WHERE path=?",
        )
        .run(ref.path);
      this.invalidate(ref.path);
    })();
    return true;
  }
  private invalidate(path: string) {
    this.db.run("UPDATE transcript_clock SET generation=generation+1 WHERE id=1");
    this.db
      .query(
        "INSERT OR REPLACE INTO transcript_invalidations SELECT ?,generation FROM transcript_clock WHERE id=1",
      )
      .run(path);
  }
  private serial<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(path, next);
    void next
      .finally(() => {
        if (this.pending.get(path) === next) this.pending.delete(path);
      })
      .catch(() => {});
    return next;
  }
  private async probe(ref: TranscriptRef): Promise<Inspection> {
    let info: Stats;
    try {
      info = await stat(ref.path);
      if (!info.isFile()) throw new Error("Not a regular file");
      // Opening verifies readability even when metadata is unchanged; no body is read.
      const file = await open(ref.path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        info = await file.stat();
        const current = await stat(ref.path);
        if (!info.isFile() || current.dev !== info.dev || current.ino !== info.ino)
          throw new Error("Transcript changed during inspection");
      } finally {
        await file.close();
      }
    } catch (error) {
      return this.unavailable(ref, error);
    }
    const old = this.db
      .query(
        "SELECT identity,inode,size,stamp,state IS NOT NULL AS cached FROM transcript_evidence WHERE path=?",
      )
      .get(ref.path) as RecordData | null;
    const compatibleMetadata =
      old?.identity === identity(ref) &&
      (old.stamp === `${identity(ref)}:${metadata(info)}` ||
        (old.inode === `${info.dev}:${info.ino}` && info.size > old.size));
    const invalidated = !!old?.cached && !compatibleMetadata && this.reject(ref);
    this.db
      .query(
        "INSERT OR IGNORE INTO transcript_evidence (path,kind,session,status,modified) VALUES (?,?,?,'available',?)",
      )
      .run(ref.path, ref.kind, "session" in ref ? ref.session : null, info.mtimeMs);
    this.db
      .query("UPDATE transcript_evidence SET kind=?, session=?, status='available' WHERE path=?")
      .run(ref.kind, "session" in ref ? ref.session : null, ref.path);
    return {
      ref,
      status: "available",
      modified: info.mtimeMs,
      stamp: `${identity(ref)}:${metadata(info)}`,
      reason: null,
      invalidated,
    };
  }
  private unavailable(
    ref: TranscriptRef,
    error: unknown,
  ): Inspection & { status: "missing" | "unreadable" } {
    const code = (error as NodeJS.ErrnoException)?.code;
    const status = code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
    const old = this.db
      .query(
        "SELECT status, modified, state IS NOT NULL AS cached FROM transcript_evidence WHERE path=?",
      )
      .get(ref.path) as RecordData | null;
    const invalidated = !!old && (old.cached || !["missing", "unreadable"].includes(old.status));
    this.db.transaction(() => {
      this.db
        .query(`INSERT INTO transcript_evidence (path,kind,session,status,modified) VALUES (?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET status=excluded.status, state=NULL, offset=NULL, dropping=NULL, stamp=NULL, identity=NULL, inode=NULL, size=NULL`)
        .run(ref.path, ref.kind, "session" in ref ? ref.session : null, status, old?.modified ?? 0);
      if (invalidated) this.invalidate(ref.path);
    })();
    return {
      ref,
      status,
      modified: old?.modified ?? 0,
      stamp: `${identity(ref)}:${status}`,
      reason: status === "missing" ? "Source file is missing" : "Source file is unreadable",
      invalidated,
    };
  }
}
