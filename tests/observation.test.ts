import { afterEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  createObservation,
  type Observation,
  type ObservationState,
} from "../src/client/observation";
import { SnapshotStore, type CacheHead, type Stored } from "../src/client/observation/persistence";
import type { Changes } from "../src/client/observation/browser";
import { stampResponse, type EvidenceStamp } from "../src/observation-protocol";
import type { WindowDays } from "../src/windows";

const A: EvidenceStamp = { indexId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", evidenceRevision: 12 };
const B: EvidenceStamp = { indexId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", evidenceRevision: 0 };
const key = "012345678901234567890123";
const day = 86400000;
const clock = 100 * day;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = Date.now() + 2000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(2);
  expect(await check(), label).toBe(true);
}
async function stateIs(observer: Observation, check: (state: ObservationState) => boolean) {
  await until(() => check(observer.getSnapshot()), JSON.stringify(observer.getSnapshot()));
}
function response(body: unknown, stamp = A, status = 200, etag?: string) {
  const result = status === 304 ? new Response(null, { status }) : Response.json(body, { status });
  if (etag) result.headers.set("ETag", etag);
  return stampResponse(result, stamp);
}
function run(name = "recorded evidence", modified = clock) {
  return { key, name, modified };
}
function library(days: WindowDays = 7, name = "recorded evidence", modified = clock) {
  return { days, updatedAt: clock, capturedAt: clock, runs: [run(name, modified)], sessions: [] };
}
class Companion {
  stamp = A;
  name = "recorded evidence";
  modified = clock;
  offline = false;
  lastScan = clock;
  scanning = false;
  calls: { path: string; init: RequestInit }[] = [];
  intercept?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input);
    this.calls.push({ path, init });
    const intercepted = this.intercept?.(path, init);
    if (intercepted) return intercepted;
    if (this.offline) throw new Error("Offline");
    if (path === "/api/status")
      return response(
        { app: "workflow-observer", lastScan: this.lastScan, scanning: this.scanning },
        this.stamp,
      );
    if (path === "/api/refresh") return Response.json({ ok: true });
    if (path.startsWith("/api/runs?"))
      return response(
        library(
          Number(new URL(path, "http://test").searchParams.get("days")) as WindowDays,
          this.name,
          this.modified,
        ),
        this.stamp,
      );
    return response(run(this.name, this.modified), this.stamp, 200, '"opaque-server-etag"');
  }) as typeof fetch;
}
const quietChanges = (): Changes => ({ listen: () => () => {}, announce: () => {} });
function bus() {
  const receivers = new Set<(token: string) => void>();
  return () => {
    let own: ((token: string) => void) | undefined;
    return {
      listen(receive: (token: string) => void) {
        own = receive;
        receivers.add(receive);
        return () => {
          receivers.delete(receive);
        };
      },
      announce(token: string) {
        for (const receive of receivers) if (receive !== own) receive(token);
      },
    };
  };
}
function make(companion = new Companion(), options: Parameters<typeof createObservation>[0] = {}) {
  const store = options.store ?? new SnapshotStore(new IDBFactory());
  cleanup.push(() => store.close());
  const observer = createObservation({
    fetch: companion.fetch,
    store,
    changes: quietChanges,
    now: () => clock,
    pollInterval: 60000,
    ...options,
  });
  let unsubscribe: (() => void) | undefined;
  const start = () => {
    unsubscribe = observer.subscribe(() => {});
  };
  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  cleanup.push(stop);
  return { observer, store, companion, start, stop };
}
const select = (observer: Observation, days: WindowDays = 7, runKey: string | null = key) =>
  observer.dispatch({ type: "select", selection: { days, runKey } });
const refresh = (observer: Observation) => observer.dispatch({ type: "refresh" });
async function seed(store: SnapshotStore, stamp = A) {
  const head = (await store.confirm(await store.head(), stamp, () => true))!;
  await store.write(head, "library:7", { value: library() }, () => true);
  await store.write(head, `run:7:${key}`, { value: run(), etag: '"saved-etag"' }, () => true);
  return head;
}

