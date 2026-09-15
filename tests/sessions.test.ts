import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Catalog } from "../src/catalog";
import { Indexer, runKey } from "../src/indexer";
import { sessionUsage } from "../src/sessions";

const catalog = new Catalog("/unused");
catalog.providers = {
  openai: {
    models: {
      "gpt-fixture": {
        id: "gpt-fixture",
        limit: { context: 1000000 },
        cost: { input: 4, output: 20 },
      },
    },
  },
} as any;
const response = (id: string, input: number, time = 1, sessionId = "s") => ({
  type: "assistant",
  sessionId,
  timestamp: new Date(Date.now() - 10000 + time * 1000).toISOString(),
  message: { id, model: "gpt-fixture", usage: { input_tokens: input, output_tokens: 10 } },
});
const row = (input: number, time = 1, sessionId = "s") => ({
  model: "gpt-fixture",
  usage: { input_tokens: input, output_tokens: 10 },
  time,
  sessionId,
});
const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r) + "\n").join("");

test("session accounting deduplicates resumed/copy requests, keeps later corrections and disjoint cost categories", () => {
  const parts: Parameters<typeof sessionUsage>[0] = [
    { kind: "workflow" as const, messages: { shared: row(900, 1), agent: row(100) } },
    {
      kind: "workflow" as const,
      messages: { shared: row(20, 3), foreign: row(1000, 1, "fork-parent") },
    },
    { kind: "parent" as const, messages: { shared: row(800, 2), parent: row(50) } },
    { kind: "other" as const, messages: { parent: row(50), other: row(30) } },
  ];
  const a = sessionUsage(parts, "s", catalog);
  const b = sessionUsage([...parts].reverse(), "s", catalog);
  expect(a.usage.requests).toBe(4);
  expect(a.usage.total).toBe(240);
  expect(a.workflowUsage.total).toBe(140);
  expect(a.parentUsage.total).toBe(60);
  expect(a.otherUsage.total).toBe(40);
  expect(a.usage.cost).toBeCloseTo(0.0016, 10);
  expect(b.usage).toEqual(a.usage);
  expect(a.usage.cost).toBe(a.workflowUsage.cost + a.parentUsage.cost + a.otherUsage.cost);
});

