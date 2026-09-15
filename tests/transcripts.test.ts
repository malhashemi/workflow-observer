import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { mkdtemp, writeFile, appendFile, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcripts, type TranscriptRef } from "../src/transcripts";
import { summarizeUsage } from "../src/pricing";
import { Catalog } from "../src/catalog";
const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "observer-transcripts-"));
  const db = new Database(":memory:");
  const transcripts = new Transcripts(db);
  const path = join(dir, "agent-test.jsonl");
  const ref: TranscriptRef = { kind: "agent", path };
  return {
    dir,
    db,
    path,
    ref,
    transcripts,
    read: (target: TranscriptRef = ref) => Effect.runPromise(transcripts.readCurrent(target)),
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("transcript interface handles partial UTF8, malformed rows, truncation and replacement", async () => {
  const f = await fixture();
  const ref: TranscriptRef = { kind: "journal", path: f.path };
  try {
    await writeFile(f.path, '{"value":"first"}\n{"value":"cy');
    expect((await f.read(ref)).data?.entries).toEqual([{ value: "first" }]);
    await appendFile(f.path, 'an 🔵"}\nnot json\n');
    const current = await f.read(ref);
    expect(current.data?.entries).toEqual([{ value: "first" }, { value: "cyan 🔵" }]);
    expect(current.data?.parseErrors).toBe(1);
    expect((await f.read(ref)).data?.entries).toHaveLength(2);
    await writeFile(f.path, lines({ value: "new" }));
    expect((await f.read(ref)).data?.entries).toEqual([{ value: "new" }]);
    await writeFile(f.path + ".tmp", lines({ value: "replacement" }));
    await rename(f.path + ".tmp", f.path);
    expect((await f.read(ref)).data?.entries).toEqual([{ value: "replacement" }]);
  } finally {
    await f.close();
  }
});
test("inspect reads no transcript body; missing/unreadable sources delete payloads and reappear fresh", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, lines({ type: "user", message: { content: "private original task" } }));
    expect((await Effect.runPromise(f.transcripts.inspect(f.ref))).status).toBe("available");
    expect(f.db.query("SELECT state FROM transcript_evidence").get()).toEqual({ state: null });
    expect((await f.read()).data?.task).toBe("private original task");
    await rm(f.path);
    const missing = await f.read();
    expect(missing.status).toBe("missing");
    expect(missing.data).toBeNull();
    expect(f.db.query("SELECT state,offset FROM transcript_evidence").get()).toEqual({
      state: null,
      offset: null,
    });
    const audit = await Effect.runPromise(f.transcripts.inspect());
    expect(audit.generation).toBeGreaterThan(0);
    expect(audit.sources[0].status).toBe("missing");
    await writeFile(f.path, lines({ type: "user", message: { content: "new task after return" } }));
    expect((await f.read()).data?.task).toBe("new task after return");
    await rm(f.path);
    await mkdir(f.path);
    expect((await f.read()).status).toBe("unreadable");
    expect(f.db.query("SELECT state FROM transcript_evidence").get()).toEqual({ state: null });
  } finally {
    await f.close();
  }
});
test("parent identity and parser compatibility cannot reuse another interpretation; titles obey recorded precedence", async () => {
  const f = await fixture();
  const ref: TranscriptRef = { kind: "parent", path: f.path, session: "s" };
  try {
    await writeFile(f.path, lines({ type: "ai-title", aiTitle: "Generated", sessionId: "s" }));
    expect((await f.read(ref)).data?.title).toEqual({ name: "Generated", nameSource: "ai-title" });
    await appendFile(
      f.path,
      lines(
        { type: "custom-title", customTitle: "Mine", sessionId: "s" },
        { type: "custom-title", customTitle: "Foreign", sessionId: "other" },
        { type: "ai-title", aiTitle: "Later", sessionId: "s" },
      ),
    );
    expect((await f.read(ref)).data?.title).toEqual({ name: "Mine", nameSource: "custom-title" });
    await appendFile(
      f.path,
      lines({ type: "custom-title", customTitle: "Renamed", sessionId: "s" }),
    );
    expect((await f.read(ref)).data?.title.name).toBe("Renamed");
    expect((await f.read({ ...ref, session: "other" })).data?.title.name).toBe("Foreign");
    f.db.run(
      "UPDATE transcript_evidence SET identity='old-parser', state='{\"customTitle\":\"stale\"}'",
    );
    expect((await f.read(ref)).data?.title.name).toBe("Renamed");
    f.db.run("UPDATE transcript_evidence SET state='corrupt JSON'");
    expect((await f.read(ref)).data?.title.name).toBe("Renamed");
    f.db.run("UPDATE transcript_evidence SET state='{}'");
    expect((await f.read(ref)).data?.title.name).toBe("Renamed");
    await rm(f.path);
    expect((await f.read(ref)).data).toBeNull();
    expect(f.db.query("SELECT state FROM transcript_evidence").get()).toEqual({ state: null });
  } finally {
    await f.close();
  }
});
test("streaming corrections and tool results pass through the same transcript interface", async () => {
  const f = await fixture();
  const response = (usage: unknown) => ({
    type: "assistant",
    message: { id: "resp", model: "gpt-fixture", usage },
  });
  const tool = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: "x.ts", old_string: "const a=1", new_string: "const a=2" },
        },
      ],
    },
  };
  try {
    await writeFile(f.path, lines(response({ input_tokens: 25175, output_tokens: 0 }), tool, tool));
    const first = await f.read();
    expect(first.data?.events[0].edit.outcome).toBe("unknown");
    const correction = response({
      input_tokens: 2455,
      cache_read_input_tokens: 21504,
      cache_creation_input_tokens: 0,
      output_tokens: 194,
    });
    await appendFile(
      f.path,
      lines(correction, correction, correction, {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "edit", is_error: true, content: "Not found" },
          ],
        },
      }),
    );
    const current = await f.read();
    const usage = summarizeUsage(current.data!.messages, new Catalog("/unused"));
    expect(usage.requests).toBe(1);
    expect(usage.total).toBe(24153);
    expect(usage.peakContext).toBe(23959);
    expect(current.data?.toolCount).toBe(1);
    expect(current.data?.events).toHaveLength(1);
    expect(current.data?.events[0].edit).toMatchObject({ outcome: "failed", before: "const a=1" });
    expect(current.data?.events[0].output).toBe("Not found");
    const concurrent = await Promise.all([f.read(), f.read(), f.read()]);
    expect(concurrent.every((r) => r.data?.toolCount === 1)).toBe(true);
  } finally {
    await f.close();
  }
});
test("oversized partial lines stay discarded across append boundaries", async () => {
  const f = await fixture();
  const ref: TranscriptRef = { kind: "journal", path: f.path };
  try {
    await writeFile(f.path, "x".repeat(8 * 1024 * 1024 + 256 * 1024));
    expect((await f.read(ref)).data?.parseErrors).toBe(1);
    await appendFile(f.path, '{"mustNotBeParsed":true}\n' + lines({ valid: true }));
    const current = await f.read(ref);
    expect(current.data?.entries).toEqual([{ valid: true }]);
    expect(current.data?.parseErrors).toBe(1);
  } finally {
    await f.close();
  }
});
test("legacy migration drops payloads without parsing them and still audits missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-transcript-migration-"));
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE files (path TEXT, modified REAL, state TEXT)");
    db.query("INSERT INTO files VALUES (?,?,?)").run(
      join(dir, "agent-old.jsonl"),
      Date.now(),
      "deliberately invalid private payload",
    );
    const transcripts = new Transcripts(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='files'").get()).toBeNull();
    const result = await Effect.runPromise(transcripts.inspect());
    expect(result.sources[0].status).toBe("missing");
    expect(result.generation).toBeGreaterThan(0);
    expect(db.query("SELECT state FROM transcript_evidence").get()).toEqual({ state: null });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retained reads freeze evidence and cursor on append, reject incompatible sources, and never rebuild", async () => {
  const f = await fixture();
  const retained = () => Effect.runPromise(f.transcripts.readRetained(f.ref));
  try {
    await writeFile(f.path, lines({ type: "user", message: { content: "original" } }));
    expect((await retained()).retained).toBe("absent");
    expect((await retained()).data).toBeNull();
    const current = await f.read();
    const saved = f.db.query("SELECT offset,stamp,modified,state FROM transcript_evidence").get();
    await appendFile(f.path, lines({ type: "user", message: { content: "appended" } }));
    const frozen = await retained();
    expect(frozen.retained).toBe("compatible");
    expect(frozen.stamp).toBe(current.stamp);
    expect(frozen.modified).toBe(current.modified);
    expect(frozen.data).toEqual(current.data);
    expect(f.db.query("SELECT offset,stamp,modified,state FROM transcript_evidence").get()).toEqual(
      saved,
    );
    // A replacement cannot be trusted even when it contains valid JSON.
    await writeFile(f.path + ".next", lines({ type: "user", message: { content: "replacement" } }));
    await rename(f.path + ".next", f.path);
    const rejected = await retained();
    expect(rejected.status).toBe("available");
    expect(rejected.retained).toBe("incompatible");
    expect(rejected.data).toBeNull();
    expect(rejected.reason).toContain("No compatible retained evidence");
    const generation = (await Effect.runPromise(f.transcripts.inspect())).generation;
    expect((await retained()).data).toBeNull();
    expect((await Effect.runPromise(f.transcripts.inspect())).generation).toBe(generation);
    expect((await f.read()).data?.task).toBe("replacement");
    f.db.run("UPDATE transcript_evidence SET offset=size+1");
    expect((await retained()).data).toBeNull();
    await f.read();
    f.db.run("UPDATE transcript_evidence SET state=NULL");
    expect((await retained()).invalidated).toBe(true);
    expect((await retained()).invalidated).toBe(false);
    await f.read();
    await writeFile(f.path, "");
    expect((await retained()).data).toBeNull();
    await rm(f.path);
    expect((await retained()).status).toBe("missing");
    await mkdir(f.path);
    expect((await retained()).status).toBe("unreadable");
  } finally {
    await f.close();
  }
});

