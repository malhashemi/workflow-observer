import { test, expect } from "bun:test";
import { Effect, Scope, Exit } from "effect";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/settings";
import { Catalog } from "../src/catalog";
import { Indexer, runKey } from "../src/indexer";
import { defaultConfig } from "../src/config";

const run = Effect.runPromise;
const line = (value: unknown) => JSON.stringify(value) + "\n";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await Bun.sleep(5);
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "observer-settings-"));
  const root = join(dir, "claude"),
    data = join(dir, "data"),
    path = join(dir, "config.json");
  await mkdir(data);
  await mkdir(join(root, "projects"), { recursive: true });
  await writeFile(
    path,
    line({ ...defaultConfig, claudeDirectories: [root], modelAliases: { bridge: "xai/cheap" } }),
  );
  const settings = await run(Settings.open(path));
  const catalog = new Catalog(data);
  catalog.providers = {
    xai: {
      models: Object.fromEntries(
        [
          ["cheap", 1],
          ["medium", 5],
          ["expensive", 10],
        ].map(([id, input]) => [
          id,
          { id, limit: { context: 1000000 }, cost: { input, output: 0 } },
        ]),
      ),
    },
  } as any;
  const index = new Indexer([], data, catalog),
    scope = Effect.runSync(Scope.make());
  const response = (id: string, age = 0) =>
    line({
      type: "assistant",
      sessionId: "s",
      timestamp: new Date(Date.now() - age * 86400000).toISOString(),
      message: {
        id,
        model: "bridge",
        usage: { input_tokens: 1000, output_tokens: 0 },
        content: [{ type: "text", text: "saved-" + id }],
      },
    });
  const session = join(root, "projects", "p", "s"),
    live = join(session, "subagents", "workflows", "wf_test");
  const parent = session + ".jsonl",
    agent = join(live, "agent-a.jsonl"),
    other = join(session, "subagents", "agent-other.jsonl");
  await mkdir(live, { recursive: true });
  await mkdir(join(session, "workflows"));
  await writeFile(
    parent,
    line({ type: "custom-title", sessionId: "s", customTitle: "Saved name" }) + response("parent"),
  );
  await writeFile(agent, response("agent"));
  await writeFile(other, response("other"));
  await writeFile(
    join(live, "journal.jsonl"),
    line({ type: "started", agentId: "a", label: "Worker", phase: "Build" }),
  );
  await writeFile(
    join(session, "workflows", "wf_test.json"),
    line({ status: "completed", workflowName: "Original" }),
  );
  const key = runKey(root, "p", "s", "wf_test");
  return {
    dir,
    root,
    data,
    path,
    settings,
    catalog,
    index,
    scope,
    parent,
    agent,
    other,
    session,
    live,
    key,
    response,
    start: () =>
      run(
        settings
          .start({ index, catalog, boundPort: 4319 }, { pollInterval: 0, refreshCatalog: false })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      ),
    settled: async () => {
      await until(() =>
        Object.values(settings.getSnapshot().windows).every(
          (w) => !["queued", "updating"].includes(w.state),
        ),
      );
    },
    close: async () => {
      await run(Scope.close(scope, Exit.void));
      index.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("settings acknowledges durable saves during a pass, fixes inputs, and coalesces the latest follow-up", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  try {
    await f.start();
    const previous = f.settings.getSnapshot();
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.001, 10);
    const original = f.index.transcripts.readCurrent.bind(f.index.transcripts);
    let paused = false;
    f.index.transcripts.readCurrent = (ref) =>
      original(ref).pipe(
        Effect.tap(() =>
          Effect.promise(async () => {
            if (ref.path === f.agent && !paused) {
              paused = true;
              entered.resolve();
              await release.promise;
            }
          }),
        ),
      );
    const passes: number[] = [];
    const scan = f.index.scanWith.bind(f.index);
    f.index.scanWith = (inputs) =>
      scan(inputs).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const cost = f.index.get(f.key)!.usage.cost;
            expect(f.index.sessions.list()[0].workflowUsage.cost).toBe(cost);
            passes.push(cost);
          }),
        ),
      );
    const ack = await run(
      f.settings.change({
        type: "set-alias",
        recorded: "bridge",
        target: "xai/expensive",
        previous: { recorded: "bridge", target: "xai/cheap" },
      }),
    );
    expect(JSON.parse(await readFile(f.path, "utf8")).modelAliases.bridge).toBe("xai/expensive");
    expect(ack.saved.revision).not.toBe(previous.saved.revision);
    expect(ack.windows[7].indexedTarget).toBe(previous.windows[7].indexedTarget);
    await entered.promise;
    const changed = await run(
      f.settings.change({
        type: "set-alias",
        recorded: "bridge",
        target: "xai/medium",
        previous: { recorded: "bridge", target: "xai/expensive" },
      }),
    );
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    await run(f.settings.refresh());
    await run(f.settings.refresh());
    expect(changed.effective!.aliases.bridge).toBe("xai/expensive");
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.001, 10);
    release.resolve();
    await f.settled();
    expect(passes).toEqual([0.01, 0.005]);
    const done = f.settings.getSnapshot();
    expect(done.windows[7].state).toBe("complete");
    expect(done.windows[7].indexedTarget).toBe(done.effective!.target);
    expect(done.effective!.roots).toEqual([]);
    const revision = f.settings.revision;
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    const latest = f.settings.getSnapshot().saved;
    await run(
      f.settings.replace({ ...latest.config, port: 4328, openBrowser: false }, latest.revision),
    );
    expect(f.settings.getSnapshot().restartRequired).toBe(true);
    expect(f.settings.getSnapshot().boundPort).toBe(4319);
    expect(f.settings.revision).toBe(revision);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("cooperating processes preserve unrelated edits and stale whole-file replacement conflicts", async () => {
  const f = await fixture();
  try {
    const stale = f.settings.getSnapshot().saved;
    const module = new URL("../src/settings.ts", import.meta.url).pathname;
    const effect = new URL("../node_modules/effect/dist/esm/index.js", import.meta.url).pathname;
    const script = `import {Settings} from ${JSON.stringify(module)}; import {Effect} from ${JSON.stringify(effect)};
      const [path,dir,id]=process.argv.slice(1); const s=await Effect.runPromise(Settings.open(path));
      await Bun.write(dir+'/ready-'+id,'1'); while(!await Bun.file(dir+'/go').exists()) await Bun.sleep(5);
      await Effect.runPromise(s.change(Number(id)%2 ? {type:'add-directory',path:dir+'/profile-'+id} : {type:'set-alias',recorded:'model-'+id,target:'xai/cheap'}));`;
    const children = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn([process.execPath, "-e", script, f.path, f.dir, String(i)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (let i = 0; i < 6; i++) {
      const deadline = Date.now() + 4000;
      while (!(await Bun.file(join(f.dir, "ready-" + i)).exists())) {
        if (Date.now() > deadline) throw new Error("Writer did not start");
        await Bun.sleep(5);
      }
    }
    await writeFile(join(f.dir, "go"), "1");
    for (const child of children) {
      const error = await new Response(child.stderr).text();
      expect(await child.exited, error).toBe(0);
    }
    await run(f.settings.poll);
    const saved = f.settings.getSnapshot().saved;
    expect(saved.config.claudeDirectories).toHaveLength(4);
    expect(Object.keys(saved.config.modelAliases!)).toHaveLength(4);
    await expect(run(f.settings.replace(stale.config, stale.revision))).rejects.toThrow(
      "Configuration changed",
    );
    await expect(run(f.settings.replace(saved.config, null))).rejects.toThrow("If-Match");
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.path + ".write-guard.sqlite")).mode & 0o777).toBe(0o600);
  } finally {
    await f.close();
  }
});

