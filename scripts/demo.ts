// Synthetic evidence for README screenshots and UI development. Never reads real Claude profiles.
import { mkdir, mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "observer-demo-"));
const profile = join(directory, "claude-demo");
const data = join(directory, "data");
const config = join(directory, "config.json");
const port = Number(process.env.OBSERVER_DEMO_PORT ?? 4329);
const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r) + "\n").join("");
const now = Date.now();
const iso = (time: number) => new Date(time).toISOString();
const phases = [
  { title: "Explore", detail: "Map the codebase and agree on the approach" },
  { title: "Build", detail: "Implement the changes in parallel" },
  { title: "Review", detail: "Independent checks of the implementation" },
  { title: "Verify", detail: "Run tests and confirm the acceptance criteria" },
];
const models = ["claude-sonnet-4-5", "gpt-5", "claude-opus-4-6"];
const heartbeats: { path: string; agentId: string }[] = [];
const response = (
  sessionId: string,
  id: string,
  model: string,
  time: number,
  input: number,
  output: number,
  text: string,
) => ({
  type: "assistant",
  sessionId,
  timestamp: iso(time),
  message: {
    id,
    model,
    usage: { input_tokens: input, output_tokens: output },
    content: [{ type: "text", text }],
  },
});

async function session(
  project: string,
  id: string,
  title: string,
  age: number,
  names: string[],
  active = false,
) {
  const path = join(profile, "projects", project, id);
  await mkdir(join(path, "workflows"), { recursive: true });
  const start = now - age;
  await writeFile(
    path + ".jsonl",
    lines(
      {
        type: "custom-title",
        customTitle: title,
        sessionId: id,
        cwd: `/workspace/${project}`,
        timestamp: iso(start),
      },
      response(
        id,
        `${id}-parent`,
        models[0],
        start,
        24000,
        4300,
        "Plan the work, delegate the implementation, and verify the recorded results.",
      ),
    ),
  );
  for (const [r, name] of names.entries()) {
    const runId = `wf_demo-${id}-${r + 1}`;
    const live = join(path, "subagents", "workflows", runId);
    await mkdir(live, { recursive: true });
    const running = active && r === 0;
    const source = `export const meta = ${JSON.stringify({ name, description: "Explore, implement and verify changes with a coordinated team of agents.", phases }, null, 2)};
phase('Explore');
await agent('Map the affected code and propose an implementation plan.', { label: 'Codebase explorer', model: '${models[0]}' });
phase('Build');
await parallel([
  () => agent('Implement the API with validation and focused tests.', { label: 'API implementation', model: '${models[1]}' }),
  () => agent('Build the interface and check keyboard and mobile behavior.', { label: 'Interface implementation', model: '${models[0]}' })
]);
phase('Review');
await agent('Review correctness, edge cases and acceptance evidence.', { label: 'Independent reviewer', model: '${models[2]}' });
phase('Verify');
if (args.verify) await agent('Run the final checks and summarize the evidence.', { label: 'Verification', model: '${models[0]}' });`;
    const workers = [
      { label: "Codebase explorer", phase: "Explore", model: models[0] },
      { label: "API implementation", phase: "Build", model: models[1] },
      { label: "Interface implementation", phase: "Build", model: models[0] },
      { label: "Independent reviewer", phase: "Review", model: models[2] },
      { label: "Verification", phase: "Verify", model: models[0] },
    ].slice(0, running ? 3 : 5);
    const journal: unknown[] = [];
    for (const [i, worker] of workers.entries()) {
      const agentId = `${id}-${r}-${i}`;
      const time = start + r * 60_000 + i * 40_000;
      const inProgress = running && i > 0;
      await writeFile(
        join(live, `agent-${agentId}.meta.json`),
        JSON.stringify({
          description: worker.label,
          workflowPhase: worker.phase,
          model: worker.model,
        }),
      );
      const prompt = `${worker.label}\n\nDeliver the ${name.toLowerCase()} changes. Keep the public interface stable, cover the changed behavior with focused tests, and report any remaining issues.\n\nAcceptance criteria\n- Validate inputs at the API boundary.\n- Keep the layout usable on narrow screens.\n- Preserve existing behavior outside this change.`;
      const records = [
        { type: "user", sessionId: id, timestamp: iso(time), message: { content: prompt } },
        response(
          id,
          `${agentId}-1`,
          worker.model,
          time + 10000,
          34000 + i * 6200,
          4600 + i * 800,
          "The implementation is in place. I am checking the behavior against the acceptance criteria.",
        ),
        {
          type: "assistant",
          sessionId: id,
          timestamp: iso(time + 12000),
          message: {
            content: [
              {
                type: "tool_use",
                id: `${agentId}-tool`,
                name: "Bash",
                input: { command: "bun test", description: "Run the focused test suite" },
              },
            ],
          },
        },
        {
          type: "user",
          sessionId: id,
          timestamp: iso(time + 22000),
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `${agentId}-tool`,
                content:
                  "24 tests passed. 0 failures.\nValidation, keyboard navigation and API compatibility checks passed.",
              },
            ],
          },
        },
        response(
          id,
          `${agentId}-2`,
          worker.model,
          inProgress ? now : time + 26000,
          48000 + i * 7200,
          2800 + i * 300,
          inProgress
            ? "Checking the final edge cases and preparing a concise handoff for the independent reviewer."
            : "Implementation and focused checks are complete. The public interface is preserved and all acceptance criteria have evidence.",
        ),
      ];
      await writeFile(join(live, `agent-${agentId}.jsonl`), lines(...records));
      journal.push({ type: "started", agentId, label: worker.label, phase: worker.phase, time });
      if (inProgress) heartbeats.push({ path: join(live, "journal.jsonl"), agentId });
      else
        journal.push({
          type: "result",
          agentId,
          time: time + 30000,
          result: { summary: "Completed with passing checks", tests: 24, findings: [] },
        });
    }
    await writeFile(join(live, "journal.jsonl"), lines(...journal));
    await writeFile(
      join(path, "workflows", runId + ".json"),
      JSON.stringify({
        workflowName: name,
        summary: "Explore, implement and verify changes with a coordinated team of agents.",
        script: source,
        args: { verify: true },
        startTime: start,
        timestamp: iso(running ? now : start + 240000),
        ...(running
          ? {}
          : {
              status: "completed",
              result: { summary: "Implementation verified against the acceptance criteria." },
            }),
      }),
    );
  }
}

