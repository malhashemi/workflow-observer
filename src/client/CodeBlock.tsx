import { copyText } from "./browser-support";
import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki";
export function languageFor(name: string) {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        js: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "tsx",
        json: "json",
        sh: "bash",
        zsh: "bash",
        css: "css",
        html: "html",
        md: "markdown",
        diff: "diff",
        patch: "diff",
        yml: "yaml",
        yaml: "yaml",
        py: "python",
        sql: "sql",
      } as Record<string, string>
    )[ext ?? ""] ?? "text"
  );
}
export function CodeBlock({
  code,
  language = "text",
  label,
  className = "",
}: {
  code: string;
  language?: string;
  label?: string;
  className?: string;
}) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const preview =
    code.length > 90000
      ? code.slice(0, 90000) +
        "\n[Highlight preview truncated. Full content remains in the original evidence.]"
      : code;
  useEffect(() => {
    let active = true;
    setTokens(null);
    import("./highlight")
      .then((h) => h.highlight(preview, language))
      .then((t) => {
        if (active) setTokens(t);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [preview, language]);
  return (
    <div className={`code-block ${className}`}>
      <header>
        <span>{label ?? language}</span>
        <button
          onClick={async () => {
            try {
              await copyText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <pre className="shiki" tabIndex={0} aria-label={label ?? `${language} code`}>
        <code>
          {tokens
            ? tokens.map((line, i) => (
                <span className="code-line" key={i}>
                  {line.map((t, j) => (
                    <span style={{ color: t.color }} key={j}>
                      {t.content}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))
            : preview}
        </code>
      </pre>
    </div>
  );
}