test("invalid or missing external config keeps effective settings and never recreates or overwrites the file", async () => {
  const f = await fixture();
  try {
    await f.start();
    const previous = f.settings.getSnapshot();
    await writeFile(f.path, "{broken");
    await run(f.settings.poll);
    expect(f.settings.getSnapshot().fileWarning).toContain("last valid settings");
    expect(f.settings.getSnapshot().effective).toEqual(previous.effective);
    await expect(
      run(f.settings.change({ type: "add-directory", path: "/extra" })),
    ).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe("{broken");
    await rm(f.path);
    await run(f.settings.poll);
    expect(await Bun.file(f.path).exists()).toBe(false);
    await writeFile(
      f.path,
      line({ ...previous.saved.config, modelAliases: { bridge: "xai/medium" } }),
    );
    await run(f.settings.poll);
    await f.settled();
    expect(f.settings.getSnapshot().fileWarning).toBeNull();
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.005, 10);
  } finally {
    await f.close();
  }
});

test("unwatched history reprices retained requests without discovering runs, agents, appends or renamed sessions", async () => {
  const f = await fixture();
  try {
    await f.start();
    const oldRun = f.index.get(f.key)!,
      oldSession = f.index.sessions.list()[0];
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    await f.settled();
    const oldState = f.index.db
      .query("SELECT path,stamp,offset,state FROM transcript_evidence ORDER BY path")
      .all();
    for (const path of [f.parent, f.agent, f.other])
      await appendFile(path, f.response("new-" + path));
    await appendFile(
      f.parent,
      line({ type: "custom-title", sessionId: "s", customTitle: "Unwatched rename" }),
    );
    await writeFile(join(f.live, "agent-new.jsonl"), f.response("new-agent"));
    await writeFile(join(f.session, "subagents", "agent-new.jsonl"), f.response("new-other"));
    await writeFile(
      join(f.session, "workflows", "wf_new.json"),
      line({ status: "completed", workflowName: "New" }),
    );
    await writeFile(
      join(f.session, "workflows", "wf_test.json"),
      line({ status: "completed", workflowName: "Changed" }),
    );
    await run(
      f.settings.change({
        type: "set-alias",
        recorded: "bridge",
        target: "xai/expensive",
        previous: { recorded: "bridge", target: "xai/cheap" },
      }),
    );
    await f.settled();
    const current = f.index.get(f.key)!,
      session = f.index.sessions.list()[0];
    expect(f.index.list()).toHaveLength(1);
    expect(current.agents).toHaveLength(1);
    expect(current.name).toBe(oldRun.name);
    expect(current.modified).toBe(oldRun.modified);
    expect(current.agents[0].latestText).toBe(oldRun.agents[0].latestText);
    expect(session.name).toBe(oldSession.name);
    expect(session.modified).toBe(oldSession.modified);
    expect(current.usage.cost).toBeCloseTo(0.01, 10);
    expect(session.usage.cost).toBeCloseTo(0.03, 10);
    expect(session.usage.requests).toBe(3);
    expect(
      f.index.db
        .query("SELECT path,stamp,offset,state FROM transcript_evidence ORDER BY path")
        .all(),
    ).toEqual(oldState);
    // Removing evidence is never a fallback to saved content or totals.
    await rm(f.agent);
    await run(f.settings.refresh());
    await f.settled();
    expect(f.index.get(f.key)!.usage.requests).toBe(0);
    expect(JSON.stringify(f.index.get(f.key)!)).not.toContain("saved-agent");
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.02, 10);
    expect(f.settings.getSnapshot().windows[7].state).toBe("partial");
    // Parser incompatibility cannot cause a reread of the remaining transcript.
    f.index.db
      .query("UPDATE transcript_evidence SET identity='obsolete' WHERE path=?")
      .run(f.parent);
    await run(f.settings.refresh());
    await f.settled();
    await run(f.settings.refresh());
    await f.settled();
    expect(f.index.sessions.list()[0].name).toBeNull();
    expect(f.index.sessions.list()[0].usage.cost).toBeCloseTo(0.01, 10);
    expect(f.index.sessions.list()[0].warnings.join(" ")).toContain(
      "No compatible retained evidence",
    );
    expect(
      f.index.db.query("SELECT state FROM transcript_evidence WHERE path=?").get(f.parent),
    ).toEqual({ state: null });
    await run(f.settings.change({ type: "add-directory", path: f.root }));
    await f.settled();
    expect(f.index.list()).toHaveLength(2);
    expect(f.index.sessions.list()[0].name).toBe("Unwatched rename");
  } finally {
    await f.close();
  }
});

