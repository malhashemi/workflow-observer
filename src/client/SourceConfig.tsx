import { copyText } from "./browser-support";
import { useEffect, useRef, useState } from "react";
import type { RecordData } from "../types";
import type { ObserverConfig } from "../config";
import type { ConfigChange } from "../config-changes";
import { SettingsProgress } from "./SettingsProgress";
import type { SettingsSnapshot } from "../settings";
import { ModelInfo } from "./ModelInfo";

type Alias = { recorded: string; target: string };
export function SourceConfig({
  status,
  onToast,
  section,
}: {
  status: RecordData | null;
  section?: "sources" | "models";
  onToast: (message: string) => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [configuration, setConfiguration] = useState<ObserverConfig | null>(null);
  const [editing, setEditing] = useState<Alias | null>(null);
  const [recorded, setRecorded] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<{
    section: "directories" | "aliases";
    message: string;
  } | null>(null);
  const recordedInput = useRef<HTMLInputElement>(null);
  const [receipt, setReceipt] = useState<{ pid: number; settings: SettingsSnapshot } | null>(null);
  const currentSettings =
    receipt &&
    receipt.pid === status?.pid &&
    receipt.settings.sequence > (status?.settings?.sequence ?? -1)
      ? receipt.settings
      : (status?.settings as SettingsSnapshot | undefined);
  const configJson = JSON.stringify(currentSettings?.saved.config ?? status?.configuration ?? null);
  const configPath = status?.configPath ?? "~/.config/workflow-observer/config.json";
  useEffect(() => {
    if (!saving.current) setConfiguration(JSON.parse(configJson));
  }, [configJson]);
  const aliases = Object.entries(configuration?.modelAliases ?? {});
  const directories = configuration?.claudeDirectories ?? [];

  async function save(change: ConfigChange, section: "directories" | "aliases", message: string) {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setConfiguration(result.config);
      setReceipt({ pid: status?.pid, settings: result.settings });
      onToast(message);
      return true;
    } catch (e) {
      setError({ section, message: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function resetAlias() {
    setEditing(null);
    setRecorded("");
    setTarget("");
    setError(null);
  }
  function editAlias(alias: Alias) {
    setEditing(alias);
    setRecorded(alias.recorded);
    setTarget(alias.target);
    setError(null);
    recordedInput.current?.focus();
  }

  return (
    <div className="source-settings">
      <SettingsProgress settings={currentSettings} />
      <section
        hidden={section === "models"}
        className="panel config-editor"
        aria-labelledby="directories-heading"
      >
        <div className="section-heading">
          <div>
            <h3 id="directories-heading">Scan directories</h3>
            <p>Choose the Claude profiles Observer watches.</p>
          </div>
          <span className="badge pending">{directories.length} configured</span>
        </div>
        <div className="configured-paths">
          {directories.map((directory) => (
            <div key={directory}>
              <code>{directory}</code>
              <button
                disabled={busy}
                aria-label={`Remove ${directory}`}
                onClick={() =>
                  save(
                    { type: "remove-directory", path: directory },
                    "directories",
                    "Directory removal saved.",
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        {!directories.length && configuration ? (
          <p className="settings-empty">
            No directories configured. Add a profile to start discovery.
          </p>
        ) : null}
        <form
          className="add-directory"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await save(
                { type: "add-directory", path: path.trim() },
                "directories",
                "Directory saved.",
              )
            )
              setPath("");
          }}
        >
          <label>
            <span>Claude directory</span>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/.claude-work"
              aria-label="Claude directory"
              required
              disabled={busy}
            />
          </label>
          <button disabled={busy || !path.trim() || !configuration}>Add directory</button>
        </form>
        {error?.section === "directories" ? (
          <p className="config-error" role="alert">
            {error.message}
          </p>
        ) : null}
      </section>

      <section
        hidden={section === "sources"}
        className="panel config-editor alias-editor"
        aria-labelledby="aliases-heading"
      >
        <div className="section-heading">
          <div>
            <h3 id="aliases-heading">Model aliases</h3>
            <p>Connect a recorded model ID to the catalog model used for pricing.</p>
          </div>
          <span className="badge pending">{aliases.length} configured</span>
        </div>
        {aliases.length ? (
          <div className="alias-list">
            <div className="alias-columns" aria-hidden="true">
              <span>Recorded model</span>
              <span />
              <span>Price using</span>
              <span />
            </div>
            {aliases.map(([id, model]) => (
              <div className={`alias-row ${editing?.recorded === id ? "editing" : ""}`} key={id}>
                <code className="alias-recorded">{id}</code>
                <span className="alias-arrow" aria-hidden="true">
                  →
                </span>
                <div className="alias-target">
                  <ModelInfo model={model} />
                </div>
                <div className="alias-actions">
                  <button
                    disabled={busy}
                    aria-label={`Edit alias ${id}`}
                    onClick={() => editAlias({ recorded: id, target: model })}
                  >
                    Edit
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`Remove alias ${id}`}
                    onClick={async () => {
                      if (
                        (await save(
                          { type: "remove-alias", recorded: id, target: model },
                          "aliases",
                          "Alias removal saved.",
                        )) &&
                        editing?.recorded === id
                      )
                        resetAlias();
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="settings-empty">
            No aliases configured. Exact catalog model IDs are priced automatically.
          </p>
        )}
        <form
          className="alias-form"
          aria-label={editing ? "Edit model alias" : "Add model alias"}
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await save(
                {
                  type: "set-alias",
                  recorded: recorded.trim(),
                  target: target.trim(),
                  ...(editing ? { previous: editing } : {}),
                },
                "aliases",
                "Alias saved.",
              )
            )
              resetAlias();
          }}
        >
          <div className="alias-form-heading">
            <span className="eyebrow">{editing ? "Edit alias" : "Add an alias"}</span>
          </div>
          <label>
            <span>Recorded model ID</span>
            <input
              ref={recordedInput}
              value={recorded}
              onChange={(e) => setRecorded(e.target.value)}
              placeholder="model-id-from-transcript"
              aria-label="Recorded model ID"
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              required
              disabled={busy}
            />
          </label>
          <label>
            <span>Catalog model</span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="provider/model-id"
              aria-label="Catalog model"
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              required
              disabled={busy}
              aria-describedby="alias-help"
            />
          </label>
          <div className="alias-form-actions">
            {editing ? (
              <button type="button" onClick={resetAlias} disabled={busy}>
                Cancel
              </button>
            ) : null}
            <button disabled={busy || !recorded.trim() || !target.trim() || !configuration}>
              {editing ? "Save changes" : "Add alias"}
            </button>
          </div>
        </form>
        {error?.section === "aliases" ? (
          <p className="config-error" role="alert">
            {error.message}
          </p>
        ) : null}
        <p className="settings-help" id="alias-help">
          Use the <code>provider/model</code> ID from{" "}
          <a href="https://models.dev" target="_blank" rel="noreferrer">
            Models.dev ↗
          </a>
          . Exact matches take priority; aliases keep the recorded name.
        </p>
      </section>

      <div className="config-location">
        <div>
          <span className="eyebrow">Saved on this computer</span>
          <code>{configPath}</code>
        </div>
        <button
          onClick={async () => {
            try {
              await copyText(configPath);
              onToast("Config path copied.");
            } catch {
              onToast("Could not copy the path. Select it to copy manually.");
            }
          }}
        >
          Copy path
        </button>
      </div>
    </div>
  );
}