test("session discovery separates profiles and IDs, follows finished-session renames and standalone agents, and retains history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-sessions-"));
  const roots = [join(dir, "claude"), join(dir, "mixed")];
  const data = join(dir, "data");
  await mkdir(data);
  const index = new Indexer(roots, data, catalog);
  const writeSession = async (root: string, id: string, ids: string[]) => {
    const session = join(root, "projects", "p", id);
    await mkdir(join(session, "workflows"), { recursive: true });
    await writeFile(
      session + ".jsonl",
      lines(
        { cwd: dir, type: "ai-title", aiTitle: "Same title", sessionId: id },
        response("parent", 50, 1, id),
      ),
    );
    for (const run of ids) {
      const live = join(session, "subagents", "workflows", run);
      await mkdir(live, { recursive: true });
      await writeFile(join(live, "agent-a.jsonl"), lines(response("shared-agent", 100, 1, id)));
      await writeFile(
        join(session, "workflows", run + ".json"),
        JSON.stringify({ status: "completed", workflowName: run }),
      );
    }
    await writeFile(
      join(session, "subagents", "agent-other.jsonl"),
      lines(response("other", 30, 1, id)),
    );
    return session;
  };
  try {
    const session = await writeSession(roots[0], "s", ["wf_one", "wf_two"]);
    await writeSession(roots[0], "another", ["wf_three"]);
    await writeSession(roots[1], "s", ["wf_four"]);
    await Effect.runPromise(index.scan);
    expect(index.errors).toEqual([]);
    expect(index.sessions.list()).toHaveLength(3);
    const key = runKey(roots[0], "p", "s", "session");
    const get = () => index.sessions.list().find((s) => s.key === key)!;
    expect(get().runKeys).toHaveLength(2);
    expect(get().usage.requests).toBe(3);
    expect(get().usage.total).toBe(210);
    expect(get().workflowUsage.total).toBe(110);
    expect(get().warnings).toEqual([]);
    const before = get().indexed;
    await appendFile(
      session + ".jsonl",
      lines({ type: "custom-title", customTitle: "Renamed after completion", sessionId: "s" }),
    );
    await appendFile(
      join(session, "subagents", "agent-other.jsonl"),
      lines(response("other-new", 40, 2)),
    );
    await Effect.runPromise(index.scan);
    expect(get().name).toBe("Renamed after completion");
    expect(get().usage.total).toBe(260);
    expect(get().indexed).toBeGreaterThanOrEqual(before);
    expect(index.get(runKey(roots[0], "p", "s", "wf_one"))!.sessionInfo?.name).toBe(
      "Renamed after completion",
    );
    // Removing a configured root must stop discovery while retaining its last snapshot.
    index.roots.splice(0, 1);
    await appendFile(
      session + ".jsonl",
      lines({ type: "custom-title", customTitle: "Not watched", sessionId: "s" }),
    );
    await Effect.runPromise(index.scan);
    expect(get().name).toBe("Renamed after completion");
    expect(index.sessions.list()).toHaveLength(3);
    await rm(roots[0], { recursive: true });
    expect(get().usage.total).toBe(260);
    // Stored session accounting survives a companion restart.
    index.db.close();
    const reopened = new Indexer(roots, data, catalog);
    expect(reopened.sessions.list().find((s) => s.key === key)?.usage.total).toBe(260);
    reopened.db.close();
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing parent/agent evidence and unpriced cache rates remain explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-session-gaps-"));
  const root = join(dir, "claude");
  const data = join(dir, "data");
  await mkdir(data);
  const index = new Indexer([root], data, catalog);
  try {
    const session = join(root, "projects", "p", "s");
    const live = join(session, "subagents", "workflows", "wf_gap");
    await mkdir(live, { recursive: true });
    await writeFile(join(live, "agent-a.jsonl"), lines(response("known", 10)) + "malformed\n");
    await mkdir(join(session, "workflows"));
    await writeFile(
      join(session, "workflows", "wf_gap.json"),
      JSON.stringify({
        status: "completed",
        workflowProgress: [{ type: "workflow_agent", agentId: "missing" }],
      }),
    );
    await Effect.runPromise(index.scan);
    const s = index.sessions.list()[0];
    expect(s.name).toBeNull();
    expect(s.usage.requests).toBe(1);
    expect(s.warnings.join(" ")).toContain("No parent conversation usage");
    expect(s.warnings.join(" ")).toContain("1 agents have no recorded");
    expect(s.warnings.join(" ")).toContain("transcript files unavailable");
    expect(s.warnings.join(" ")).toContain("malformed");
    const unpriced = sessionUsage(
      [
        {
          kind: "parent",
          messages: {
            parent: {
              model: "gpt-fixture",
              usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 20,
                cache_creation: { ephemeral_1h_input_tokens: 20 },
              },
            },
          },
        },
      ],
      "s",
      catalog,
    );
    expect(unpriced.usage.requests).toBe(1);
    expect(unpriced.usage.pricedRequests).toBe(0);
    expect(unpriced.usage.unpricedTokens).toBe(120);
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conflicting copied request usage with no ordering stays excluded until a later correction", () => {
  const parts: Parameters<typeof sessionUsage>[0] = [
    { kind: "workflow", messages: { repeated: row(100, 1) } },
    { kind: "workflow", messages: { repeated: row(10, 1) } },
  ];
  const a = sessionUsage(parts, "s", catalog);
  expect(a.conflictingRequests).toBe(1);
  expect(a.usage.requests).toBe(0);
  expect(sessionUsage([...parts].reverse(), "s", catalog).usage).toEqual(a.usage);
  parts.push({ kind: "workflow", messages: { repeated: row(20, 2) } });
  const corrected = sessionUsage(parts, "s", catalog);
  expect(corrected.conflictingRequests).toBe(0);
  expect(corrected.usage.total).toBe(30);
});