test("frozen activity cannot pull old history into a narrower window; widening reprices known history", async () => {
  const f = await fixture();
  try {
    const age = new Date(Date.now() - 20 * 86400000);
    for (const path of [f.parent, f.agent, f.other]) {
      await writeFile(path, f.response(path, 20));
      await utimes(path, age, age);
    }
    for (const path of [
      join(f.live, "journal.jsonl"),
      join(f.session, "workflows", "wf_test.json"),
    ])
      await utimes(path, age, age);
    f.index.windows.touch(30);
    await f.start();
    const before = f.index.get(f.key)!;
    f.settings.demand(7, Date.now(), "default", 1);
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    await f.settled();
    await appendFile(f.agent, f.response("new"));
    await run(
      f.settings.change({
        type: "set-alias",
        recorded: "bridge",
        target: "xai/medium",
        previous: { recorded: "bridge", target: "xai/cheap" },
      }),
    );
    await f.settled();
    expect(f.index.list()).toHaveLength(0);
    expect(f.index.get(f.key)!.usage.cost).toBe(before.usage.cost);
    f.settings.demand(30, Date.now(), "default", 2);
    await f.settled();
    expect(f.index.list(30)).toHaveLength(1);
    expect(f.index.get(f.key)!.usage.requests).toBe(1);
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.005, 10);
    expect(f.index.get(f.key)!.modified).toBe(before.modified);
  } finally {
    await f.close();
  }
});

