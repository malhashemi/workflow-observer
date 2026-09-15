import { randomId } from "../browser-support";
import { Effect, Fiber, Queue } from "effect";
import type { Run, RecordData } from "../../types";
import { cutoffFor, DEFAULT_WINDOW, type WindowDays } from "../../windows";
import { readStamp, sameStamp, type EvidenceStamp } from "../../observation-protocol";
import { limitLibrary, type LibrarySnapshot } from "./library";
import { SnapshotStore, type CacheHead, type Stored } from "./persistence";
import { browserChanges, type Changes } from "./browser";

export { emptyLibrary } from "./library";
export interface Selection {
  days: WindowDays;
  runKey: string | null;
}
export interface Resource<T> {
  state: "idle" | "loading" | "present" | "absent" | "error";
  value: T | null;
  source: "current" | "saved" | null;
  error: string | null;
}
export interface ObservationState {
  selection: Selection;
  connection: "checking" | "connected" | "disconnected";
  stamp: EvidenceStamp | null;
  confirmedAt: number | null;
  status: RecordData | null;
  library: Resource<LibrarySnapshot>;
  detail: Resource<Run>;
  refresh: "idle" | "requested" | "scanning" | "error";
  refreshError: string | null;
  storageWarning: string | null;
}
export type Command = { type: "select"; selection: Selection } | { type: "refresh" };
export interface Observation {
  getSnapshot(): ObservationState;
  subscribe(listener: () => void): () => void;
  dispatch(command: Command): void;
}
interface Options {
  fetch?: typeof globalThis.fetch;
  store?: SnapshotStore;
  changes?: () => Changes;
  now?: () => number;
  pollInterval?: number;
  requestTimeout?: number;
  storageTimeout?: number;
}
const blank = <T>(state: Resource<T>["state"] = "loading"): Resource<T> => ({
  state,
  value: null,
  source: null,
  error: null,
});
const saved = <T>(resource: Resource<T>): Resource<T> => ({
  ...resource,
  source: resource.value ? "saved" : null,
});
const present = <T>(value: T, source: "current" | "saved"): Resource<T> => ({
  state: "present",
  value,
  source,
  error: null,
});
export const sameSelection = (a: Selection, b: Selection) =>
  a.days === b.days && a.runKey === b.runKey;

