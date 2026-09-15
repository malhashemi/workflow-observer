import type { Agent, RecordData, Run, State } from "./types";

function knownState(value: unknown): State | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "done":
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "cancelled":
    case "interrupted":
    case "canceled":
      return "interrupted";
    case "pending":
    case "queued":
      return "pending";
    case "running":
    case "active":
    case "in_progress":
      return "running";
    case "quiet":
      return "quiet";
    default:
      return null;
  }
}

export const stateOf = (value: unknown): State => knownState(value) ?? "quiet";
const terminal = (state: State) => ["completed", "failed", "interrupted"].includes(state);
const timestamp = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string"
      ? Date.parse(value) || 0
      : 0;

/** Native execution evidence only: a tool error, null output, or error-like prose
 * is not a terminal agent failure. Later successful responses can represent retries. */
export function agentState({
  progress,
  journal,
  transcript,
  modified,
  finalState,
  now,
}: {
  progress: RecordData;
  journal: RecordData[];
  transcript: RecordData | null;
  modified: number;
  finalState: State | null;
  now: number;
}): State {
  type Signal = { state: State; time: number; priority: number };
  const signals: Signal[] = [];
  const p = knownState(progress.state);
  if (p)
    signals.push({
      state: p,
      time: timestamp(progress.lastProgressAt),
      priority: terminal(p) ? 30 : 4,
    });
  const last = journal.findLast((e) => ["started", "result", "failed"].includes(e.type));
  if (last) {
    const state =
      last.type === "result" ? "completed" : last.type === "failed" ? "failed" : "running";
    signals.push({
      state,
      time: timestamp(last.timestamp ?? last.time),
      priority: terminal(state) ? 20 : 3,
    });
  }
  const runtime = transcript?.runtimeState;
  if (runtime?.state === "failed" || runtime?.state === "running")
    signals.push({
      state: runtime.state,
      time: timestamp(runtime.time),
      priority: runtime.state === "failed" ? 10 : 5,
    });
  // Compare recorded times when both exist. With untimed journal entries, explicit
  // final progress is authoritative, then the latest journal transition.
  const signal = signals.reduce<Signal | null>((latest, next) => {
    if (!latest) return next;
    if (latest.time && next.time && latest.time !== next.time)
      return next.time > latest.time ? next : latest;
    return next.priority > latest.priority ? next : latest;
  }, null);
  if (signal && terminal(signal.state)) return signal.state;
  if (finalState && terminal(finalState))
    return finalState === "completed" ? "completed" : "interrupted";
  if (signal?.state === "pending") return "pending";
  const activityTime = signal?.time || modified;
  return transcript && activityTime && now - activityTime < 120000 ? "running" : "quiet";
}

export const isFinishedRun = (run: Pick<Run, "state" | "executionState">) =>
  run.executionState ? terminal(run.executionState) : ["finished", "completed"].includes(run.state);

/** The result is arbitrary workflow-owned data. Display its status/reason fields,
 * when present, without assigning them execution semantics or success colors. */
export function workflowStatus(
  execution: unknown,
  result: unknown,
  agents: Pick<Agent, "state" | "availability">[],
): Pick<Run, "state" | "executionState" | "outcome"> {
  const executionState = typeof execution === "string" ? stateOf(execution) : null;
  const reported =
    result && typeof result === "object" && !Array.isArray(result) ? (result as RecordData) : null;
  const status = typeof reported?.status === "string" ? reported.status : "";
  const reason = typeof reported?.reason === "string" ? reported.reason : "";
  const excerpt = (value: string, limit: number) =>
    value.length > limit ? value.slice(0, limit) + "…" : value;
  const outcome = status.trim()
    ? {
        status: excerpt(status, 200),
        reason: excerpt(reason, 2000),
        ...(status.length > 200 || reason.length > 2000 ? { truncated: true } : {}),
      }
    : null;
  const failed = agents.some((a) => a.state === "failed");
  const active = agents.some(
    (a) => a.availability !== "missing" && a.availability !== "unreadable" && a.state === "running",
  );
  let state: State;
  if (executionState === "failed" || executionState === "interrupted") state = executionState;
  else if (executionState === "completed") state = failed ? "failed" : "finished";
  else state = active ? "running" : failed ? "failed" : (executionState ?? "quiet");
  return { state, executionState, outcome };
}