test("construction is inert; fresh saved content stays hidden until status confirms its index", async () => {
  const c = new Companion();
  const handshake = deferred<Response>();
  const live = deferred<Response>();
  c.intercept = (path) =>
    path === "/api/status"
      ? handshake.promise
      : path.startsWith("/api/runs/")
        ? live.promise
        : undefined;
  const f = make(c);
  await seed(f.store);
  select(f.observer);
  expect(c.calls).toHaveLength(0);
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  f.start();
  await until(() => c.calls.length === 1);
  expect(f.observer.getSnapshot().library.value).toBeNull();
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  handshake.resolve(response({ app: "workflow-observer" }));
  await stateIs(f.observer, (s) => s.detail.source === "saved");
  expect(f.observer.getSnapshot().detail.value?.name).toBe("recorded evidence");
  live.resolve(response(run("live"), A, 200, '"new-etag"'));
  await stateIs(
    f.observer,
    (s) => s.detail.value?.name === "live" && s.detail.source === "current",
  );
});

test("offline first load cannot expose saved library or details", async () => {
  const f = make();
  await seed(f.store);
  f.companion.offline = true;
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  expect(f.observer.getSnapshot().library.value).toBeNull();
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  expect(f.companion.calls.map((c) => c.path)).toEqual(["/api/status"]);
});

test("database replacement accepts B revision zero and purges saved content from every window", async () => {
  const f = make();
  const old = await seed(f.store);
  await f.store.write(old, "library:90", { value: library(90) }, () => true);
  f.companion.stamp = B;
  f.companion.name = "new index";
  select(f.observer);
  const seen: string[] = [];
  const remove = f.observer.subscribe(() => {
    const name = f.observer.getSnapshot().detail.value?.name;
    if (name) seen.push(name);
  });
  cleanup.push(remove);
  await stateIs(f.observer, (s) => s.detail.value?.name === "new index");
  expect(seen).not.toContain("recorded evidence");
  const head = await f.store.head();
  expect(head.stamp).toEqual(B);
  expect((await f.store.read(head, "library:90")).data).toBeNull();
  expect(await f.store.write(old, "library:90", { value: "late old write" }, () => true)).toBe(
    false,
  );
});

test("delayed A handshake cannot replace B committed by another observer even without notifications", async () => {
  const factory = new IDBFactory();
  const old = new Companion(),
    current = new Companion();
  current.stamp = B;
  current.name = "B";
  const hold = deferred<Response>();
  old.intercept = (path) => (path === "/api/status" ? hold.promise : undefined);
  const a = make(old, { store: new SnapshotStore(factory) });
  const b = make(current, { store: new SnapshotStore(factory) });
  await seed(a.store);
  select(a.observer);
  a.start();
  await until(() => old.calls.length === 1);
  select(b.observer);
  b.start();
  await stateIs(b.observer, (s) => s.detail.value?.name === "B");
  old.intercept = undefined;
  old.stamp = B;
  old.name = "B";
  hold.resolve(response({ app: "workflow-observer" }, A));
  await stateIs(a.observer, (s) => s.detail.value?.name === "B");
  expect((await a.store.head()).stamp).toEqual(B);
  expect(old.calls.filter((c) => c.path === "/api/status")).toHaveLength(2);
});

