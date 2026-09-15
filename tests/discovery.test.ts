import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Catalog } from "../src/catalog";
import { Indexer, runKey } from "../src/indexer";

test("discovers multiple roots, honors metadata, follows dynamic agents, and preserves finished history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-index-"));
  const roots = [join(dir, "claude"), join(dir, "mixed")];
  const data = join(dir, "data");
  await mkdir(data);
  const catalog = new Catalog(data);
  const index = new Indexer(roots, data, catalog);
  try {
    for (const root of roots) {
      const session = join(root, "projects", "p", "s");
      const live = join(session, "subagents", "workflows", "wf_test");
      await mkdir(live, { recursive: true });
      await writeFile(session + ".jsonl", JSON.stringify({ cwd: dir, type: "user" }) + "\n");
      await writeFile(
        join(live, "journal.jsonl"),
        '{"type":"started","agentId":"a1","label":"journal label","phase":"Dynamic"}\n',
      );
      await writeFile(
        join(live, "agent-a1.meta.json"),
        JSON.stringify({
          description: "exact:name",
          workflowPhase: "Runtime phase",
          model: "gpt-fixture",
        }),
      );
      await writeFile(
        join(live, "agent-a1.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: {
            id: "m1",
            model: "gpt-fixture",
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        }) + "\n",
      );
    }
    await Effect.runPromise(index.scan);
    expect(index.list().length).toBe(2);
    expect(index.errors).toEqual([]);
    const key = runKey(roots[0], "p", "s", "wf_test");
    const r = index.get(key)!;
    expect(r.agents[0].label).toBe("exact:name");
    expect(r.agents[0].phase).toBe("Runtime phase");
    expect(r.agents[0].model).toBe("gpt-fixture");
    expect(r.state).toBe("running");
    const final = join(roots[0], "projects", "p", "s", "workflows");
    await mkdir(final);
    await writeFile(
      join(final, "wf_test.json"),
      JSON.stringify({
        runId: "wf_test",
        status: "completed",
        workflowName: "Finished fixture",
        durationMs: 1200,
        workflowProgress: [],
      }),
    );
    await Effect.runPromise(index.scan);
    expect(index.get(key)!.state).toBe("finished");
    await rm(roots[0], { recursive: true });
    await Effect.runPromise(index.scan);
    expect(index.get(key)!.name).toBe("Finished fixture");
    expect(index.sources[0].state).toBe("unavailable");
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed runs retain future source plans and reprice sessions after an alias config change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-plan-alias-"));
  const root = join(dir, "claude");
  const data = join(dir, "data");
  const session = join(root, "projects", "p", "s");
  const live = join(session, "subagents", "workflows", "wf_test");
  await mkdir(live, { recursive: true });
  await mkdir(join(session, "workflows"));
  await mkdir(data);
  const catalog = new Catalog(data);
  catalog.providers = {
    xai: {
      models: {
        "grok-fixture": {
          id: "grok-fixture",
          limit: { context: 1000000 },
          cost: { input: 2, output: 6 },
        },
      },
    },
  } as any;
  const index = new Indexer([root], data, catalog);
  const response = (id: string) =>
    JSON.stringify({
      type: "assistant",
      sessionId: "s",
      timestamp: new Date().toISOString(),
      message: {
        id,
        model: "grok-fixture-build",
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    }) + "\n";
  try {
    await writeFile(session + ".jsonl", response("parent"));
    await writeFile(join(live, "agent-a.jsonl"), response("agent"));
    await writeFile(
      join(live, "agent-a.meta.json"),
      JSON.stringify({
        description: "actual",
        workflowPhase: "Build",
        model: "grok-fixture-build",
      }),
    );
    await writeFile(
      join(session, "workflows", "wf_test.json"),
      JSON.stringify({
        status: "completed",
        phases: [{ title: "Build" }, { title: "Future" }],
        script: `export const meta = {name:'fixture',phases:[{title:'Build'},{title:'Future'},{title:'Fix'}]};
        phase('Build'); await agent('build',{label:'planned',model:'grok-fixture-build'});
        phase('Future'); await agent('future',{label:'future',model:'gpt-fixture'});
        phase('Fix'); if(args.repair) await agent('repair',{label:'fix',model:'grok-fixture-build'});`,
      }),
    );
    await Effect.runPromise(index.scan);
    const key = runKey(root, "p", "s", "wf_test");
    const run = index.get(key)!;
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0].label).toBe("actual");
    expect(run.phases.find((p) => p.title === "Future")?.plannedModels).toEqual(["gpt-fixture"]);
    expect(run.phases.find((p) => p.title === "Fix")?.conditional).toBe(true);
    expect(run.usage.pricedRequests).toBe(0);
    const catalogTime = catalog.updated;
    catalog.aliases = { "grok-fixture-build": "xai/grok-fixture" };
    await Effect.runPromise(index.scan);
    expect(catalog.updated).toBe(catalogTime);
    expect(index.get(key)!.usage.cost).toBeCloseTo(0.0026, 10);
    const summary = index.sessions.list()[0];
    expect(summary.usage.requests).toBe(2);
    expect(summary.usage.pricedRequests).toBe(2);
    expect(summary.parentUsage.cost).toBeCloseTo(0.0026, 10);
    expect(summary.workflowUsage.cost).toBeCloseTo(0.0026, 10);
    catalog.aliases = {};
    await Effect.runPromise(index.scan);
    expect(index.get(key)!.usage.pricedRequests).toBe(0);
    expect(index.sessions.list()[0].usage.pricedRequests).toBe(0);
  } finally {
    index.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