test("saved changes survive partial and failed updates; retries only claim success after a complete pass", async () => {
  const f = await fixture();
  try {
    await f.start();
    const completed = f.settings.getSnapshot().windows[7].indexedTarget;
    await run(f.settings.change({ type: "add-directory", path: join(f.dir, "missing") }));
    await f.settled();
    let snapshot = f.settings.getSnapshot();
    expect(snapshot.windows[7].state).toBe("partial");
    expect(snapshot.windows[7].indexedTarget).toBe(completed);
    expect(snapshot.windows[7].attempt!.errors.join(" ")).toContain("missing");
    const scan = f.index.scanWith.bind(f.index);
    f.index.scanWith = () => Effect.die(new Error("SQLite write failed"));
    const before = f.index.lastScan;
    await run(f.settings.refresh());
    await f.settled();
    snapshot = f.settings.getSnapshot();
    expect(snapshot.windows[7].state).toBe("failed");
    expect(snapshot.windows[7].attempt!.errors.join(" ")).toContain("SQLite write failed");
    expect(snapshot.saved.config.claudeDirectories).toHaveLength(2);
    expect(f.index.lastScan).toBeGreaterThan(before);
    f.index.scanWith = scan;
    await run(f.settings.change({ type: "remove-directory", path: join(f.dir, "missing") }));
    await f.settled();
    expect(f.settings.getSnapshot().windows[7].state).toBe("complete");
  } finally {
    await f.close();
  }
});

test("catalog candidates publish between passes; refresh failures retain the effective rates", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  try {
    await f.start();
    const original = f.index.scanWith.bind(f.index);
    f.index.scanWith = (inputs) =>
      Effect.promise(async () => {
        entered.resolve();
        await release.promise;
      }).pipe(Effect.zipRight(original(inputs)));
    await run(f.settings.refresh());
    await entered.promise;
    const candidate = f.catalog.snapshot();
    candidate.providers = {
      xai: {
        models: {
          cheap: { id: "cheap", limit: { context: 1000000 }, cost: { input: 9, output: 0 } },
        },
      },
    } as any;
    candidate.updated = "2026-09-15T12:00:00Z";
    f.catalog.prepare = Effect.succeed(candidate);
    await run(f.settings.refresh("catalog"));
    await until(() => f.settings.getSnapshot().catalog.state === "idle");
    expect(f.catalog.lookup("bridge")!.record.cost!.input).toBe(1);
    release.resolve();
    await f.settled();
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.009, 10);
    f.catalog.prepare = Effect.fail(
      new Error("Catalog disk write failed"),
    ) as typeof f.catalog.prepare;
    await run(f.settings.refresh("catalog"));
    await until(() => f.settings.getSnapshot().catalog.state === "failed");
    expect(f.settings.getSnapshot().catalog.error).toContain("disk write failed");
    expect(f.catalog.lookup("bridge")!.record.cost!.input).toBe(9);
    expect(f.index.get(f.key)!.usage.cost).toBeCloseTo(0.009, 10);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("catalog persistence failure never publishes fetched rates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-catalog-save-"));
  try {
    const candidate = {
      anthropic: { models: { fixture: { id: "fixture", cost: { input: 99, output: 0 } } } },
    } as any;
    const catalog = new Catalog(dir, {}, async () => candidate);
    const previous = catalog.fingerprint;
    await mkdir(join(dir, "models.json"));
    await expect(run(catalog.prepare)).rejects.toThrow();
    expect(catalog.fingerprint).toBe(previous);
    await rm(join(dir, "models.json"), { recursive: true });
    const prepared = await run(catalog.prepare);
    expect(catalog.fingerprint).toBe(previous);
    expect(JSON.parse(await readFile(join(dir, "models.json"), "utf8")).providers).toEqual(
      candidate,
    );
    catalog.publish(prepared);
    expect(catalog.providers).toEqual(candidate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deletion after retained reading cannot republish captured usage under the revoked revision", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  try {
    await f.start();
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    await f.settled();
    const original = f.index.transcripts.readRetained.bind(f.index.transcripts);
    let paused = false;
    f.index.transcripts.readRetained = (ref) =>
      original(ref).pipe(
        Effect.tap(() =>
          Effect.promise(async () => {
            if (ref.path === f.agent && !paused) {
              paused = true;
              entered.resolve();
              await release.promise;
            }
          }),
        ),
      );
    const revision = f.index.evidenceGeneration;
    await run(f.settings.refresh());
    await entered.promise;
    await rm(f.agent);
    release.resolve();
    await f.settled();
    expect(f.index.evidenceGeneration).toBeGreaterThan(revision);
    expect(f.index.get(f.key)!.usage.requests).toBe(0);
    expect(f.index.get(f.key)!.agents[0].availability).toBe("missing");
    expect(f.index.sessions.list()[0].workflowUsage.requests).toBe(0);
    expect(f.settings.getSnapshot().windows[7].state).toBe("partial");
  } finally {
    release.resolve();
    await f.close();
  }
});