test("cross-tab revocation clears visible evidence immediately and rejects a queued old write", async () => {
  const factory = new IDBFactory();
  const changes = bus();
  const held = deferred<void>();
  let waiting = false;
  class SlowStore extends SnapshotStore {
    override async write<T>(
      head: CacheHead,
      target: string,
      data: Stored<T> | null,
      guard: () => boolean,
    ) {
      if (target.startsWith("run:")) {
        waiting = true;
        await held.promise;
      }
      return super.write(head, target, data, guard);
    }
  }
  const c = new Companion();
  const a = make(c, { store: new SlowStore(factory), changes });
  const b = make(c, { store: new SnapshotStore(factory), changes });
  await seed(b.store);
  select(a.observer);
  a.start();
  await until(() => waiting);
  expect(a.observer.getSnapshot().detail.value).not.toBeNull();
  c.stamp = { ...A, evidenceRevision: 13 };
  c.offline = true;
  const handshake = deferred<Response>();
  c.intercept = (path) => (path === "/api/status" ? handshake.promise : undefined);
  select(b.observer);
  b.start();
  handshake.resolve(response({ app: "workflow-observer" }, c.stamp));
  await stateIs(a.observer, (s) => s.detail.value === null);
  held.resolve();
  await stateIs(b.observer, (s) => s.detail.state === "error");
  const head = await b.store.head();
  expect(head.stamp?.evidenceRevision).toBe(13);
  expect((await b.store.read(head, `run:7:${key}`)).data).toBeNull();
  expect((await b.store.read(head, "library:7")).data).toBeNull();
});

test("newer data stamp revokes everything and requires another status handshake", async () => {
  const f = make();
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  const oldDetail = deferred<Response>();
  const nextHandshake = deferred<Response>();
  let statuses = 0;
  f.companion.intercept = (path) => {
    if (path === "/api/status" && ++statuses > 1) return nextHandshake.promise;
    if (path.startsWith("/api/runs/")) return oldDetail.promise;
    if (path.startsWith("/api/runs?")) return response(library(), { ...A, evidenceRevision: 13 });
  };
  refresh(f.observer);
  await until(() => statuses > 1);
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  expect(f.observer.getSnapshot().library.value).toBeNull();
  oldDetail.resolve(response(run("late deleted secret")));
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  const head = await f.store.head();
  expect((await f.store.read(head, `run:7:${key}`)).data).toBeNull();
});

test("304 uses the server's opaque ETag and an exact-stamp retained representation", async () => {
  const f = make();
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  const count = f.companion.calls.length;
  f.companion.intercept = (path, init) => {
    if (path.startsWith("/api/runs/")) {
      expect(new Headers(init.headers).get("If-None-Match")).toBe('"opaque-server-etag"');
      return response(null, A, 304);
    }
  };
  refresh(f.observer);
  await until(() => f.companion.calls.length >= count + 4);
  await stateIs(f.observer, (s) => s.detail.source === "current");
  expect(f.observer.getSnapshot().detail.value?.name).toBe("recorded evidence");
});

test("304 without a representation retries unconditionally; 404 is absent, not offline", async () => {
  const f = make();
  let calls = 0;
  f.companion.intercept = (path, init) => {
    if (!path.startsWith("/api/runs/")) return;
    expect(new Headers(init.headers).has("If-None-Match")).toBe(false);
    return ++calls === 1 ? response(null, A, 304) : response({ error: "missing" }, A, 404);
  };
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.state === "absent");
  expect(calls).toBe(2);
  expect(f.observer.getSnapshot().connection).toBe("connected");
  expect(f.observer.getSnapshot().detail.value).toBeNull();
});

test("404 removes a confirmed saved detail and cannot restore it on reconnect", async () => {
  const f = make();
  await seed(f.store);
  const missing = deferred<Response>();
  f.companion.intercept = (path) => (path.startsWith("/api/runs/") ? missing.promise : undefined);
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "saved");
  missing.resolve(response({ error: "missing" }, A, 404));
  await stateIs(f.observer, (s) => s.detail.state === "absent");
  await until(() => f.observer.getSnapshot().detail.value === null);
  // Wait for the deletion transaction before simulating a new page lifetime.
  await until(async () => (await f.store.read(await f.store.head(), `run:7:${key}`)).data === null);
  f.stop();
  f.companion.offline = true;
  f.companion.intercept = undefined;
  f.start();
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  expect(f.observer.getSnapshot().detail.value).toBeNull();
});

