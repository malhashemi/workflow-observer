import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Catalog } from "../src/catalog";
import { Indexer, runKey } from "../src/indexer";
const line = (value: unknown) => JSON.stringify(value) + "\n";
async function fixture(age = 0) {
  const dir = await mkdtemp(join(tmpdir(), "observer-availability-"));
  const root = join(dir, "claude"),
    data = join(dir, "data"),
    session = join(root, "projects", "p", "s");
  const live = join(session, "subagents", "workflows", "wf_test");
  const agent = join(live, "agent-a.jsonl"),
    other = join(session, "subagents", "agent-b.jsonl"),
    parent = session + ".jsonl";
  await mkdir(live, { recursive: true });
  await mkdir(data);
  await mkdir(join(session, "workflows"));
  const timestamp = new Date(Date.now() - age * 86400000).toISOString();
  const response = (id: string, n: number) =>
    line({
      type: "assistant",
      sessionId: "s",
      timestamp,
      message: {
        id,
        model: "gpt-fixture",
        usage: { input_tokens: n, output_tokens: 0 },
        content: [{ type: "text", text: "secret-" + id }],
      },
    });
  await writeFile(
    parent,
    line({ type: "custom-title", sessionId: "s", customTitle: "private parent name" }) +
      response("parent", 100),
  );
  await writeFile(
    agent,
    line({ type: "user", message: { content: "secret task" } }) + response("agent", 50),
  );
  await writeFile(other, response("other", 25));
  await writeFile(
    join(live, "agent-a.meta.json"),
    JSON.stringify({
      description: "Worker identity",
      workflowPhase: "Build",
      model: "gpt-fixture",
    }),
  );
  await writeFile(
    join(session, "workflows", "wf_test.json"),
    JSON.stringify({
      status: "completed",
      timestamp,
      workflowName: "Run identity",
      workflowProgress: [{ type: "workflow_agent", agentId: "a", promptPreview: "secret task" }],
    }),
  );
  for (const path of [
    parent,
    agent,
    other,
    join(live, "agent-a.meta.json"),
    join(session, "workflows", "wf_test.json"),
  ])
    await utimes(path, new Date(timestamp), new Date(timestamp));
  const catalog = new Catalog(data);
  catalog.providers = {
    openai: {
      models: {
        "gpt-fixture": {
          id: "gpt-fixture",
          cost: { input: 1, output: 2 },
          limit: { context: 100000 },
        },
      },
    },
  } as any;
  const index = new Indexer([root], data, catalog),
    key = runKey(root, "p", "s", "wf_test");
  return {
    root,
    dir,
    data,
    parent,
    agent,
    other,
    index,
    key,
    response,
    close: async () => {
      index.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("deleting agent and parent transcripts removes cached content and usage from run/session views", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.index.scan);
    const before = f.index.get(f.key)!;
    expect(before.agents[0].task).toBe("secret task");
    expect(f.index.sessions.list()[0].usage.total).toBe(175);
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.000175, 10);
    const generation = f.index.evidenceGeneration;
    await rm(f.agent);
    await Effect.runPromise(f.index.scan);
    const current = f.index.get(f.key)!;
    expect(f.index.evidenceGeneration).toBeGreaterThan(generation);
    expect(current.usage.total).toBe(0);
    expect(current.agents[0]).toMatchObject({
      id: "a",
      label: "Worker identity",
      availability: "missing",
      task: "",
      latestText: "",
      events: [],
      result: null,
    });
    expect(f.index.sessions.list()[0].usage.total).toBe(125);
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.000125, 10);
    expect(f.index.sessions.list()[0].warnings.join(" ")).toContain("usage is excluded");
    expect(current.modified).toBe(before.modified);
    expect(JSON.stringify(current)).not.toContain("secret task");
    expect(
      f.index.db.query("SELECT state FROM transcript_evidence WHERE path=?").get(f.agent),
    ).toEqual({ state: null });
    await rm(f.parent);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.sessionInfo?.name).toBeNull();
    expect(f.index.sessions.list()[0].usage.total).toBe(25);
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.000025, 10);
    expect(f.index.sessions.list()[0].name).toBeNull();
    expect(
      f.index.db.query("SELECT state FROM transcript_evidence WHERE path=?").get(f.parent),
    ).toEqual({ state: null });
    await writeFile(f.agent, f.response("new-agent", 10));
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.usage.total).toBe(10);
    expect(f.index.get(f.key)!.agents[0].latestText).toBe("secret-new-agent");
    expect(f.index.sessions.list()[0].usage.total).toBe(35);
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.000035, 10);
    expect(f.index.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("a missing parent and an unreadable agent invalidate independently", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.index.scan);
    await rm(f.parent);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.usage.total).toBe(50);
    expect(f.index.get(f.key)!.agents[0].task).toBe("secret task");
    expect(f.index.sessions.list()[0].usage.total).toBe(75);
    expect(f.index.sessions.list()[0].name).toBeNull();
    await rm(f.agent);
    await mkdir(f.agent);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.agents[0].availability).toBe("unreadable");
    expect(f.index.get(f.key)!.agents[0].task).toBe("");
    expect(f.index.sessions.list()[0].usage.total).toBe(25);
    expect(f.index.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("a disconnected configured profile keeps identities but clears all unavailable content and estimates", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.index.scan);
    await rm(f.root, { recursive: true });
    await Effect.runPromise(f.index.scan);
    const current = f.index.get(f.key)!;
    expect(current.name).toBe("Run identity");
    expect(current.agents[0].id).toBe("a");
    expect(current.usage.total).toBe(0);
    expect(JSON.stringify(current)).not.toContain("secret");
    expect(f.index.sessions.list()[0].usage.total).toBe(0);
    expect(f.index.sources[0].state).toBe("unavailable");
    expect(
      f.index.db
        .query("SELECT count(*) AS n FROM transcript_evidence WHERE state IS NOT NULL")
        .get(),
    ).toEqual({ n: 0 });
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.usage.total).toBe(0);
    expect(f.index.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
test("availability audits invalidate inactive window snapshots without reparsing old bodies", async () => {
  const f = await fixture(20);
  try {
    f.index.windows.touch(30);
    await Effect.runPromise(f.index.scan);
    expect(f.index.sessions.list(30)[0].usage.total).toBe(175);
    f.index.windows.touch(7);
    const stateBefore = f.index.db
      .query("SELECT state FROM transcript_evidence WHERE path=?")
      .get(f.parent);
    await rm(f.agent);
    await Effect.runPromise(f.index.scan);
    expect(f.index.list()).toEqual([]);
    expect(f.index.get(f.key)!.usage.total).toBe(0);
    expect(f.index.get(f.key)!.agents[0].task).toBe("");
    expect(f.index.get(f.key)!.phases).toEqual([]);
    expect(f.index.sessions.list(30)[0].usage.total).toBe(0);
    expect(
      f.index.db.query("SELECT state FROM transcript_evidence WHERE path=?").get(f.parent),
    ).toEqual(stateBefore);
    f.index.windows.touch(30);
    await Effect.runPromise(f.index.scan);
    expect(f.index.sessions.list(30)[0].usage.total).toBe(125);
  } finally {
    await f.close();
  }
});
test("parent-derived source plans are evicted from inactive run snapshots", async () => {
  const f = await fixture(20);
  try {
    const source = `export const meta = {phases:[{title:'secret-plan'}]};
      phase('secret-plan'); await agent('task',{label:'secret-label',model:'gpt-fixture'});`;
    await appendFile(
      f.parent,
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Workflow", id: "call", input: { script: source } }],
        },
      }) +
        line({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "call", content: "Run ID: wf_test" }],
          },
        }),
    );
    f.index.windows.touch(30);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.source).toBe(source);
    expect(JSON.stringify(f.index.get(f.key)!.phases)).toContain("secret-plan");
    f.index.windows.touch(7);
    await rm(f.parent);
    await Effect.runPromise(f.index.scan);
    const current = f.index.get(f.key)!;
    expect(current.source).toBe("");
    expect(current.phases).toEqual([]);
    expect(JSON.stringify(f.index.list(30))).not.toContain("secret-plan");
  } finally {
    await f.close();
  }
});