try {
  await session(
    "atlas",
    "search",
    "Ship project-wide search",
    7 * 60_000,
    ["Search implementation", "Search architecture"],
    true,
  );
  await session(
    "atlas",
    "accessibility",
    "Keyboard navigation and accessible dialogs",
    5 * 3600_000,
    ["Accessibility improvements"],
  );
  await session("meridian", "api", "Prepare the public API release", 22 * 3600_000, [
    "API compatibility review",
    "Documentation pass",
  ]);
  await session("fieldnotes", "sync", "Make offline sync reliable", 2 * 86400_000, [
    "Sync engine verification",
  ]);
  await mkdir(data);
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      claudeDirectories: [profile],
      port,
      openBrowser: false,
      modelAliases: {},
    }),
  );
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../dist/cli.js"), "--config", config, "--no-open"],
    {
      env: { ...process.env, PORT: "", OBSERVER_DATA_DIR: data },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const heartbeat = setInterval(() => {
    for (const item of heartbeats)
      void appendFile(
        item.path,
        lines({ type: "started", agentId: item.agentId, time: Date.now() }),
      );
  }, 15000);
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`Synthetic demo: http://127.0.0.1:${port}/ (Ctrl+C to stop and remove demo data)`);
  await child.exited;
  clearInterval(heartbeat);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
} finally {
  await rm(directory, { recursive: true, force: true });
}