test("failed data refresh retains only confirmed evidence, with per-resource saved provenance", async () => {
  const f = make();
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current" && s.library.source === "current");
  f.companion.intercept = (path) =>
    path.startsWith("/api/runs/") ? Promise.reject(new Error("socket closed")) : undefined;
  refresh(f.observer);
  await stateIs(f.observer, (s) => s.detail.state === "error");
  expect(f.observer.getSnapshot().detail.source).toBe("saved");
  expect(f.observer.getSnapshot().detail.value?.name).toBe("recorded evidence");
  expect(f.observer.getSnapshot().library.source).toBe("current");
  expect(f.observer.getSnapshot().connection).toBe("connected");
});

test("offline snapshots expire locally, including detail and session totals", async () => {
  let time = clock;
  const f = make(undefined, { now: () => time, pollInterval: 15 });
  f.companion.intercept = (path) =>
    path.startsWith("/api/runs?")
      ? response({
          ...library(),
          sessions: [{ key: "s", windowDays: 7, runKeys: [key], usage: { total: 100 } }],
        })
      : undefined;
  select(f.observer);
  f.start();
  await stateIs(
    f.observer,
    (s) => s.detail.source === "current" && s.library.value?.sessions.length === 1,
  );
  f.companion.offline = true;
  f.companion.intercept = undefined;
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  expect(f.observer.getSnapshot().detail.source).toBe("saved");
  time += 8 * day;
  await stateIs(f.observer, (s) => s.detail.state === "absent");
  expect(f.observer.getSnapshot().library.value?.runs).toEqual([]);
  expect(f.observer.getSnapshot().library.value?.sessions).toEqual([]);
});

test("90 → 7 → 30 switches reject late requests and keep library window demand while in detail", async () => {
  const f = make();
  const slow = deferred<Response>();
  f.companion.intercept = (path) => (path === "/api/runs?days=90" ? slow.promise : undefined);
  select(f.observer, 90);
  f.start();
  await until(() => f.companion.calls.some((c) => c.path === "/api/runs?days=90"));
  select(f.observer, 7);
  select(f.observer, 30);
  await stateIs(f.observer, (s) => s.library.value?.days === 30 && s.detail.source === "current");
  slow.resolve(response(library(90, "late ninety days")));
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().library.value?.days).toBe(30);
  expect(f.observer.getSnapshot().library.value?.runs[0].name).not.toBe("late ninety days");
  const calls = f.companion.calls.filter((c) => c.path.startsWith("/api/runs?"));
  expect(new Headers(calls.at(-1)!.init.headers).get("X-Observer-Selection")).toBe("3");
  expect(new Headers(calls[0].init.headers).get("X-Observer-Client")).toBe(
    new Headers(calls.at(-1)!.init.headers).get("X-Observer-Client"),
  );
});

test("late cache read from an earlier selection cannot restore its detail", async () => {
  const hold = deferred<void>();
  let waiting = false;
  class SlowRead extends SnapshotStore {
    override async read<T>(head: CacheHead, target: string) {
      const value = await super.read<T>(head, target);
      if (target.startsWith("run:7:")) {
        waiting = true;
        await hold.promise;
      }
      return value;
    }
  }
  const f = make(undefined, { store: new SlowRead(new IDBFactory()) });
  await seed(f.store);
  select(f.observer);
  f.start();
  await until(() => waiting);
  select(f.observer, 30, null);
  await stateIs(f.observer, (s) => s.library.value?.days === 30);
  hold.resolve();
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().detail.state).toBe("idle");
  expect(f.observer.getSnapshot().detail.value).toBeNull();
});

test("storage failure permits live observation but never an unconfirmed fallback", async () => {
  class BrokenStore extends SnapshotStore {
    override head(): Promise<CacheHead> {
      return Promise.reject(new Error("Storage denied"));
    }
  }
  const f = make(undefined, { store: new BrokenStore() });
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  expect(f.observer.getSnapshot().storageWarning).toContain("unavailable");
  f.companion.offline = true;
  f.stop();
  f.start();
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  expect(f.observer.getSnapshot().detail.value).toBeNull();
});

