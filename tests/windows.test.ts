import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { Indexer, runKey } from "../src/indexer";
import { Catalog } from "../src/catalog";
import { parseWindow, cutoffFor, WindowDemand } from "../src/windows";

const day = 86_400_000;
test("only supported rolling windows are accepted; seven days is the default", () => {
  expect(parseWindow(null)).toBe(7);
  for (const days of [1, 7, 30, 90] as const) {
    expect(parseWindow(String(days))).toBe(days);
    expect(cutoffFor(days, 100 * day)).toBe((100 - days) * day);
  }
  for (const input of ["", "0", "8", "91", "all", "Infinity", "7.0", "7days"])
    expect(() => parseWindow(input)).toThrow();
});

test("windows are scoped to clients, narrowing takes effect immediately, and abandoned windows expire", () => {
  const demand = new WindowDemand();
  expect(demand.active(1)).toEqual([7]);
  demand.touch(90, 1, "a");
  demand.touch(1, 1, "b");
  expect(demand.active(2).sort((a, b) => a - b)).toEqual([1, 90]);
  demand.touch(7, 2, "a");
  expect(demand.active(3).sort((a, b) => a - b)).toEqual([1, 7]);
  demand.touch(30, 20_000, "b");
  expect(demand.active(30_003)).toEqual([30]);
  expect(demand.active(50_001)).toEqual([7]);
});

test("old transcripts are skipped, widening discovers history, narrowing removes it, and resumed appends are found", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-window-"));
  const root = join(dir, "claude"),
    data = join(dir, "data");
  await mkdir(data);
  const index = new Indexer([root], data, new Catalog(data));
  const now = Date.now();
  const fixtures = new Map<
    string,
    { session: string; live: string; agent: string; time: number }
  >();
  const make = async (id: string, age: number, sessionId = id) => {
    const session = join(root, "projects", "p", sessionId),
      live = join(session, "subagents", "workflows", id);
    await mkdir(live, { recursive: true });
    const time = now - age * day,
      agent = join(live, "agent-a.jsonl");
    const response = {
      type: "assistant",
      timestamp: new Date(time).toISOString(),
      message: { id, model: "gpt-fixture", usage: { input_tokens: 100, output_tokens: 10 } },
    };
    await writeFile(agent, JSON.stringify(response) + "\n");
    await writeFile(session + ".jsonl", JSON.stringify({ cwd: dir, type: "user" }) + "\n");
    await utimes(agent, new Date(time), new Date(time));
    fixtures.set(id, { session, live, agent, time });
  };
  try {
    await make("wf_recent", 0.5, "shared");
    await make("wf_five", 5);
    await make("wf_old", 20, "shared");
    await make("wf_sixty", 60);
    await make("wf_ancient", 100);
    await Effect.runPromise(index.scan);
    expect(
      index
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["wf_five", "wf_recent"]);
    const cached = () =>
      (
        index.db.query("SELECT path FROM transcript_evidence WHERE state IS NOT NULL").all() as {
          path: string;
        }[]
      ).map((r) => r.path);
    expect(cached()).not.toContain(fixtures.get("wf_old")!.agent);
    expect(cached()).not.toContain(fixtures.get("wf_sixty")!.agent);
    expect(cached()).not.toContain(fixtures.get("wf_ancient")!.agent);
    const shared = index.sessions.list().find((s) => s.id === "shared")!;
    expect(shared.excludedWorkflows).toBe(1);
    expect(shared.warnings.join(" ")).toContain("outside this time window");
    index.windows.touch(30);
    await Effect.runPromise(index.scan);
    expect(
      index
        .list(30)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["wf_five", "wf_old", "wf_recent"]);
    expect(index.sessions.list(30).find((s) => s.id === "shared")!.excludedWorkflows).toBe(0);
    expect(cached()).toContain(fixtures.get("wf_old")!.agent);
    expect(cached()).not.toContain(fixtures.get("wf_sixty")!.agent);
    index.windows.touch(90);
    await Effect.runPromise(index.scan);
    expect(index.list(90)).toHaveLength(4);
    expect(cached()).not.toContain(fixtures.get("wf_ancient")!.agent);
    index.windows.touch(1);
    await Effect.runPromise(index.scan);
    expect(index.list(1).map((r) => r.id)).toEqual(["wf_recent"]);
    expect(index.get(runKey(root, "p", "shared", "wf_old"), cutoffFor(7))).toBeNull();
    // Appending an existing file does not update its parent directory mtime.
    const old = fixtures.get("wf_ancient")!;
    await utimes(old.live, new Date(old.time), new Date(old.time));
    const directoryTime = (await stat(old.live)).mtimeMs;
    await appendFile(
      old.agent,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          id: "resumed",
          model: "gpt-fixture",
          usage: { input_tokens: 20, output_tokens: 2 },
        },
      }) + "\n",
    );
    expect((await stat(old.live)).mtimeMs).toBe(directoryTime);
    await Effect.runPromise(index.scan);
    expect(
      index
        .list(1)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["wf_ancient", "wf_recent"]);
    expect(cached()).toContain(old.agent);
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy startup does not hydrate old payloads; only matching compact summaries migrate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-window-migration-"));
  const db = new Database(join(dir, "observer.sqlite"));
  db.run("CREATE TABLE runs (key TEXT PRIMARY KEY, modified REAL, fingerprint TEXT, data TEXT)");
  const now = Date.now();
  db.query("INSERT INTO runs VALUES (?,?,?,?)").run(
    "ancient",
    now - 100 * day,
    "old",
    "deliberately invalid JSON: this old payload must never be read",
  );
  db.query("INSERT INTO runs VALUES (?,?,?,?)").run(
    "recent",
    now - 2 * day,
    "new",
    JSON.stringify({
      key: "recent",
      id: "wf_recent",
      modified: now - 2 * day,
      agents: [],
      source: "heavy source",
      result: { private: "heavy result" },
    }),
  );
  db.query("INSERT INTO runs VALUES (?,?,?,?)").run(
    "month",
    now - 20 * day,
    "new",
    JSON.stringify({
      key: "month",
      id: "wf_month",
      modified: now - 20 * day,
      agents: [],
      source: "heavy source",
      result: { private: "heavy result" },
    }),
  );
  db.close();
  const index = new Indexer([], dir, new Catalog(dir));
  try {
    expect(index.db.query("SELECT count(*) AS n FROM run_summaries").get()).toEqual({ n: 0 });
    const recent = index.list();
    expect(recent.map((r) => r.id)).toEqual(["wf_recent"]);
    expect(recent[0]).not.toHaveProperty("source");
    expect(recent[0]).not.toHaveProperty("agents");
    expect(recent[0]).not.toHaveProperty("result");
    expect(index.db.query("SELECT count(*) AS n FROM run_summaries").get()).toEqual({ n: 1 });
    expect(index.list(30)).toHaveLength(2);
    expect(index.db.query("SELECT count(*) AS n FROM run_summaries").get()).toEqual({ n: 2 });
    expect(index.list(90)).toHaveLength(2);
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delayed wider request cannot renew or replace a newer tab selection", () => {
  const demand = new WindowDemand();
  demand.touch(90, 0, "tab", 1);
  demand.touch(7, 100, "tab", 2);
  demand.touch(30, 200, "tab", 3);
  expect(demand.touch(90, 29_000, "tab", 1)).toBe(false);
  expect(demand.active(29_001)).toEqual([30]);
  expect(demand.active(30_201)).toEqual([7]);
  expect(demand.touch(90, 31_000, "tab", 1)).toBe(false);
  expect(demand.active(31_001)).toEqual([7]);
});
