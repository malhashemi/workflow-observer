import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Queue, Deferred, Schedule, Cause } from "effect";
import { defaultConfig, expandDirectory, validateConfig, type ObserverConfig } from "./config";
import { applyConfigChange } from "./config-changes";
import type { Catalog } from "./catalog";
import type { Indexer, ScanOutcome } from "./indexer";
import { PRICING_REVISION } from "./pricing-rules";
import type { WindowDays } from "./windows";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const rootsOf = (config: ObserverConfig) =>
  [...new Set(config.claudeDirectories.map((p) => resolve(expandDirectory(p))))].sort();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export class SettingsConflict extends Error {
  override name = "SettingsConflict";
}
const attempt = <T>(operation: () => Promise<T>) =>
  Effect.tryPromise({
    try: operation,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
export type SettingsSnapshot = ReturnType<Settings["getSnapshot"]>;
type Saved = { config: ObserverConfig; revision: string };
type Attempt = {
  target: string;
  state: "updating" | "complete" | "partial" | "failed";
  errors: string[];
  finishedAt: number;
};
type WindowState = { indexedTarget: string | null; completedAt: number; attempt: Attempt | null };
type Companion = { index: Indexer; catalog: Catalog; boundPort: number };

/** JSON is authoritative. This module owns cooperating writes and settings-to-index work.
 * Short-lived CLI clients only open/change; the companion starts the scoped worker. */
export class Settings {
  private changes: Promise<unknown> = Promise.resolve();
  private companion: Companion | null = null;
  private requests = Effect.runSync(Queue.sliding<void>(1));
  private catalogRequests = Effect.runSync(Queue.sliding<void>(1));
  private pending = false;
  private candidate: Catalog | null = null;
  private effective: {
    target: string;
    savedRevision: string;
    roots: string[];
    aliases: Record<string, string>;
    catalogRevision: string;
  } | null = null;
  private indexed = new Map<WindowDays, WindowState>();
  private catalogState: { state: "idle" | "queued" | "updating" | "failed"; error: string | null } =
    { state: "idle", error: null };
  private fileWarning: string | null = null;
  revision = 0;
  private sequence = 0;
  private constructor(
    readonly path: string,
    private saved: Saved,
  ) {}

  static open(path: string) {
    return attempt(async () => {
      await mkdir(dirname(resolve(expandDirectory(path))), { recursive: true, mode: 0o700 });
      // Resolve symlinks so cooperating callers share one lock and one authoritative file.
      const canonical = await realpath(resolve(expandDirectory(path))).catch(async (e) => {
        if (e.code !== "ENOENT") throw e;
        return resolve(
          await realpath(dirname(resolve(expandDirectory(path)))),
          path.split("/").at(-1)!,
        );
      });
      const settings = new Settings(canonical, { config: defaultConfig, revision: "" });
      settings.saved = await settings.guard(async () => {
        try {
          return await settings.read();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          return settings.replaceFile(defaultConfig, null);
        }
      });
      return settings;
    });
  }
  getSnapshot() {
    const desired = this.target();
    const windows = Object.fromEntries(
      (this.companion?.index.windows.active() ?? []).map((days) => {
        const entry = this.indexed.get(days) ?? {
          indexedTarget: null,
          completedAt: 0,
          attempt: null,
        };
        const attempt = entry.attempt;
        const state =
          this.pending || attempt?.target !== desired || !attempt ? "queued" : attempt.state;
        return [days, { ...entry, desiredTarget: desired, state }];
      }),
    );
    return structuredClone({
      sequence: this.sequence,
      saved: this.saved,
      effective: this.effective,
      windows,
      fileWarning: this.fileWarning,
      catalog: this.catalogState,
      restartRequired: this.companion ? this.saved.config.port !== this.companion.boundPort : false,
      boundPort: this.companion?.boundPort ?? null,
    });
  }
  change(value: unknown) {
    return this.mutate((config) => applyConfigChange(config, value));
  }
  setBoundPort(port: number) {
    if (this.companion) this.companion.boundPort = port;
    this.sequence++;
  }
  replace(value: unknown, revision: string | null) {
    return this.mutate(() => validateConfig(value), revision);
  }
  private mutate(change: (config: ObserverConfig) => ObserverConfig, expected?: string | null) {
    return attempt(() =>
      this.serial(() =>
        this.guard(async () => {
          for (let i = 0; i < 8; i++) {
            const previous = await this.read();
            if (expected !== undefined && expected !== previous.revision)
              throw new SettingsConflict(
                "Configuration changed. Reload it before replacing the whole file (If-Match is required).",
              );
            const config = validateConfig(change(previous.config));
            try {
              const saved =
                JSON.stringify(config) === JSON.stringify(previous.config)
                  ? previous
                  : await this.replaceFile(config, previous.revision);
              this.accept(saved);
              return this.getSnapshot();
            } catch (e) {
              if (!(e instanceof SettingsConflict) || expected !== undefined) throw e;
            }
          }
          throw new SettingsConflict(
            "Configuration keeps changing. Try again after the other editor finishes.",
          );
        }),
      ),
    );
  }
  poll = attempt(() =>
    this.serial(async () => {
      try {
        this.accept(await this.read());
      } catch (e) {
        this.sequence++;
        this.fileWarning = `Cannot read saved settings: ${message(e)}. Continuing with the last valid settings.`;
      }
    }),
  );
  private accept(saved: Saved) {
    const before = this.target();
    if (saved.revision !== this.saved.revision || this.fileWarning) this.sequence++;
    this.saved = saved;
    this.fileWarning = null;
    if (this.target() !== before) this.enqueue();
  }
  private target() {
    const catalog = this.candidate ?? this.companion?.catalog;
    return catalog
      ? digest(
          JSON.stringify([
            rootsOf(this.saved.config),
            catalog.snapshot(this.saved.config.modelAliases ?? {}).fingerprint,
            PRICING_REVISION,
          ]),
        )
      : null;
  }
  private enqueue() {
    if (!this.companion) return;
    this.sequence++;
    this.pending = true;
    Effect.runSync(Queue.offer(this.requests, undefined));
  }
  refresh(kind: "index" | "catalog" = "index") {
    return Effect.sync(() => {
      if (!this.companion) throw new Error("No companion worker is attached");
      if (kind === "index") this.enqueue();
      else if (this.catalogState.state !== "queued" && this.catalogState.state !== "updating") {
        this.sequence++;
        this.catalogState = { state: "queued", error: null };
        Effect.runSync(Queue.offer(this.catalogRequests, undefined));
      }
    });
  }
  demand(days: WindowDays, now: number, client: string, selection: number) {
    if (this.companion?.index.windows.touch(days, now, client, selection)) this.enqueue();
  }
  start(companion: Companion, options: { pollInterval?: number; refreshCatalog?: boolean } = {}) {
    return Effect.gen(this, function* () {
      if (this.companion) return yield* Effect.fail(new Error("Settings worker already started"));
      this.companion = companion;
      const ready = yield* Deferred.make<void, unknown>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          this.companion = null;
        }),
      );
      yield* Effect.gen(this, function* () {
        let first = true;
        while (true) {
          yield* Queue.take(this.requests);
          this.sequence++;
          this.pending = false;
          if (this.candidate) {
            companion.catalog.publish(this.candidate);
            this.candidate = null;
          }
          const catalog = companion.catalog.snapshot(this.saved.config.modelAliases ?? {});
          companion.catalog.aliases = { ...catalog.aliases };
          const target = this.target()!;
          const roots = rootsOf(this.saved.config);
          const windows = companion.index.windows.active();
          this.effective = {
            target,
            savedRevision: this.saved.revision,
            roots,
            aliases: { ...catalog.aliases },
            catalogRevision: catalog.fingerprint,
          };
          for (const days of windows) {
            const entry = this.indexed.get(days) ?? {
              indexedTarget: null,
              completedAt: 0,
              attempt: null,
            };
            entry.attempt = { target, state: "updating", errors: [], finishedAt: 0 };
            this.indexed.set(days, entry);
          }
          // Uninterruptible pass: asynchronous file operations must finish before DB shutdown.
          const result = yield* Effect.suspend(() =>
            companion.index.scanWith({ roots, catalog, windows, now: Date.now() }),
          ).pipe(
            Effect.catchAllCause((cause) => Effect.fail(Cause.squash(cause))),
            Effect.either,
            Effect.uninterruptible,
          );
          const outcome: ScanOutcome | null = result._tag === "Right" ? result.right : null;
          const finishedAt =
            outcome?.finishedAt ?? Math.max(Date.now(), companion.index.lastScan + 1);
          companion.index.lastScan = finishedAt;
          for (const days of windows) {
            const entry = this.indexed.get(days)!;
            const windowOutcome = outcome?.results[days];
            entry.attempt = {
              target,
              state: windowOutcome?.state ?? "failed",
              errors: windowOutcome?.errors ?? [
                message(result._tag === "Left" ? result.left : "Update failed"),
              ],
              finishedAt,
            };
            if (windowOutcome?.state === "complete") {
              entry.indexedTarget = target;
              entry.completedAt = finishedAt;
            }
          }
          this.revision++;
          this.sequence++;
          if (first) {
            first = false;
            if (result._tag === "Left") yield* Deferred.fail(ready, result.left);
            else yield* Deferred.succeed(ready, undefined);
          }
        }
      }).pipe(Effect.forkScoped);
      yield* Effect.gen(this, function* () {
        while (true) {
          yield* Queue.take(this.catalogRequests);
          this.sequence++;
          this.catalogState = { state: "updating", error: null };
          const result = yield* companion.catalog.prepare.pipe(
            Effect.catchAllCause((cause) => Effect.fail(Cause.squash(cause))),
            Effect.either,
            Effect.uninterruptible,
          );
          if (result._tag === "Right") {
            this.candidate = result.right;
            this.sequence++;
            this.catalogState = { state: "idle", error: null };
            this.enqueue();
          } else {
            this.sequence++;
            this.catalogState = { state: "failed", error: message(result.left) };
          }
        }
      }).pipe(Effect.forkScoped);
      if (options.pollInterval !== 0)
        yield* Effect.sleep(options.pollInterval ?? 5000).pipe(
          Effect.zipRight(this.poll),
          Effect.zipRight(this.refresh()),
          Effect.forever,
          Effect.forkScoped,
        );
      if (options.refreshCatalog !== false)
        yield* this.refresh("catalog").pipe(
          Effect.repeat(Schedule.spaced("24 hours")),
          Effect.forkScoped,
        );
      this.enqueue();
      yield* Deferred.await(ready);
    });
  }
  private async read(): Promise<Saved> {
    const text = await readFile(this.path, "utf8");
    return { config: validateConfig(JSON.parse(text)), revision: digest(text) };
  }
  private async replaceFile(config: ObserverConfig, previous: string | null): Promise<Saved> {
    const tmp = this.path + "." + randomUUID() + ".tmp";
    const text = JSON.stringify(config, null, 2) + "\n";
    try {
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      const current = await readFile(this.path, "utf8").then(digest, (e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (current !== previous)
        throw new SettingsConflict("Configuration changed in another editor.");
      await rename(tmp, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { config, revision: digest(text) };
    } finally {
      await rm(tmp, { force: true });
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.changes.catch(() => {}).then(operation);
    this.changes = next;
    return next;
  }
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    const path = this.path + ".write-guard.sqlite";
    const file = await open(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    const db = new Database(path);
    db.run("PRAGMA busy_timeout=0");
    let locked = false;
    const deadline = Date.now() + 5000;
    try {
      while (!locked) {
        try {
          db.run("BEGIN IMMEDIATE");
          locked = true;
        } catch (e) {
          if (!String(e).includes("locked") || Date.now() >= deadline) throw e;
          await Bun.sleep(15 + Math.random() * 25);
        }
      }
      return await operation();
    } finally {
      if (locked) db.run("ROLLBACK");
      db.close();
    }
  }
}