test("storage timeout revokes a pending write's guard, allowing live-only progress", async () => {
  const hold = deferred<void>();
  let queued = false;
  class StalledStore extends SnapshotStore {
    override async write<T>(
      head: CacheHead,
      target: string,
      value: Stored<T> | null,
      guard: () => boolean,
    ) {
      if (target.startsWith("run:")) {
        queued = true;
        await hold.promise;
      }
      return super.write(head, target, value, guard);
    }
  }
  const f = make(undefined, { store: new StalledStore(new IDBFactory()), storageTimeout: 10 });
  select(f.observer);
  f.start();
  await until(() => queued);
  await stateIs(f.observer, (s) => !!s.storageWarning);
  hold.resolve();
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().detail.source).toBe("current");
  expect((await f.store.read(await f.store.head(), `run:7:${key}`)).data).toBeNull();
});

test("Strict Mode remount cancels old work, shares one poller, and releases listeners on last unsubscribe", async () => {
  const c = new Companion();
  const first = deferred<Response>();
  let received = 0;
  let activeListeners = 0;
  c.intercept = (path) => (path === "/api/status" && ++received === 1 ? first.promise : undefined);
  const f = make(c, {
    pollInterval: 20,
    changes: () => ({
      listen: () => {
        activeListeners++;
        return () => {
          activeListeners--;
        };
      },
      announce: () => {},
    }),
  });
  select(f.observer);
  f.start();
  await until(() => c.calls.length === 1);
  const oldSignal = c.calls[0].init.signal!;
  f.stop();
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  expect(oldSignal.aborted).toBe(true);
  expect(activeListeners).toBe(1);
  first.resolve(response({ app: "workflow-observer" }, B));
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().stamp).toEqual(A);
  f.stop();
  const count = c.calls.length;
  await Bun.sleep(50);
  expect(c.calls).toHaveLength(count);
  expect(activeListeners).toBe(0);
  expect(f.observer.getSnapshot().detail.value).toBeNull();
});

test("refresh requests coalesce; scan completion and connection failures remain separate", async () => {
  const f = make(undefined, { pollInterval: 15 });
  f.start();
  await stateIs(f.observer, (s) => s.library.source === "current");
  const scan = deferred<Response>();
  f.companion.scanning = true;
  f.companion.intercept = (path) => (path === "/api/refresh" ? scan.promise : undefined);
  refresh(f.observer);
  refresh(f.observer);
  refresh(f.observer);
  await until(() => f.companion.calls.some((c) => c.path === "/api/refresh"));
  expect(f.observer.getSnapshot().refresh).toBe("requested");
  scan.resolve(Response.json({ ok: true }));
  await stateIs(f.observer, (s) => s.refresh === "scanning");
  refresh(f.observer);
  expect(f.companion.calls.filter((c) => c.path === "/api/refresh")).toHaveLength(1);
  f.companion.lastScan++;
  f.companion.scanning = false;
  await stateIs(f.observer, (s) => s.refresh === "idle");
  f.companion.intercept = (path) =>
    path === "/api/refresh" ? Promise.reject(new Error("failed")) : undefined;
  refresh(f.observer);
  await stateIs(f.observer, (s) => s.refresh === "error");
  expect(f.observer.getSnapshot().connection).toBe("connected");
  expect(f.observer.getSnapshot().library.value).not.toBeNull();
});

test("legacy unscoped snapshots are purged without hydration", async () => {
  const factory = new IDBFactory();
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open("workflow-observer", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").put({ source: "deleted legacy secret" }, key);
    tx.oncomplete = () => resolve();
  });
  const f = make(undefined, { store: new SnapshotStore(factory) });
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  const all = await new Promise<unknown[]>((resolve) => {
    const request = db.transaction("snapshots").objectStore("snapshots").getAll();
    request.onsuccess = () => resolve(request.result);
  });
  expect(JSON.stringify(all)).not.toContain("deleted legacy secret");
  db.close();
});

