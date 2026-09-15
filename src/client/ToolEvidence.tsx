import { lazy, Suspense, useState } from "react";
import type { Event } from "../types";
import { CodeBlock } from "./CodeBlock";
const DiffView = lazy(() => import("./DiffView"));
export function ToolEvidence({ event: e }: { event: Event }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="event" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <time>
          {e.time
            ? new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : "—"}
        </time>
        <i className={`dot ${e.error ? "failed" : "completed"}`} />
        <span>
          <strong>{e.type}</strong>
          <span className="event-agent">{e.agent}</span>
          <p>{e.text}</p>
          {e.edit ? <span className="edit-indicator">View recorded diff</span> : null}
        </span>
        <span>›</span>
      </summary>
      {open ? (
        <div className="tool-evidence">
          {e.edit ? (
            <Suspense fallback={<p>Loading recorded diff…</p>}>
              <DiffView edit={e.edit} />
            </Suspense>
          ) : null}
          <CodeBlock
            code={e.inputText ?? e.detail ?? "No details recorded."}
            language={e.inputText ? "json" : "text"}
            label="Tool input"
          />
          {e.outputText ? (
            <CodeBlock
              code={e.outputText}
              language={e.type === "Bash" ? "bash" : "text"}
              label="Tool result"
            />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
