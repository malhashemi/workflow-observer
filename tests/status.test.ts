import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { Indexer, runKey } from "../src/indexer";
import { Catalog } from "../src/catalog";
import { agentState, isFinishedRun, stateOf, workflowStatus } from "../src/status";
import type { RecordData } from "../src/types";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const failure = (timestamp = new Date().toISOString()) => ({
  type: "assistant",
  timestamp,
  isApiErrorMessage: true,
  error: "invalid_request",
  message: {
    id: "synthetic",
    model: "<synthetic>",
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text: "Prompt is too long" }],
  },
});
const response = (timestamp = new Date().toISOString()) => ({
  type: "assistant",
  timestamp,
  message: {
    id: "response",
    model: "fixture",
    usage: { input_tokens: 10, output_tokens: 1 },
    content: [{ type: "text", text: "Response after retry" }],
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "observer-status-"));
  const root = join(dir, "claude"),
    data = join(dir, "data");
  const session = join(root, "projects", "p", "s");
  const live = join(session, "subagents", "workflows", "wf_test");
  await mkdir(live, { recursive: true });
  await mkdir(data);
  await mkdir(join(session, "workflows"));
  await writeFile(session + ".jsonl", line({ type: "user", cwd: dir }));
  await writeFile(
    join(live, "agent-a.meta.json"),
    line({ description: "Exact worker", workflowPhase: "Repair", model: "fixture" }),
  );
  const agent = join(live, "agent-a.jsonl"),
    journal = join(live, "journal.jsonl");
  const final = join(session, "workflows", "wf_test.json");
  const index = new Indexer([root], data, new Catalog(data));
  const key = runKey(root, "p", "s", "wf_test");
  return {
    root,
    index,
    key,
    live,
    agent,
    journal,
    final,
    scan: async () => {
      await Effect.runPromise(index.scan);
      expect(index.errors).toEqual([]);
      return index.get(key)!;
    },
    close: async () => {
      index.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("journal failures and API failures independently survive absent or incomplete final progress", async () => {
  for (const source of ["journal", "transcript"]) {
    const f = await fixture();
    try {
      await writeFile(
        f.agent,
        line(
          source === "transcript"
            ? failure()
            : { type: "user", timestamp: new Date().toISOString(), message: { content: "Task" } },
        ),
      );
      await writeFile(
        f.journal,
        line({ type: "started", agentId: "a", phase: "Repair" }) +
          (source === "journal" ? line({ type: "failed", agentId: "a" }) : ""),
      );
      let r = await f.scan();
      expect(r.state, source).toBe("failed");
      expect(r.agents[0].state).toBe("failed");
      expect(r.executionState).toBeNull();
      expect(r.agents[0].events).toEqual([]);
      expect(r.usage.requests).toBe(0);
      expect(f.index.list()[0].state).toBe("failed");
      await writeFile(
        f.final,
        line({
          status: "completed",
          result: { status: "incomplete", reason: "Required worker did not complete" },
          workflowProgress: [],
        }),
      );
      r = await f.scan();
      expect(r.state).toBe("failed");
      expect(r.agents[0].state).toBe("failed");
      expect(r.executionState).toBe("completed");
      expect(r.outcome).toEqual({
        status: "incomplete",
        reason: "Required worker did not complete",
      });
    } finally {
      await f.close();
    }
  }
});

test("a running sibling keeps execution live while the failed agent stays failed", async () => {
  const f = await fixture();
  try {
    await writeFile(f.agent, line(failure()));
    await writeFile(join(f.live, "agent-b.jsonl"), line(response()));
    const r = await f.scan();
    expect(r.state).toBe("running");
    expect(r.agents.find((a) => a.id === "a")?.state).toBe("failed");
    expect(r.agents.find((a) => a.id === "b")?.state).toBe("running");
    expect(f.index.list()[0].activeAgents).toBe(1);
  } finally {
    await f.close();
  }
});

test("successful retries clear transient API errors and later journal transitions supersede earlier ones", async () => {
  const f = await fixture();
  try {
    await writeFile(f.agent, line(failure()));
    expect((await f.scan()).agents[0].state).toBe("failed");
    await appendFile(f.agent, line(response()));
    expect((await f.scan()).agents[0].state).toBe("running");
    await writeFile(
      f.journal,
      line({ type: "failed", agentId: "a" }) +
        line({ type: "result", agentId: "a", result: "Recovered" }),
    );
    await writeFile(f.final, line({ status: "completed", result: { status: "verified" } }));
    let r = await f.scan();
    expect(r.state).toBe("finished");
    expect(r.agents[0].state).toBe("completed");
    await appendFile(f.journal, line({ type: "failed", agentId: "a" }));
    await writeFile(f.final, line({ status: "completed", result: { status: "incomplete" } }));
    r = await f.scan();
    expect(r.state).toBe("failed");
    expect(r.agents[0].state).toBe("failed");
  } finally {
    await f.close();
  }
});

test("workflow-owned status strings are displayed exactly and never interpreted as execution outcomes", () => {
  for (const status of [
    "incomplete",
    "needs_decision",
    "needs_replan",
    "owner_verification",
    "blocked",
    "partial",
    "failed",
    "error",
    "verified",
    "success",
    "completed",
    "CUSTOM Status",
  ]) {
    const reported = { status, reason: "Workflow-specific meaning" };
    const finished = workflowStatus("completed", reported, []);
    expect(finished.state, status).toBe("finished");
    expect(finished.outcome).toEqual(reported);
    expect(isFinishedRun(finished)).toBe(true);
    expect(workflowStatus("completed", reported, [{ state: "failed" }]).state).toBe("failed");
  }
  expect(workflowStatus("completed", null, [{ state: "failed" }]).state).toBe("failed");
  expect(workflowStatus("completed", null, []).state).toBe("finished");
  expect(workflowStatus("failed", { status: "verified" }, []).state).toBe("failed");
  expect(workflowStatus("cancelled", { status: "verified" }, []).state).toBe("interrupted");
  expect(workflowStatus("completed", { nested: { status: "failed" } }, []).outcome).toBeNull();
  expect(workflowStatus("completed", "success", []).outcome).toBeNull();
  expect(isFinishedRun(workflowStatus(null, null, [{ state: "failed" }]))).toBe(false);
  expect(isFinishedRun(workflowStatus("completed", null, [{ state: "failed" }]))).toBe(true);
  expect(stateOf("future_status")).toBe("quiet");
});

test("terminal evidence respects recorded ordering; old activity does not remain running forever", () => {
  const input = {
    progress: {},
    journal: [],
    transcript: null,
    modified: 0,
    finalState: null,
    now: 1_000_000,
  };
  expect(
    agentState({ ...input, transcript: { runtimeState: { state: "failed", time: 100 } } }),
  ).toBe("failed");
  expect(
    agentState({ ...input, transcript: { runtimeState: { state: "running", time: 100 } } }),
  ).toBe("quiet");
  expect(
    agentState({
      ...input,
      progress: { state: "done", lastProgressAt: 300 },
      transcript: { runtimeState: { state: "failed", time: 200 } },
    }),
  ).toBe("completed");
  expect(
    agentState({
      ...input,
      progress: { state: "done", lastProgressAt: 200 },
      transcript: { runtimeState: { state: "failed", time: 300 } },
    }),
  ).toBe("failed");
  expect(
    agentState({
      ...input,
      progress: { state: "error", lastProgressAt: 200 },
      journal: [{ type: "result", time: 300 }],
    }),
  ).toBe("completed");
  expect(agentState({ ...input, progress: { state: "cancelled" }, finalState: "completed" })).toBe(
    "interrupted",
  );
});

test("tool errors and error-like text are not terminal API failures", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.agent,
      [
        {
          ...response(),
          message: {
            ...response().message,
            content: [
              { type: "text", text: "An example error: Prompt is too long" },
              { type: "tool_use", id: "tool", name: "Bash", input: { command: "false" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool",
                is_error: true,
                content: "Expected negative test",
              },
            ],
          },
        },
      ]
        .map(line)
        .join(""),
    );
    let r = await f.scan();
    expect(r.agents[0].state).toBe("running");
    expect(r.agents[0].events[0].error).toBe(true);
    await writeFile(f.final, line({ status: "completed" }));
    r = await f.scan();
    expect(r.state).toBe("finished");
  } finally {
    await f.close();
  }
});

test("deleted transcript failure evidence is not reused after invalidation or recreation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.agent, line(failure()));
    expect((await f.scan()).state).toBe("failed");
    const before = f.index.evidenceGeneration;
    await rm(f.agent);
    let r = await f.scan();
    expect(r.state).toBe("quiet");
    expect(r.agents[0].state).toBe("quiet");
    expect(r.agents[0].availability).toBe("missing");
    expect(JSON.stringify(r)).not.toContain("Prompt is too long");
    expect(f.index.evidenceGeneration).toBeGreaterThan(before);
    await writeFile(f.agent, line(response()));
    r = await f.scan();
    expect(r.state).toBe("running");
    expect(r.usage.total).toBe(11);
  } finally {
    await f.close();
  }
});

