import type { SettingsSnapshot } from "../settings";
import { windowLabel, type WindowDays } from "../windows";

export function SettingsProgress({
  settings,
  days,
}: {
  settings?: SettingsSnapshot;
  days?: WindowDays;
}) {
  if (!settings) return null;
  const windows = Object.entries(settings.windows).filter(
    ([key]) => days === undefined || Number(key) === days,
  );
  return (
    <div className="settings-progress" aria-live="polite">
      {settings.fileWarning ? <p className="notice">{settings.fileWarning}</p> : null}
      {windows.map(([key, window]) => {
        const updating = window.state === "queued" || window.state === "updating";
        const incomplete = window.state === "partial" || window.state === "failed";
        if (!updating && !incomplete && days !== undefined) return null;
        return (
          <div
            className={`settings-update ${updating ? "updating" : incomplete ? "attention" : "complete"}`}
            key={key}
          >
            <span
              className={`badge ${updating ? "running" : window.state === "failed" ? "failed" : incomplete ? "quiet" : "completed"}`}
            >
              {updating
                ? "Updating estimates…"
                : window.state === "partial"
                  ? "Update incomplete"
                  : window.state === "failed"
                    ? "Update failed"
                    : "Estimates updated"}
            </span>
            <span className="secondary">
              {windowLabel(Number(key) as WindowDays)}
              {updating ? " · amounts remain visible as runs update" : ""}
            </span>
            {incomplete ? (
              <div className="settings-update-detail">
                <p>
                  Saved settings are unchanged. Some estimates may still use earlier settings.
                  Refresh to retry.
                </p>
                <details>
                  <summary>
                    {window.attempt?.errors.length ?? 0} update{" "}
                    {window.attempt?.errors.length === 1 ? "issue" : "issues"}
                  </summary>
                  <ul>
                    {window.attempt?.errors.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </details>
              </div>
            ) : null}
          </div>
        );
      })}
      {days === undefined && settings.restartRequired ? (
        <p className="notice">
          Port {settings.saved.config.port} is saved. Restart Observer to use it; this companion
          still uses {settings.boundPort}.
        </p>
      ) : null}
    </div>
  );
}
