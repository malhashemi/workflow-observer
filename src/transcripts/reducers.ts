import type { RecordData, SessionIdentity } from "../types";
export const AGENT_STATUS_REVISION = 1;
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
export const clip = (v: unknown, max = 60000): string => {
  const text = typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? "");
  return text.length > max
    ? text.slice(0, max) + "\n[Preview truncated; full content remains in the source file.]"
    : text;
};
export function reduceUsage(s: RecordData, r: RecordData) {
  const m = r.message;
  if (r.type !== "assistant" || !m?.usage || typeof m.id !== "string") return;
  const previous = s.messages[m.id];
  s.messages[m.id] = {
    model: m.model ?? previous?.model,
    usage: { ...previous?.usage, ...m.usage },
    time: typeof r.timestamp === "number" ? r.timestamp : Date.parse(r.timestamp) || 0,
    sessionId: r.sessionId ?? previous?.sessionId,
  };
}
export function reduceAgent(s: RecordData, r: RecordData) {
  const time = typeof r.timestamp === "number" ? r.timestamp : Date.parse(r.timestamp) || 0;
  if (time) {
    s.started = s.started ? Math.min(s.started, time) : time;
    s.modified = Math.max(s.modified ?? 0, time);
  }
  const m = r.message ?? {};
  const content = Array.isArray(m.content) ? m.content : [];
  if (r.type === "user" && !s.task && !content.some((c: RecordData) => c.type === "tool_result"))
    s.task = clip(textOf(m.content));
  if (r.type === "assistant") {
    reduceUsage(s, r);
    const followsRuntime = !s.runtimeState?.time || (time && time >= s.runtimeState.time);
    if (r.isApiErrorMessage === true && (followsRuntime || !time))
      s.runtimeState = { state: "failed", time };
    else if (
      followsRuntime &&
      r.isApiErrorMessage !== true &&
      typeof m.model === "string" &&
      m.model !== "<synthetic>" &&
      (m.usage ||
        content.some((c: RecordData) => c.type === "tool_use" || (c.type === "text" && c.text)))
    )
      s.runtimeState = { state: "running", time };
    for (const c of content) {
      if (c.type === "text" && c.text) s.latestText = clip(c.text);
      if (c.type === "tool_use" && c.id && !s.toolIds[c.id]) {
        s.toolIds[c.id] = true;
        s.toolCount++;
        s.events.push({
          id: c.id,
          time,
          type: c.name,
          text: clip(
            c.input?.description ??
              c.input?.command ??
              c.input?.file_path ??
              c.input?.pattern ??
              c.input?.url ??
              c.name,
            240,
          ),
          detail: clip(c.input, 12000),
          edit:
            c.name === "Edit" &&
            typeof c.input?.old_string === "string" &&
            typeof c.input?.new_string === "string" &&
            c.input.old_string.length + c.input.new_string.length <= 90000
              ? {
                  file: c.input.file_path || "unknown.txt",
                  before: c.input.old_string,
                  after: c.input.new_string,
                  replaceAll: !!c.input.replace_all,
                  outcome: "unknown",
                }
              : undefined,
        });
      }
    }
  }
  for (const c of content)
    if (c.type === "tool_result") {
      const e = s.events.find((e: RecordData) => e.id === c.tool_use_id);
      if (e) {
        e.output = clip(textOf(c.content), 16000);
        e.error = !!c.is_error;
        if (e.edit) e.edit.outcome = c.is_error ? "failed" : "applied";
      }
    }
  s.events = s.events.slice(-300);
}
export const initialAgent = () => ({
  statusRevision: AGENT_STATUS_REVISION,
  runtimeState: null,
  messages: {},
  events: [],
  toolIds: {},
  toolCount: 0,
  task: "",
  latestText: "",
  started: 0,
  modified: 0,
  parseErrors: 0,
});

export const initialParent = (session: string) => ({
  session,
  cwd: "",
  calls: {},
  runs: {},
  messages: {},
  customTitle: "",
  aiTitle: "",
  modified: 0,
});

function parentName(parent: RecordData): Pick<SessionIdentity, "name" | "nameSource"> {
  if (parent.customTitle) return { name: parent.customTitle, nameSource: "custom-title" };
  if (parent.aiTitle) return { name: parent.aiTitle, nameSource: "ai-title" };
  return { name: null, nameSource: null };
}

export function parentReducer(s: RecordData, r: RecordData) {
  // Forked/copied history must not rename or charge a different session.
  if (r.sessionId && r.sessionId !== s.session) return;
  if (r.cwd && !s.cwd) s.cwd = r.cwd;
  if (r.type === "custom-title" && typeof r.customTitle === "string")
    s.customTitle = r.customTitle.trim();
  if (r.type === "ai-title" && typeof r.aiTitle === "string") s.aiTitle = r.aiTitle.trim();
  s.modified = Math.max(s.modified, Date.parse(r.timestamp) || 0);
  reduceUsage(s, r);
  const cs = Array.isArray(r.message?.content) ? r.message.content : [];
  for (const c of cs) {
    if (c.type === "tool_use" && c.name === "Workflow")
      s.calls[c.id] = { ...c.input, cwd: r.cwd ?? s.cwd, time: Date.parse(r.timestamp) || 0 };
    if (c.type === "tool_result" && s.calls[c.tool_use_id]) {
      const text = textOf(c.content);
      const id = text.match(/(?:^|\n)Run ID:\s*(wf_[\w-]+)/)?.[1];
      if (id)
        s.runs[id] = {
          ...s.calls[c.tool_use_id],
          scriptPath:
            s.calls[c.tool_use_id].scriptPath ?? text.match(/(?:^|\n)Script file:\s*(.+)/)?.[1],
          summary: text.match(/(?:^|\n)Summary:\s*(.+)/)?.[1] ?? "",
        };
    }
  }
}

export const parentTitle = parentName;