test("persistent session listing failures stay partial on unchanged subsequent passes", async () => {
  const f = await fixture();
  try {
    await f.start();
    await rm(join(f.session, "subagents"), { recursive: true });
    await writeFile(join(f.session, "subagents"), "not a directory");
    for (let i = 0; i < 3; i++) {
      await run(f.settings.refresh());
      await f.settled();
      const window = f.settings.getSnapshot().windows[7];
      expect(window.state).toBe("partial");
      expect(window.attempt!.errors.join(" ")).toContain("agent directory could not be listed");
    }
  } finally {
    await f.close();
  }
});

test("completed targets and partial failures are scoped to each active date window", async () => {
  const f = await fixture();
  try {
    const age = new Date(Date.now() - 20 * 86400000);
    for (const path of [f.parent, f.agent, f.other]) {
      await writeFile(path, f.response(path, 20));
      await utimes(path, age, age);
    }
    for (const path of [
      join(f.live, "journal.jsonl"),
      join(f.session, "workflows", "wf_test.json"),
    ])
      await utimes(path, age, age);
    f.index.windows.touch(30, Date.now(), "wide");
    f.index.windows.touch(7, Date.now(), "narrow");
    await f.start();
    await run(f.settings.change({ type: "remove-directory", path: f.root }));
    await f.settled();
    await rm(f.agent);
    await run(
      f.settings.change({
        type: "set-alias",
        recorded: "bridge",
        target: "xai/medium",
        previous: { recorded: "bridge", target: "xai/cheap" },
      }),
    );
    await f.settled();
    let snapshot = f.settings.getSnapshot();
    expect(snapshot.windows[7].state).toBe("complete");
    expect(snapshot.windows[7].indexedTarget).toBe(snapshot.effective!.target);
    expect(snapshot.windows[30].state).toBe("partial");
    expect(snapshot.windows[30].indexedTarget).not.toBe(snapshot.effective!.target);
    // Readable replacements outside an active range also revoke stored evidence using metadata only.
    f.settings.demand(7, Date.now(), "wide", 1);
    await f.settled();
    const generation = f.index.evidenceGeneration;
    await rm(f.parent);
    await writeFile(f.parent, f.response("replacement"));
    await run(f.settings.refresh());
    await f.settled();
    expect(f.index.evidenceGeneration).toBeGreaterThan(generation);
    expect(
      f.index.db.query("SELECT state FROM transcript_evidence WHERE path=?").get(f.parent),
    ).toEqual({ state: null });
    f.settings.demand(30, Date.now(), "wide", 2);
    expect(f.index.get(f.key)!.sessionInfo?.name).toBeNull();
    await f.settled();
    snapshot = f.settings.getSnapshot();
    expect(snapshot.windows[30].state).toBe("partial");
  } finally {
    await f.close();
  }
});
