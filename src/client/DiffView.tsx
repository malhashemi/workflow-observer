import { useMemo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { registerCustomTheme } from "@pierre/diffs";
import { observerTheme } from "./highlight";
import type { RecordedEdit } from "../types";
registerCustomTheme("observer-dark", async () => observerTheme);
export default function DiffView({ edit }: { edit: RecordedEdit }) {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const before = useMemo(
    () => ({ name: edit.file, contents: edit.before }),
    [edit.file, edit.before],
  );
  const after = useMemo(() => ({ name: edit.file, contents: edit.after }), [edit.file, edit.after]);
  return (
    <section className="recorded-diff">
      <header>
        <div>
          <strong>Recorded edit</strong>
          <small>{edit.file}</small>
        </div>
        <div className="filters">
          <button aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>
            Unified
          </button>
          <button aria-pressed={style === "split"} onClick={() => setStyle("split")}>
            Side by side
          </button>
        </div>
      </header>
      <p className="small secondary">
        {edit.outcome === "applied"
          ? "The tool reported success."
          : edit.outcome === "failed"
            ? "The tool reported failure; this change may not have been applied."
            : "No tool result recorded; application is unconfirmed."}{" "}
        These are the recorded replacement snippets, not a full-file or final repository diff.
        {edit.replaceAll ? " The tool requested replacement of all matching occurrences." : ""}
      </p>
      <MultiFileDiff
        oldFile={before}
        newFile={after}
        options={{
          theme: "observer-dark",
          themeType: "dark",
          diffStyle: style,
          diffIndicators: "bars",
          disableBackground: true,
          overflow: "wrap",
          disableFileHeader: true,
        }}
        style={
          {
            "--diffs-font-family": "Geist Mono, monospace",
            "--diffs-font-size": "12px",
          } as React.CSSProperties
        }
      />
    </section>
  );
}