test("a 304 from another index cannot bless a retained old representation", async () => {
  const f = make();
  select(f.observer);
  f.start();
  await stateIs(f.observer, (s) => s.detail.source === "current");
  let statusCalls = 0;
  const hold = deferred<Response>();
  f.companion.intercept = (path) => {
    if (path === "/api/status" && ++statusCalls > 1) return hold.promise;
    if (path.startsWith("/api/runs/")) return response(null, B, 304);
  };
  refresh(f.observer);
  await until(() => statusCalls > 1);
  expect(f.observer.getSnapshot().detail.value).toBeNull();
  expect(f.observer.getSnapshot().stamp).toBeNull();
});

test("an older scoped revision stays disconnected without a retry storm", async () => {
  const f = make();
  await seed(f.store, { ...A, evidenceRevision: 13 });
  f.start();
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  await Bun.sleep(10);
  expect(f.companion.calls).toHaveLength(1);
  expect(f.observer.getSnapshot().library.value).toBeNull();
});

test("request timeout aborts transport and a late success cannot reopen the initial gate", async () => {
  const f = make(undefined, { requestTimeout: 10 });
  const hold = deferred<Response>();
  f.companion.intercept = () => hold.promise;
  await seed(f.store);
  f.start();
  await stateIs(f.observer, (s) => s.connection === "disconnected");
  expect(f.companion.calls[0].init.signal?.aborted).toBe(true);
  hold.resolve(response({ app: "workflow-observer" }));
  await Bun.sleep(5);
  expect(f.observer.getSnapshot().library.value).toBeNull();
  expect(f.observer.getSnapshot().connection).toBe("disconnected");
});

test("confirmed saved libraries trim expired runs and drop affected session totals before rendering", async () => {
  const f = make();
  const head = await seed(f.store);
  const recent = run("at the inclusive boundary", clock - 7 * day);
  const old = { ...run("too old", clock - 8 * day), key: "old" };
  await f.store.write(
    head,
    "library:7",
    {
      value: {
        ...library(),
        runs: [recent, old],
        sessions: [{ key: "s", windowDays: 7, runKeys: [key, "old"] }],
      },
    },
    () => true,
  );
  const hold = deferred<Response>();
  f.companion.intercept = (path) => (path.startsWith("/api/runs?") ? hold.promise : undefined);
  f.start();
  await stateIs(f.observer, (s) => s.library.source === "saved");
  expect(f.observer.getSnapshot().library.value?.runs.map((r) => r.name)).toEqual([
    "at the inclusive boundary",
  ]);
  expect(f.observer.getSnapshot().library.value?.sessions).toEqual([]);
});

test("A → B → A changes still reject a handshake captured before both transactions", async () => {
  const factory = new IDBFactory();
  const old = new Companion(),
    c = new Companion();
  const hold = deferred<Response>();
  old.intercept = (path) => (path === "/api/status" ? hold.promise : undefined);
  const a = make(old, { store: new SnapshotStore(factory) });
  const b = make(c, { store: new SnapshotStore(factory) });
  const initial = await seed(a.store);
  a.start();
  await until(() => old.calls.length === 1);
  c.stamp = B;
  c.name = "B";
  b.start();
  await stateIs(b.observer, (s) => s.library.value?.runs[0].name === "B");
  c.stamp = A;
  c.name = "A restored";
  c.lastScan++;
  refresh(b.observer);
  await stateIs(b.observer, (s) => s.library.value?.runs[0].name === "A restored");
  old.intercept = undefined;
  old.name = "A restored";
  hold.resolve(response({ app: "workflow-observer" }, A));
  await stateIs(a.observer, (s) => s.library.value?.runs[0].name === "A restored");
  expect(old.calls.filter((c) => c.path === "/api/status")).toHaveLength(2);
  expect((await a.store.head()).token).not.toBe(initial.token);
  expect(await a.store.write(initial, "library:90", { value: "old evidence" }, () => true)).toBe(
    false,
  );
});