test("unwatched legacy history gets corrected from frozen evidence without ingesting appended responses", async () => {
  const f = await fixture();
  try {
    await writeFile(f.agent, line(failure()));
    await writeFile(f.journal, line({ type: "failed", agentId: "a" }));
    await writeFile(
      f.final,
      line({ status: "completed", result: { status: "incomplete", reason: "Worker failed" } }),
    );
    const old: RecordData = await f.scan();
    delete old.executionState;
    delete old.outcome;
    old.state = "completed";
    old.agents[0].state = "completed";
    f.index.db.query("UPDATE runs SET data=? WHERE key=?").run(JSON.stringify(old), f.key);
    f.index.roots.splice(0);
    await appendFile(f.agent, line(response()));
    const r = await f.scan();
    expect(r.state).toBe("failed");
    expect(r.agents[0].state).toBe("failed");
    expect(r.executionState).toBe("completed");
    expect(r.outcome?.status).toBe("incomplete");
    expect(r.usage.requests).toBe(0);
  } finally {
    await f.close();
  }
});

test("frozen current history preserves final progress resolution without reading appended failures", async () => {
  const f = await fixture();
  try {
    await writeFile(f.agent, line(failure()));
    await writeFile(
      f.final,
      line({
        status: "completed",
        result: { status: "verified" },
        workflowProgress: [{ type: "workflow_agent", agentId: "a", state: "done" }],
      }),
    );
    expect((await f.scan()).agents[0].state).toBe("completed");
    f.index.roots.splice(0);
    await appendFile(f.agent, line(failure()));
    const r = await f.scan();
    expect(r.state).toBe("finished");
    expect(r.agents[0].state).toBe("completed");
    expect(r.executionState).toBe("completed");
  } finally {
    await f.close();
  }
});