test("runtime status upgrades current evidence while old saved requests remain compatible", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.path,
      lines(
        {
          type: "assistant",
          timestamp: "2026-09-15T09:00:00Z",
          message: {
            id: "real",
            model: "fixture",
            usage: { input_tokens: 10 },
            content: [{ type: "text", text: "Working" }],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-09-15T09:01:00Z",
          isApiErrorMessage: true,
          error: "invalid_request",
          message: {
            id: "error",
            model: "<synthetic>",
            content: [{ type: "text", text: "Prompt is too long" }],
          },
        },
      ),
    );
    const initial = await f.read();
    const old = { ...initial.data };
    delete old.statusRevision;
    delete old.runtimeState;
    f.db
      .query("UPDATE transcript_evidence SET state=? WHERE path=?")
      .run(JSON.stringify(old), f.path);
    const retained = await Effect.runPromise(f.transcripts.readRetained(f.ref));
    expect(retained.retained).toBe("compatible");
    expect(retained.data?.messages.real.usage.input_tokens).toBe(10);
    expect(retained.data?.runtimeState).toBeUndefined();
    const current = await f.read();
    expect(current.data?.runtimeState).toEqual({
      state: "failed",
      time: Date.parse("2026-09-15T09:01:00Z"),
    });
    expect(current.data?.statusRevision).toBe(1);
    expect(current.data?.messages).toEqual(initial.data?.messages);
    expect((await f.read()).data?.runtimeState).toEqual(current.data?.runtimeState);
    // A late correction to an older response does not clear a more recent API error.
    await appendFile(
      f.path,
      lines({
        type: "assistant",
        timestamp: "2026-09-15T09:00:30Z",
        message: { id: "real", model: "fixture", usage: { input_tokens: 12 } },
      }),
    );
    expect((await f.read()).data?.runtimeState?.state).toBe("failed");
    await appendFile(
      f.path,
      lines({
        type: "assistant",
        timestamp: "2026-09-15T09:02:00Z",
        message: {
          id: "retry",
          model: "fixture",
          content: [{ type: "text", text: "Retry succeeded" }],
        },
      }),
    );
    expect((await f.read()).data?.runtimeState?.state).toBe("running");
  } finally {
    await f.close();
  }
});
