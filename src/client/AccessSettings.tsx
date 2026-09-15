import { useEffect, useState } from "react";
import { accessOf, defaultConfig, type ObserverConfig } from "../config";
import type { ConfigChange } from "../config-changes";
import type { SettingsSnapshot } from "../settings";
import type { CompanionSnapshot } from "../companion/types";
import type { RecordData } from "../types";
import { ShareButton, ShareDialog } from "./ShareDialog";
import { copyText } from "./browser-support";
const settingNames = { local: "This computer", lan: "Local network", tailscale: "Tailscale HTTPS" };
function CopyField({
  label,
  value,
  onToast,
}: {
  label: string;
  value: string;
  onToast: (s: string) => void;
}) {
  return (
    <div className="copy-field">
      <span>{label}</span>
      <div>
        <code>{value}</code>
        <button
          onClick={async () => {
            try {
              await copyText(value);
              onToast(`${label} copied.`);
            } catch (e) {
              onToast(String(e));
            }
          }}
        >
          Copy
        </button>
      </div>
    </div>
  );
}
export function AccessSettings({
  status,
  online,
  onToast,
}: {
  status: RecordData | null;
  online: boolean;
  onToast: (s: string) => void;
}) {
  const [receipt, setReceipt] = useState<{
    instanceId: string;
    settings: SettingsSnapshot;
  } | null>(null);
  const current = (
    receipt &&
    receipt.instanceId === status?.companion?.instanceId &&
    receipt.settings.sequence > (status?.settings?.sequence ?? -1)
      ? receipt.settings
      : status?.settings
  ) as SettingsSnapshot | undefined;
  const config: ObserverConfig = current?.saved.config ?? defaultConfig,
    access = accessOf(config);
  const companion = status?.companion as CompanionSnapshot | undefined;
  const [port, setPort] = useState(String(config.port));
  const [remotePort, setRemotePort] = useState(String(access.tailscalePort));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sharing, setSharing] = useState(false);
  useEffect(() => setPort(String(config.port)), [config.port]);
  useEffect(() => setRemotePort(String(access.tailscalePort)), [access.tailscalePort]);
  async function preference(
    field: Extract<ConfigChange, { type: "set-preference" }>["field"],
    value: string | number | boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    const previous = field === "port" || field === "openBrowser" ? config[field] : access[field];
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "set-preference", field, value, previous }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setReceipt({ instanceId: companion!.instanceId, settings: result.settings });
      onToast("Setting saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/companion/apply", {
        method: "POST",
        signal: AbortSignal.timeout(40000),
      });
      const result: CompanionSnapshot = await response.json();
      if (!response.ok || result.state === "failed")
        throw new Error(result.error ?? "Could not apply network settings.");
      const currentAddress = companion?.addresses.find(
        (a) => new URL(a.url).origin === location.origin,
      );
      const next = result.addresses.find((a) => a.kind === (currentAddress?.kind ?? "local"));
      if (next && new URL(next.url).origin !== location.origin)
        location.href = next.url + "#settings/access";
      else
        onToast(
          result.remote.state === "failed"
            ? "Local access applied. Tailscale needs attention."
            : "Access settings applied.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const addresses = online ? (companion?.addresses ?? []) : [];
  const defaultAddress = addresses.find((a) => a.kind === access.openAddress);
  const command = companion?.actionCommand ?? "bunx workflow-observer --background --no-open";
  return (
    <div className="access-settings">
      <section className="panel access-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">One companion, your devices</span>
            <h2>Access Observer</h2>
            <p>Choose where you open Observer. Network access is optional.</p>
          </div>
          <span className={`badge ${online ? "completed" : "quiet"}`}>
            {online ? "Connected" : "Offline"}
          </span>
        </div>
        <div className="access-setting">
          <div>
            <h3>Local port</h3>
            <p>A stable address for your browser and tool actions.</p>
          </div>
          <form
            className="port-form"
            onSubmit={(e) => {
              e.preventDefault();
              void preference("port", Number(port));
            }}
          >
            <input
              aria-label="Local port"
              inputMode="numeric"
              type="number"
              min="1024"
              max="65535"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={busy || !online}
            />
            <button disabled={busy || !online || port === String(config.port)}>Save port</button>
          </form>
        </div>
        {companion?.pending ? (
          <div className="access-notice">
            <span>
              Port <b>{config.port}</b> is saved. Observer is still listening on{" "}
              <b>{companion.localPort}</b>.
            </span>
            <button disabled={busy} onClick={apply}>
              {busy ? "Applying…" : "Apply & reconnect"}
            </button>
          </div>
        ) : null}
        {companion?.portOverride ? (
          <p className="small secondary">
            Launch override: {companion.portOverride}. Restart without <code>--port</code> or{" "}
            <code>PORT</code> to use the saved default.
          </p>
        ) : null}
        <div className="access-setting">
          <div>
            <h3>Open browser on launch</h3>
            <p>
              Your tool action can override this with <code>--no-open</code>.
            </p>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={config.openBrowser}
            aria-label="Open browser on launch"
            disabled={busy || !online}
            onClick={() => preference("openBrowser", !config.openBrowser)}
          >
            <i />
          </button>
        </div>
        <div className="access-setting">
          <div>
            <h3>Local-network access</h3>
            <p>Open Observer from another device on the same network.</p>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={access.lanEnabled}
            aria-label="Local-network access"
            disabled={busy || !online}
            onClick={() => preference("lanEnabled", !access.lanEnabled)}
          >
            <i />
          </button>
        </div>
        {companion?.lanError ? <p className="config-error">{companion.lanError}</p> : null}
      </section>
      <section className="panel access-panel">
        <div className="access-setting first">
          <div>
            <span className="eyebrow">Across your devices</span>
            <h2>Tailscale</h2>
            <p>Use your device’s HTTPS name wherever you are connected to Tailscale.</p>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={access.tailscaleEnabled}
            aria-label="Tailscale access"
            disabled={busy || !online}
            onClick={() => preference("tailscaleEnabled", !access.tailscaleEnabled)}
          >
            <i />
          </button>
        </div>
        <div className="tailscale-status">
          <span
            className={`badge ${companion?.remote.state === "ready" ? "completed" : companion?.remote.state === "connecting" ? "running" : companion?.remote.state === "failed" ? "quiet" : "pending"}`}
          >
            {companion?.remote.state ?? "Disabled"}
          </span>
          <code>{companion?.remote.hostname ?? "Device name detected when enabled"}</code>
        </div>
        <div className="access-setting">
          <div>
            <h3>HTTPS port</h3>
            <p>A separate endpoint preserves your other Tailscale services.</p>
          </div>
          <form
            className="port-form"
            onSubmit={(e) => {
              e.preventDefault();
              void preference("tailscalePort", Number(remotePort));
            }}
          >
            <input
              aria-label="Tailscale HTTPS port"
              inputMode="numeric"
              type="number"
              min="1024"
              max="65535"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              disabled={busy || !online}
            />
            <button disabled={busy || !online || remotePort === String(access.tailscalePort)}>
              Save port
            </button>
          </form>
        </div>
        {companion?.remote.error ? (
          <div className="access-notice">
            <p>{companion.remote.error}</p>
            <button disabled={busy} onClick={apply}>
              Retry connection
            </button>
          </div>
        ) : null}
      </section>
      {error || companion?.error ? (
        <p role="alert" className="config-error">
          {error || companion?.error}
        </p>
      ) : null}
      <section className="panel access-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">A link for every screen</span>
            <h2>Addresses & sharing</h2>
            <p>Open on this computer, or scan a QR code on another device.</p>
          </div>
          <ShareButton onClick={() => setSharing(true)} />
        </div>
        <div className="address-list">
          {addresses.map((a) => (
            <div className="address-row" key={a.url}>
              <div>
                <span className="small secondary">{a.label}</span>
                <code>{a.url}</code>
              </div>
              <div className="row">
                <a className="button-link" href={a.url} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
                <button
                  onClick={async () => {
                    try {
                      await copyText(a.url);
                      onToast("Address copied.");
                    } catch (e) {
                      onToast(String(e));
                    }
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          ))}
          {!addresses.length ? (
            <p className="secondary">Connect to the companion to confirm its addresses.</p>
          ) : null}
        </div>
        <div className="access-setting">
          <div>
            <h3>Default sharing address</h3>
            <p>Every QR modal starts with this network. You can switch for one share.</p>
          </div>
          <select
            aria-label="Default sharing address"
            value={access.sharingDefault}
            disabled={busy || !online}
            onChange={(e) => preference("sharingDefault", e.target.value)}
          >
            <option value="tailscale">Tailscale</option>
            <option value="lan">Local network</option>
          </select>
        </div>
        {!addresses.some((a) => a.kind === access.sharingDefault) ? (
          <p className="small secondary">
            Your sharing default is unavailable. Enable its network access above to generate a QR.
          </p>
        ) : null}
        <div className="access-setting">
          <div>
            <h3>Open by default</h3>
            <p>The address used when the CLI opens your browser.</p>
          </div>
          <select
            aria-label="Open by default"
            value={access.openAddress}
            disabled={busy || !online}
            onChange={(e) => preference("openAddress", e.target.value)}
          >
            {Object.entries(settingNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="panel access-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">One-click access</span>
            <h2>Add to your tool</h2>
            <p>Use these fields when creating an action in your editor or workflow tool.</p>
          </div>
        </div>
        <CopyField label="Action command" value={command} onToast={onToast} />
        {defaultAddress ? (
          <CopyField label="Preview URL" value={defaultAddress.url} onToast={onToast} />
        ) : (
          <p className="secondary">
            The preferred opening address is unavailable. Choose an available address above.
          </p>
        )}
      </section>
      {sharing ? (
        <ShareDialog
          companion={
            companion ? { ...companion, sharingDefault: access.sharingDefault } : undefined
          }
          online={online}
          onClose={() => setSharing(false)}
        />
      ) : null}
    </div>
  );
}
export function UpdateSettings({
  status,
  onToast,
}: {
  status: RecordData | null;
  onToast: (s: string) => void;
}) {
  const companion = status?.companion as CompanionSnapshot | undefined;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="panel access-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Your Observer</span>
          <h2>Versions & updates</h2>
          <p>Updates are explicit. Your configuration and workflow index stay in place.</p>
        </div>
        <span className="badge pending">
          {companion?.installation.kind.replace("-", " ") ?? "Connecting"}
        </span>
      </div>
      <div className="version-grid">
        <div>
          <span>Installed package</span>
          <strong>{companion?.installation.version ?? "—"}</strong>
        </div>
        <div>
          <span>Running companion</span>
          <strong>{companion?.version ?? "—"}</strong>
        </div>
        <div>
          <span>Latest release</span>
          <strong>{companion?.update.latest ?? "Not checked"}</strong>
        </div>
      </div>
      <button
        disabled={busy || !companion || companion.update.state === "checking"}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const r = await fetch("/api/companion/update-check", {
              method: "POST",
              signal: AbortSignal.timeout(10000),
            });
            if (!r.ok) throw new Error("Could not check for updates.");
            onToast("Checking installed and published versions.");
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {companion?.update.state === "checking" ? "Checking…" : "Check for updates"}
      </button>
      {error || companion?.update.error ? (
        <p className="notice">{error || companion?.update.error}</p>
      ) : null}
      <CopyField
        label="Update command"
        value={
          companion?.installation.kind === "bunx"
            ? "bunx workflow-observer@latest"
            : "workflow-observer update"
        }
        onToast={onToast}
      />
      <p className="small secondary">
        {companion?.installation.kind === "development"
          ? "This checkout is linked locally. Update and rebuild the checkout to change its installed version."
          : "The CLI verifies the global installation before updating it, then reports whether the running companion was restarted."}
      </p>
    </section>
  );
}