/** Owns the complete observation lifetime. Construction has no browser or network side effects. */
export function createObservation(options: Options = {}): Observation {
  const store = options.store ?? new SnapshotStore();
  const transport = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? Date.now;
  let wake = Effect.runSync(Queue.sliding<void>(1));
  const listeners = new Set<() => void>();
  let state: ObservationState = {
    selection: { days: DEFAULT_WINDOW, runKey: null },
    connection: "checking",
    stamp: null,
    confirmedAt: null,
    status: null,
    library: blank(),
    detail: blank("idle"),
    refresh: "idle",
    refreshError: null,
    storageWarning: null,
  };
  let root: Fiber.RuntimeFiber<void, never> | undefined;
  let flight: Fiber.RuntimeFiber<void, unknown> | undefined;
  let epoch = 0;
  let lifetime = 0;
  let needsPurge = false;
  let observedRevision: EvidenceStamp | null = null;
  let selectionNumber = 0;
  let clientId = "";
  let head: CacheHead | null = null;
  let storage = true;
  let etag: string | undefined;
  let changes: Changes | undefined;
  let stopChanges: (() => void) | undefined;
  let refreshPending = false;
  let refreshBaseline = 0;
  const publish = (patch: Partial<ObservationState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const notify = () => {
    Effect.runSync(Queue.offer(wake, undefined));
  };
  const clear = () => {
    etag = undefined;
    publish({
      stamp: null,
      confirmedAt: null,
      connection: "checking",
      status: null,
      library: blank(),
      detail: blank(state.selection.runKey ? "loading" : "idle"),
    });
  };
  const cancel = () => {
    epoch++;
    if (flight) Effect.runFork(Fiber.interrupt(flight));
  };
  const recheck = () => {
    cancel();
    clear();
    notify();
  };
  const expire = () => {
    const library = state.library.value;
    const detail = state.detail.value;
    const limited = library && limitLibrary(library, state.selection.days, now());
    if (
      limited &&
      (limited.runs.length !== library!.runs.length ||
        limited.sessions.length !== library!.sessions.length)
    )
      publish({ library: { ...state.library, value: limited } });
    if (detail && detail.modified < cutoffFor(state.selection.days, now())) {
      etag = undefined;
      publish({
        detail: {
          ...blank<Run>("absent"),
          error: "This workflow is outside the selected time window.",
        },
      });
    }
  };

  async function cycle(signal: AbortSignal) {
    const ticket = epoch;
    const selection = state.selection;
    const current = () => !signal.aborted && listeners.size > 0 && ticket === epoch;
    // Timeouts also revoke the transaction guard: a delayed IndexedDB open cannot commit later.
    async function cached<T>(
      operation: (guard: () => boolean) => Promise<T>,
    ): Promise<T | undefined> {
      if (!storage || !current()) return undefined;
      let active = true;
      try {
        return await Effect.runPromise(
          Effect.tryPromise(() => operation(() => active && current())).pipe(
            Effect.timeout(options.storageTimeout ?? 1500),
          ),
          { signal },
        );
      } catch {
        if (current()) {
          storage = false;
          head = null;
          publish({
            storageWarning:
              "Browser storage is unavailable. Live observations continue; snapshots cannot be saved.",
          });
        }
        return undefined;
      } finally {
        active = false;
      }
    }
    async function request(path: string, init?: RequestInit) {
      return Effect.runPromise(
        Effect.tryPromise(async (requestSignal) => {
          const response = await transport(path, {
            ...init,
            cache: "no-store",
            signal: requestSignal,
          });
          const body = response.status === 304 ? null : await response.json();
          return { response, body };
        }).pipe(Effect.timeout(options.requestTimeout ?? 8000)),
        { signal },
      );
    }
    async function persist<T>(key: string, data: Stored<T> | null) {
      const captured = head;
      if (!captured || !current()) return current();
      const written = await cached((guard) => store.write(captured, key, data, guard));
      if (current() && written === false) recheck();
      return current();
    }
    async function hydrate<T>(key: string, accept: (data: Stored<T>) => void) {
      const captured = head;
      if (!captured || !current()) return;
      const result = await cached(() => store.read<T>(captured, key));
      if (!current() || !result) return;
      if (!result.matched) {
        recheck();
        return;
      }
      const latest = await cached(() => store.head());
      if (!current() || !latest) return;
      if (latest.token !== captured.token) {
        recheck();
        return;
      }
      if (result.data) accept(result.data);
    }
    async function accepts(response: Response) {
      if (!current()) return false;
      const received = readStamp(response.headers);
      if (sameStamp(received, state.stamp) && received) return true;
      // An unstamped HTTP failure is a connection error, not evidence of deletion.
      if (!received && !response.ok && response.status !== 304 && response.status !== 404)
        throw new Error(`Companion returned ${response.status}`);
      observedRevision = received;
      needsPurge = true;
      recheck();
      return false;
    }
    try {
      if (refreshPending) {
        refreshPending = false;
        refreshBaseline = Number(state.status?.lastScan ?? 0);
        try {
          const { response } = await request("/api/refresh", { method: "POST" });
          if (!current()) return;
          if (!response.ok) throw new Error(`Companion returned ${response.status}`);
          publish({ refresh: "scanning", refreshError: null });
        } catch {
          if (!current()) return;
          publish({
            refresh: "error",
            refreshError: "Could not request a scan. Reconnect the companion and try again.",
          });
        }
      }
      // Capture the persisted head BEFORE issuing the handshake, including on first load.
      let expected = await cached(() => store.head());
      if (!current()) return;
      if (needsPurge && expected) {
        const invalidated = await cached((guard) =>
          store.invalidate(expected!, guard, observedRevision),
        );
        if (!current()) return;
        if (invalidated === null) {
          recheck();
          return;
        }
        if (invalidated) {
          expected = head = invalidated;
          needsPurge = false;
          changes?.announce(invalidated.token);
        }
      }
      if (!current()) return;
      if (expected && head && expected.token !== head.token) clear();
      const { response, body } = await request("/api/status");
      if (!current()) return;
      if (!response.ok) throw new Error(`Companion returned ${response.status}`);
      const stamp = readStamp(response.headers);
      if (!stamp || body?.app !== "workflow-observer")
        throw new Error("Companion observation protocol unavailable");
      if (
        [state.stamp, expected?.stamp, observedRevision].some(
          (known) =>
            known?.indexId === stamp.indexId && stamp.evidenceRevision < known.evidenceRevision,
        )
      )
        throw new Error("Companion returned an older evidence revision");
      if (!sameStamp(state.stamp, stamp)) clear();
      if (expected) {
        const accepted = await cached((guard) => store.confirm(expected, stamp, guard));
        if (!current()) return;
        if (accepted === null) {
          recheck();
          return;
        }
        if (accepted) {
          head = accepted;
          if (accepted.token !== expected.token) changes?.announce(accepted.token);
        }
      }
      if (!current()) return;
      observedRevision = stamp;
      publish({
        stamp,
        connection: "connected",
        confirmedAt: now(),
        status: body,
        ...(state.refresh === "scanning" && !body.scanning && body.lastScan > refreshBaseline
          ? { refresh: "idle" }
          : {}),
      });
      const libraryKey = `library:${selection.days}`;
      const detailKey = `run:${selection.days}:${selection.runKey}`;
      // Reads finish before live requests, so neither 200 nor 404 can be overwritten by a late read.
      if (!state.library.value)
        await hydrate<LibrarySnapshot>(libraryKey, ({ value }) => {
          if (
            value?.days === selection.days &&
            Array.isArray(value.runs) &&
            Array.isArray(value.sessions)
          )
            publish({ library: present(limitLibrary(value, selection.days, now()), "saved") });
        });
      if (!current()) return;
      if (selection.runKey && !state.detail.value && state.detail.state !== "absent")
        await hydrate<Run>(detailKey, (data) => {
          if (
            data.value?.key === selection.runKey &&
            data.value.modified >= cutoffFor(selection.days, now())
          ) {
            etag = data.etag;
            publish({ detail: present(data.value, "saved") });
          }
        });
      if (!current()) return;
      await Promise.all([
        (async () => {
          try {
            const { response, body } = await request(`/api/runs?days=${selection.days}`, {
              headers: {
                "X-Observer-Client": clientId,
                "X-Observer-Selection": String(selectionNumber),
              },
            });
            if (!(await accepts(response)) || !current()) return;
            if (
              !response.ok ||
              body?.days !== selection.days ||
              !Array.isArray(body.runs) ||
              !Array.isArray(body.sessions)
            )
              throw new Error("Could not read the workflow library");
            const value = limitLibrary(body, selection.days, now());
            if (await persist(libraryKey, { value }))
              publish({ library: present(limitLibrary(value, selection.days, now()), "current") });
          } catch {
            if (current())
              publish({
                library: {
                  ...saved(state.library),
                  state: "error",
                  error: "Could not update the workflow library.",
                },
              });
          }
        })(),
        (async () => {
          if (!selection.runKey) return;
          try {
            const path = `/api/runs/${selection.runKey}?days=${selection.days}`;
            const sentEtag = state.detail.value ? etag : undefined;
            let result = await request(path, {
              headers: sentEtag ? { "If-None-Match": sentEtag } : {},
            });
            if (!(await accepts(result.response)) || !current()) return;
            if (result.response.status === 304 && (!sentEtag || !state.detail.value)) {
              result = await request(path);
              if (!(await accepts(result.response)) || !current()) return;
            }
            if (result.response.status === 304) {
              if (!state.detail.value) throw new Error("Missing workflow representation");
              // Even an unchanged representation must still belong to the active cross-tab head.
              const latest = await cached(() => store.head());
              if (!current()) return;
              if (latest && head && latest.token !== head.token) {
                recheck();
                return;
              }
              if (state.detail.value) publish({ detail: present(state.detail.value, "current") });
              expire();
              return;
            }
            if (result.response.status === 404) {
              etag = undefined;
              publish({
                detail: {
                  ...blank<Run>("absent"),
                  error: "This workflow is unavailable or outside the selected time window.",
                },
              });
              await persist<Run>(detailKey, null);
              return;
            }
            if (
              !result.response.ok ||
              result.body?.key !== selection.runKey ||
              !Number.isFinite(result.body.modified)
            )
              throw new Error("Could not read the workflow");
            if (result.body.modified < cutoffFor(selection.days, now())) {
              etag = undefined;
              publish({
                detail: {
                  ...blank<Run>("absent"),
                  error: "This workflow is outside the selected time window.",
                },
              });
              await persist<Run>(detailKey, null);
              return;
            }
            const nextEtag = result.response.headers.get("ETag") ?? undefined;
            if (await persist(detailKey, { value: result.body, etag: nextEtag })) {
              etag = nextEtag;
              publish({ detail: present(result.body, "current") });
              expire();
            }
          } catch {
            if (current())
              publish({
                detail: {
                  ...saved(state.detail),
                  state: "error",
                  error: "Could not update this workflow.",
                },
              });
          }
        })(),
      ]);
    } catch {
      if (current())
        publish({
          connection: "disconnected",
          library: saved(state.library),
          detail: saved(state.detail),
        });
    }
    if (current()) expire();
  }

  function start() {
    clientId ||= randomId();
    storage = true;
    head = null;
    clear();
    changes = (options.changes ?? browserChanges)();
    stopChanges = changes.listen((token) => {
      if (token !== head?.token) recheck();
    });
    const activeLifetime = ++lifetime;
    const lifetimeQueue = Effect.runSync(Queue.sliding<void>(1));
    wake = lifetimeQueue;
    root = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep(options.pollInterval ?? 5000);
                yield* Effect.sync(() => {
                  if (activeLifetime === lifetime) {
                    expire();
                    notify();
                  }
                });
              }),
            ),
          );
          notify();
          while (listeners.size && activeLifetime === lifetime) {
            yield* Queue.take(lifetimeQueue);
            if (activeLifetime !== lifetime) break;
            const running = yield* Effect.forkScoped(Effect.tryPromise(cycle));
            flight = running;
            yield* Fiber.await(running);
            if (flight === running) flight = undefined;
          }
        }),
      ).pipe(Effect.catchAllCause(() => Effect.void)),
    );
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        lifetime++;
        cancel();
        if (root) Effect.runFork(Fiber.interrupt(root));
        root = undefined;
        stopChanges?.();
        stopChanges = undefined;
        changes = undefined;
        head = null;
        void store.close().catch(() => {});
        refreshPending = false;
        publish({ refresh: "idle", refreshError: null });
        clear();
      };
    },
    dispatch(command) {
      if (command.type === "select") {
        if (sameSelection(command.selection, state.selection)) return;
        cancel();
        selectionNumber++;
        if (state.refresh === "requested") refreshPending = true;
        etag = undefined;
        publish({
          selection: { ...command.selection },
          library: blank(),
          detail: blank(command.selection.runKey ? "loading" : "idle"),
        });
        if (listeners.size) notify();
      } else {
        if (refreshPending || state.refresh === "scanning") return;
        refreshPending = true;
        publish({ refresh: "requested", refreshError: null });
        if (listeners.size) notify();
      }
    },
  };
}
