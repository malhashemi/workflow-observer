import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Catalog } from "../src/catalog";
import { Indexer, runKey } from "../src/indexer";

const source = (name: string, model: string) =>
  `export const meta = { name: '${name}', phases: [{title: 'Future'}] };
   phase('Future'); await agent('task', {label: 'Planned step', model: '${model}'});`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "observer-source-freshness-"));
  const root = join(dir, "claude");
  const data = join(dir, "data");
  const session = join(root, "projects", "p", "s");
  const scripts = join(session, "workflows", "scripts");
  const finalPath = join(session, "workflows", "wf_test.json");
  const sourcePath = join(scripts, "fixture-wf_test.js");
  await mkdir(scripts, { recursive: true });
  await mkdir(data);
  await writeFile(
    finalPath,
    JSON.stringify({ status: "completed", timestamp: new Date().toISOString() }),
  );
  const index = new Indexer([root], data, new Catalog(data));
  return {
    dir,
    finalPath,
    sourcePath,
    index,
    key: runKey(root, "p", "s", "wf_test"),
    close: async () => {
      index.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("completed fallback source edits refresh names and planned models without new workflow activity", async () => {
  const f = await fixture();
  try {
    await writeFile(f.sourcePath, source("First", "gpt-alpha"));
    await Effect.runPromise(f.index.scan);
    const before = f.index.get(f.key)!;
    expect(before.name).toBe("First");
    expect(before.phases[0].plannedModels).toEqual(["gpt-alpha"]);
    expect(before.sourcePath).toBe(f.sourcePath);

    // Keep the source the same size; its changed modification time must be enough.
    await writeFile(f.sourcePath, source("Other", "gpt-bravo"));
    const updated = new Date(Date.now() + 1000);
    await utimes(f.sourcePath, updated, updated);
    await Effect.runPromise(f.index.scan);
    const after = f.index.get(f.key)!;
    expect(after.name).toBe("Other");
    expect(after.phases[0].plannedModels).toEqual(["gpt-bravo"]);
    expect(f.index.list()[0].name).toBe("Other");
    expect(after.source).toContain("gpt-bravo");
    expect(after.modified).toBe(before.modified);
    expect(after.usage).toEqual(before.usage);
    expect(after.agents).toEqual([]);
    expect(after.sourceNote).toContain("Current source file");
    expect(f.index.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("fallback source creation and removal refresh the plan while recorded inline source keeps priority", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.source).toBe("");

    await writeFile(f.sourcePath, source("Appeared", "gpt-file"));
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.name).toBe("Appeared");
    expect(f.index.get(f.key)!.phases[0].plannedModels).toEqual(["gpt-file"]);

    await rm(f.sourcePath);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.source).toBe("");
    expect(f.index.get(f.key)!.name).toBe("wf_test");
    expect(f.index.get(f.key)!.phases).toEqual([]);

    await writeFile(
      f.finalPath,
      JSON.stringify({
        status: "completed",
        timestamp: new Date().toISOString(),
        script: source("Recorded", "gpt-inline"),
      }),
    );
    await writeFile(f.sourcePath, source("Fallback", "gpt-file"));
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.name).toBe("Recorded");
    expect(f.index.get(f.key)!.phases[0].plannedModels).toEqual(["gpt-inline"]);
    expect(f.index.get(f.key)!.sourceNote).toBe("Recorded inline workflow source.");
    expect(f.index.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("invoked shared workflow sources outside the project load plans with each run's recorded arguments", async () => {
  const f = await fixture();
  const path = join(f.dir, "shared-implementation.js");
  const parent = join(f.dir, "claude", "projects", "p", "s.jsonl");
  const source = `export const meta={name:'shared-implementation',phases:[{title:'Current'},{title:'Review'},{title:'Repair'}]};
    function normalize(input){const config={...input,limit:input.limit??3};config.unrelated=unknown();return config;}
    let config;config=normalize(args);
    async function ask(seat,group){return await agent('no execution',{label:seat.id,phase:group,...(seat.model?{model:seat.model}:{}),...(seat.effort?{effort:seat.effort}:{})});}
    phase('Current');await ask(config.builder,'Current');
    phase('Review');await parallel(config.reviewers.map(reviewer=>()=>ask(reviewer,'Review')));
    phase('Repair');if(runtimeFindings())await ask(config.fixer,'Repair');
    globalThis.__observerExecutedSource=true;throw new Error('Source must never run');`;
  const record = (model: string) =>
    [
      {
        type: "assistant",
        cwd: join(f.dir, "unrelated-project"),
        message: {
          content: [
            {
              type: "tool_use",
              name: "Workflow",
              id: "call",
              input: {
                scriptPath: path,
                args: {
                  builder: { id: "build", model: "gpt-build" },
                  reviewers: [
                    { id: "a", model },
                    { id: "b", model: "claude-review" },
                  ],
                  fixer: { id: "fix", model: "gpt-fix" },
                },
              },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call", content: "Run ID: wf_test" }],
        },
      },
    ]
      .map((r) => JSON.stringify(r) + "\n")
      .join("");
  try {
    await writeFile(path, source);
    await writeFile(parent, record("gpt-review"));
    await Effect.runPromise(f.index.scan);
    const before = f.index.get(f.key)!;
    expect(before.name).toBe("shared-implementation");
    expect(before.sourcePath).toBe(path);
    expect(before.phases.map((p) => p.title)).toEqual(["Current", "Review", "Repair"]);
    expect(before.phases[1].plannedModels).toEqual(["gpt-review", "claude-review"]);
    expect(before.phases[2].steps?.[0].optional).toBe(true);
    expect(before.sourceNote).toContain("recorded invocation arguments");
    expect((globalThis as any).__observerExecutedSource).toBeUndefined();
    await appendFile(parent, record("gpt-updated"));
    await Effect.runPromise(f.index.scan);
    const updated = f.index.get(f.key)!;
    expect(updated.phases[1].plannedModels).toEqual(["gpt-updated", "claude-review"]);
    expect(updated.modified).toBe(before.modified);
    expect(updated.usage).toEqual(before.usage);
    await rm(parent);
    await Effect.runPromise(f.index.scan);
    expect(f.index.get(f.key)!.source).toBe("");
    expect(f.index.get(f.key)!.phases).toEqual([]);
  } finally {
    await f.close();
  }
});

test("native default-model changes refresh inherited plans without adding agents or usage", async () => {
  const f = await fixture();
  const timestamp = new Date().toISOString();
  try {
    await writeFile(
      f.sourcePath,
      `export const meta={name:'defaults',phases:[{title:'Future'}]};
      phase('Future');await agent('');`,
    );
    const write = async (defaultModel?: string) => {
      await writeFile(
        f.finalPath,
        JSON.stringify({ status: "completed", timestamp, defaultModel }),
      );
      await Effect.runPromise(f.index.scan);
      expect(f.index.errors).toEqual([]);
      return f.index.get(f.key)!;
    };
    const before = await write();
    expect(before.phases[0].steps?.[0]).toMatchObject({ model: null, modelOrigin: "inherited" });
    const after = await write("native-default");
    expect(after.phases[0].plannedModels).toEqual(["native-default"]);
    expect(after.agents).toEqual([]);
    expect(after.usage).toEqual(before.usage);
    expect(after.modified).toBe(before.modified);
    expect((await write("changed-default")).phases[0].plannedModels).toEqual(["changed-default"]);
  } finally {
    await f.close();
  }
});
