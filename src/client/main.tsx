import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./Icon";
import { Navigation } from "./Navigation";
import type { Agent, Run, RunSummary, Usage, RecordData, SessionSummary } from "../types";
import "./style.css";
import { combineUsage } from "../pricing";
import { isFinishedRun } from "../status";
import { CACHE_WRITE_1H_SOURCE } from "../pricing-rules";
import { DEFAULT_WINDOW, WINDOW_DAYS, windowLabel, type WindowDays } from "../windows";
import { emptyLibrary } from "./observation";
import { useObservation } from "./observation/react";
import { ModelInfo } from "./ModelInfo";
import { PhasePlan } from "./PhasePlan";
import { CodeBlock, languageFor } from "./CodeBlock";
import { SettingsProgress } from "./SettingsProgress";
import { AccessSettings, UpdateSettings } from "./AccessSettings";
import { ShareDialog, ShareButton } from "./ShareDialog";
import { SourceConfig } from "./SourceConfig";
import { ToolEvidence } from "./ToolEvidence";
import { retireLegacyWorker } from "./legacy-worker";
const number = (n: number) =>
  new Intl.NumberFormat("en", {
    notation: n >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(n || 0);
const exact = (n: number) => new Intl.NumberFormat("en").format(n || 0);
const money = (n: number | null) =>
  n === null
    ? "Unpriced"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
const date = (n: number) =>
  n
    ? new Date(n).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not recorded";
const duration = (n: number) => {
  const s = Math.floor(n / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${s}s`;
};
const since = (n: number) =>
  !n ? "No activity recorded" : `${duration(Math.max(0, Date.now() - n))} ago`;
function Badge({ state, label }: { state: string; label?: string }) {
  return (
    <span className={`badge ${state}`}>
      <i />
      {label ??
        (state === "quiet" ? "Needs attention" : state === "pending" ? "Not started" : state)}
    </span>
  );
}
function RunBadge({ run }: { run: Pick<Run, "state" | "executionState"> }) {
  return (
    <Badge
      state={run.state === "completed" ? "finished" : run.state}
      label={
        run.state === "failed" && run.executionState !== "failed"
          ? run.executionState === "completed"
            ? "Finished · agent failures"
            : "Agent failures"
          : undefined
      }
    />
  );
}
function Cost({ usage }: { usage: Usage }) {
  return (
    <span title={`${usage.pricedRequests} of ${usage.requests} recorded requests priced`}>
      {usage.pricedRequests ? money(usage.cost) : usage.requests ? "Unpriced" : "—"}
      {usage.pricedRequests < usage.requests ? <span className="partial"> partial</span> : null}
    </span>
  );
}
function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note: React.ReactNode;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
const safelyRead = (key: string, fallback: any) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const safelyStore = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode or quota: live reading still works. */
  }
};
const request = async (path: string, options?: RequestInit) => {
  const r = await fetch(path, { ...options, signal: AbortSignal.timeout(8000) });
  if (r.status === 304) return null;
  if (!r.ok) throw new Error(`Companion returned ${r.status}`);
  return r.json();
};
function App() {
  const [days, setDays] = useState<WindowDays>(() => {
    const n = Number(new URLSearchParams(location.search).get("days"));
    return WINDOW_DAYS.includes(n as WindowDays) ? (n as WindowDays) : DEFAULT_WINDOW;
  });
  const [view, setView] = useState<string>(() => safelyRead("observer.libraryView", "sessions"));
  const [page, setPage] = useState(
    location.hash.startsWith("#run/")
      ? "run"
      : /^#(sources|settings)(\/|$)/.test(location.hash)
        ? "sources"
        : "library",
  );
  const [key, setKey] = useState(location.hash.slice(5));
  const observation = useObservation({ days, runKey: page === "run" ? key : null });
  const { runs, sessions, updatedAt } = observation.library.value ?? emptyLibrary(days);
  const status = observation.status;
  const online = observation.connection === "connected";
  const loaded = observation.connection !== "checking";
  const run = observation.detail.value;
  const runError = observation.detail.error;
  const [project, setProject] = useState("all");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [toast, setToast] = useState("");
  const [shareTarget, setShareTarget] = useState<{ key?: string; name?: string } | null>(null);
  useEffect(() => {
    const listener = () => {
      if (location.hash.startsWith("#run/")) {
        setKey(location.hash.slice(5));
        setPage("run");
      } else setPage(/^#(sources|settings)(\/|$)/.test(location.hash) ? "sources" : "library");
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    void retireLegacyWorker();
  }, []);
  const projects = useMemo(() => [...new Set(runs.map((r) => r.project))].sort(), [runs]);
  const visible = useMemo(
    () =>
      runs
        .filter(
          (r) =>
            (project === "all" || r.project === project) &&
            (filter === "all" ||
              (filter === "attention" && ["quiet", "interrupted"].includes(r.state)) ||
              (filter === "finished" && isFinishedRun(r)) ||
              r.state === filter) &&
            `${r.sessionInfo?.name ?? ""} ${r.session} ${r.name} ${r.project} ${r.cwd} ${r.id} ${r.summary} ${r.profile} ${r.usage.groups.map((g) => g.model).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "cost"
            ? b.usage.cost - a.usage.cost
            : sort === "tokens"
              ? b.usage.total - a.usage.total
              : b.modified - a.modified,
        ),
    [runs, project, filter, query, sort],
  );
  const sessionGroups = useMemo(() => {
    const groups = new Map<string, { session?: SessionSummary; runs: RunSummary[] }>();
    for (const run of visible) {
      const id = run.sessionInfo?.key ?? run.key;
      const group = groups.get(id) ?? { session: sessions.find((s) => s.key === id), runs: [] };
      group.runs.push(run);
      groups.set(id, group);
    }
    return [...groups.entries()].sort(([, a], [, b]) => {
      const total = (group: typeof a) =>
        group.session?.usage ?? combineUsage(group.runs.map((r) => r.usage));
      return sort === "cost"
        ? total(b).cost - total(a).cost
        : sort === "tokens"
          ? total(b).total - total(a).total
          : (b.session?.modified ?? b.runs[0].modified) -
            (a.session?.modified ?? a.runs[0].modified);
    });
  }, [visible, sessions, sort]);
  const libraryUsage = combineUsage(
    view === "sessions"
      ? sessionGroups.map(([, g]) => g.session?.usage ?? combineUsage(g.runs.map((r) => r.usage)))
      : visible.map((r) => r.usage),
  );
  const incompleteSessions =
    view === "sessions" && sessionGroups.some(([, g]) => !g.session || g.session.warnings.length);
  const openRun = (r: RunSummary) => {
    location.hash = "run/" + r.key;
  };
  const goLibrary = (p = "all", f = "all") => {
    setProject(p);
    setFilter(f);
    setPage("library");
    location.hash = "";
  };
  const refresh = observation.refreshNow;
  return (
    <div className="shell">
      <Navigation
        runs={runs}
        projects={projects}
        page={page}
        project={project}
        filter={filter}
        online={online}
        loaded={loaded}
        networkEnabled={
          status?.companion?.addresses?.some((a: RecordData) => a.kind !== "local") ?? false
        }
        onLibrary={goLibrary}
        onSettings={() => {
          setPage("sources");
          location.hash = "settings";
        }}
      />
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <a href="#" onClick={() => goLibrary()}>
              Workspace
            </a>
            <span>/</span>
            <span>
              {page === "run"
                ? (run?.project ?? "Workflow")
                : page === "sources"
                  ? "Settings"
                  : project === "all"
                    ? "All workflows"
                    : project}
            </span>
          </div>
          <div className="row">
            <span
              className="top-status"
              title={
                updatedAt
                  ? `Last index attempt: ${new Date(updatedAt).toLocaleString()}`
                  : "Waiting for the first update"
              }
            >
              <i className={`dot ${online ? "running" : "quiet"}`} />
              {updatedAt ? (
                <time dateTime={new Date(updatedAt).toISOString()}>
                  Updated{" "}
                  {new Date(updatedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              ) : (
                "Not updated yet"
              )}
            </span>
            {page === "library" ? <ShareButton compact onClick={() => setShareTarget({})} /> : null}
            <button
              className="icon-button"
              title="Refresh workflows"
              aria-label="Refresh workflows"
              onClick={refresh}
              disabled={observation.refresh === "requested" || observation.refresh === "scanning"}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        {!online && loaded ? (
          <div className="notice">
            {observation.library.value || run
              ? "Companion offline. Showing last-confirmed snapshots; running indicators are last recorded states. "
              : "Companion offline. Waiting to confirm the index before showing saved workflow content. "}
            Start <code>bunx workflow-observer</code> to reconnect.
          </div>
        ) : null}
        {online && page !== "sources" ? (
          <SettingsProgress settings={status?.settings} days={days} />
        ) : null}
        {observation.storageWarning ? (
          <div className="notice">{observation.storageWarning}</div>
        ) : null}
        {observation.refreshError ? <div className="notice">{observation.refreshError}</div> : null}
        {online && observation.library.error ? (
          <div className="notice">
            {observation.library.error}{" "}
            {observation.library.value
              ? "Showing the last-confirmed snapshot."
              : "Retry with Refresh workflows."}
          </div>
        ) : null}
        {page === "library" ? (
          <div className="content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">Your workflow library</div>
                <h1>{project === "all" ? "Your workflows" : project}</h1>
                <p>Follow the work in progress. Return to the evidence when it’s done.</p>
              </div>
              <span className="quiet-label">
                {status?.scanning
                  ? "Discovering workflows…"
                  : `${windowLabel(days)} · by last activity`}
              </span>
            </div>
            <div className="metrics">
              <Metric
                label={view === "sessions" ? "Recorded session tokens" : "Recorded workflow tokens"}
                value={libraryUsage.requests ? number(libraryUsage.total) : "—"}
                note={
                  view === "sessions"
                    ? "Parent conversation + discovered agents"
                    : "Input, output and cache across requests"
                }
              />
              <Metric
                label={view === "sessions" ? "Est. session API cost" : "Est. workflow API cost"}
                value={<Cost usage={libraryUsage} />}
                note={
                  incompleteSessions
                    ? "Incomplete evidence · see session breakdowns"
                    : "Priced requests · current standard rates"
                }
              />
              <Metric
                label="In progress"
                value={visible.filter((r) => r.state === "running").length}
                note="Recent activity in unfinished runs"
              />
              <Metric
                label="Finished"
                value={visible.filter(isFinishedRun).length}
                note="Execution ended · reported status is separate"
              />
            </div>
            <div className="view-switch" role="group" aria-label="Group workflows">
              {["sessions", "workflows"].map((mode) => (
                <button
                  key={mode}
                  aria-pressed={view === mode}
                  onClick={() => {
                    setView(mode);
                    safelyStore("observer.libraryView", mode);
                  }}
                >
                  {mode === "sessions" ? "By session" : "All workflows"}
                </button>
              ))}
            </div>
            <div className="library-heading">
              <h2>
                {view === "sessions" ? "Sessions" : "Workflows"}{" "}
                <span>{view === "sessions" ? sessionGroups.length : visible.length}</span>
              </h2>
              <div className="row">
                <select
                  aria-label="Time window"
                  value={days}
                  onChange={(e) => {
                    setDays(Number(e.target.value) as WindowDays);
                    setProject("all");
                  }}
                >
                  {WINDOW_DAYS.map((days) => (
                    <option key={days} value={days}>
                      {windowLabel(days)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Project"
                  className="mobile-projects"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="all">All projects</option>
                  {projects.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <select
                  aria-label="Sort workflows"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="recent">Most recent</option>
                  <option value="cost">Highest estimated cost</option>
                  <option value="tokens">Most tokens</option>
                </select>
              </div>
            </div>
            <div className="filter-row">
              <label className="search">
                <Icon name="search" />
                <input
                  aria-label="Search workflows"
                  placeholder="Search sessions, workflows, projects or models…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>⌕</kbd>
              </label>
              <div className="filters">
                {[
                  ["all", "All"],
                  ["running", "Running"],
                  ["finished", "Finished"],
                  ["attention", "Attention"],
                  ["failed", "Failed"],
                ].map(([id, label]) => (
                  <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {view === "sessions" ? (
              <p className="session-scope">
                Workflows active in the {days === 1 ? "last 24 hours" : `last ${days} days`}.
                Session estimates include the parent conversation and agents in this window;
                excluded older evidence is marked. Search and status filters don’t change these
                estimates.
              </p>
            ) : null}
            <div className={view === "workflows" ? "table-wrap library" : "session-results"}>
              {view === "sessions" ? (
                <div className="session-list">
                  {sessionGroups.map(([id, group], i) => (
                    <SessionPanel
                      key={id}
                      session={group.session}
                      runs={group.runs}
                      defaultOpen={i === 0}
                      openRun={openRun}
                    />
                  ))}
                </div>
              ) : (
                <WorkflowTable runs={visible} openRun={openRun} />
              )}

              {!visible.length ? (
                <div className="empty">
                  <Icon name="search" size={28} />
                  <h3>
                    {!loaded
                      ? "Confirming the current index…"
                      : !online && !observation.library.value
                        ? "Waiting for the companion"
                        : !runs.length && status?.scanning
                          ? "Discovering your workflows…"
                          : "No workflows in this view"}
                  </h3>
                  <p>
                    {!loaded || (!online && !observation.library.value)
                      ? "Saved content stays hidden until the companion confirms the current index."
                      : runs.length
                        ? "Try another search or clear the filters."
                        : `No workflows with activity in the ${days === 1 ? "last 24 hours" : `last ${days} days`}. Try a wider time window.`}
                  </p>
                  {runs.length ? (
                    <button
                      onClick={() => {
                        setQuery("");
                        goLibrary();
                      }}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="table-footer">
              <span>
                {visible.length} workflows · {new Set(visible.map((r) => r.cwd)).size} project
                locations · {windowLabel(days).toLowerCase()}
              </span>
              <span>
                {view === "sessions" ? "Session request usage" : "Workflow agent usage"} · pricing
                from{" "}
                <a href="https://models.dev" target="_blank" rel="noreferrer">
                  Models.dev ↗
                </a>
              </span>
            </div>
          </div>
        ) : page === "run" ? (
          <div className="content">
            {run ? (
              <RunDetail
                key={run.key}
                run={run}
                onShare={() => setShareTarget({ key: run.key, name: run.name })}
                online={online && observation.detail.source === "current" && !runError}
                onBack={() => goLibrary(run.project)}
                onToast={setToast}
              />
            ) : (
              <div className="empty">
                <h2>
                  {runError
                    ? "Workflow unavailable"
                    : !online && loaded
                      ? "Waiting for the companion"
                      : "Opening workflow…"}
                </h2>
                <p>
                  {runError ??
                    (loaded
                      ? "Reconnect the companion to open this workflow."
                      : "Confirming the companion’s current index…")}
                </p>
                <button onClick={() => goLibrary()}>Back to workflows</button>
              </div>
            )}
          </div>
        ) : (
          <Sources status={status} online={online} refresh={refresh} onToast={setToast} />
        )}
      </main>
      {shareTarget ? (
        <ShareDialog
          companion={status?.companion}
          online={online}
          runKey={shareTarget.key}
          runName={run && run.key === shareTarget.key ? run.name : undefined}
          days={days}
          onClose={() => setShareTarget(null)}
        />
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
function WorkflowTable({
  runs,
  openRun,
}: {
  runs: RunSummary[];
  openRun: (r: RunSummary) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Workflow</th>
          <th>Status</th>
          <th className="num">Recorded tokens</th>
          <th className="num">Est. API cost</th>
          <th>Last activity</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.key}>
            <td>
              <button className="run-link" onClick={() => openRun(r)}>
                {r.name}
              </button>
              <div className="run-meta">
                <span>{r.project}</span>
                <span>·</span>
                <span>{r.profile}</span>
                <span>·</span>
                <span>{r.agentCount} agents</span>
              </div>
            </td>
            <td>
              <RunBadge run={r} />
            </td>
            <td className="num mono" title={exact(r.usage.total)}>
              {r.usage.requests ? number(r.usage.total) : "—"}
            </td>
            <td className="num mono">
              <Cost usage={r.usage} />
            </td>
            <td className="secondary small">
              {date(r.modified)}
              <small>{duration(r.duration)} recorded</small>
            </td>
            <td>
              <button
                className="icon-button"
                aria-label={`Open ${r.name}`}
                onClick={() => openRun(r)}
              >
                <Icon name="arrow" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function SessionPanel({
  session: s,
  runs,
  defaultOpen,
  openRun,
}: {
  session?: SessionSummary;
  runs: RunSummary[];
  defaultOpen: boolean;
  openRun: (r: RunSummary) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [pricing, setPricing] = useState(false);
  const first = runs[0];
  const name = s?.name || first.sessionInfo?.name || `Session ${first.session.slice(0, 8)}`;
  const key = s?.key ?? first.sessionInfo?.key ?? first.key;
  const count = s?.runKeys.length ?? runs.length;
  return (
    <section className="session-panel">
      <h3 className="session-title">
        <button
          className="session-toggle"
          aria-expanded={open}
          aria-controls={`session-${key}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name="arrow" size={16} />
          <span className="session-heading-text">
            <strong>{name}</strong>
            <span className="session-meta">
              {first.project} · {first.profile} · {count} {count === 1 ? "workflow" : "workflows"}
            </span>
            <span className="session-meta">
              {s?.nameSource ? "Recorded Claude title" : "No title recorded"} ·{" "}
              {first.session.slice(0, 8)} · {date(s?.modified ?? first.modified)}
            </span>
          </span>
          <span className="session-total">
            <small>Recorded tokens</small>
            <strong className="mono">{s?.usage.requests ? number(s.usage.total) : "—"}</strong>
          </span>
          <span className="session-total">
            <small>Est. session cost</small>
            <strong className="mono">{s ? <Cost usage={s.usage} /> : "—"}</strong>
            {s?.warnings.length ? <span className="badge quiet">Incomplete evidence</span> : null}
          </span>
        </button>
      </h3>
      {open ? (
        <div id={`session-${key}`} className="session-body">
          {s ? (
            <>
              <div className="session-breakdown">
                {[
                  ["Workflow agents", s.workflowUsage],
                  ["Parent conversation", s.parentUsage],
                  ["Other agents", s.otherUsage],
                ].map(([label, usage]) => {
                  const u = usage as Usage;
                  return (
                    <div key={label as string}>
                      <span>{label as string}</span>
                      <strong className="mono">
                        <Cost usage={u} />
                      </strong>
                      <small>
                        {number(u.total)} recorded tokens · {u.pricedRequests}/{u.requests} requests
                        priced
                      </small>
                      {u.unpricedTokens ? (
                        <small className="warning">
                          {[
                            ...new Set(
                              u.groups
                                .filter((g) => g.unpricedTokens || g.cost === null)
                                .map((g) => g.note),
                            ),
                          ].join(" ")}
                        </small>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {s.warnings.length ? (
                <div className="session-coverage">
                  <span className="warning">Estimate covers available evidence.</span>{" "}
                  {s.warnings.join(" ")}
                </div>
              ) : null}
              <div className="session-evidence-row">
                <span>
                  {s.usage.pricedRequests}/{s.usage.requests} requests priced · repeated response
                  IDs counted once
                </span>
                <button aria-expanded={pricing} onClick={() => setPricing(!pricing)}>
                  {pricing ? "Hide pricing" : "Usage & pricing"}
                </button>
              </div>
              {pricing ? (
                <div className="session-pricing">
                  <UsageView usage={s.usage} asOf={s.pricingAsOf} />
                </div>
              ) : null}
            </>
          ) : (
            <p className="notice">
              Session accounting has not been indexed yet. Workflow evidence is available below.
            </p>
          )}
          <div className="session-workflows-heading">
            <h4>Workflows in this session</h4>
            <span>
              {runs.length} of {count} shown
            </span>
          </div>
          <div className="table-wrap library">
            <WorkflowTable runs={runs} openRun={openRun} />
          </div>
          <details className="session-provenance">
            <summary>Session identity & source</summary>
            <dl className="metadata">
              <dt>Session ID</dt>
              <dd>{first.session}</dd>
              <dt>Title source</dt>
              <dd>{s?.nameSource ?? "Not recorded in Claude"}</dd>
              <dt>Transcript</dt>
              <dd>{s?.transcript ?? first.sessionInfo?.transcript ?? "Not recorded"}</dd>
              <dt>Indexed</dt>
              <dd>{date(s?.indexed ?? 0)}</dd>
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}
function RunDetail({
  run: r,
  online,
  onBack,
  onToast,
  onShare,
}: {
  run: Run;
  online: boolean;
  onBack: () => void;
  onShare: () => void;
  onToast: (s: string) => void;
}) {
  const [tab, setTab] = useState("overview");
  const [phase, setPhase] = useState(
    r.agents.find((a) => a.state === "running")?.phase ?? r.phases[0]?.title ?? "",
  );
  const [expandedAgents, setExpandedAgents] = useState<Record<string, string | undefined>>({});
  const [activityQuery, setActivityQuery] = useState("");
  const [activityAgent, setActivityAgent] = useState("all");
  const [eventLimit, setEventLimit] = useState(60);
  const agent = expandedAgents[phase];
  const selected = r.agents.find((a) => a.id === agent);
  const toggleAgent = (a: Agent) => {
    setExpandedAgents((current) => ({
      ...current,
      [a.phase]: current[a.phase] === a.id ? undefined : a.id,
    }));
  };
  const events = r.agents
    .flatMap((a) => a.events)
    .filter(
      (e) =>
        (activityAgent === "all" || e.agent === activityAgent) &&
        `${e.type} ${e.text} ${e.detail}`.toLowerCase().includes(activityQuery.toLowerCase()),
    )
    .sort((a, b) => b.time - a.time);
  const exportRun = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = r.id + ".json";
    a.click();
    URL.revokeObjectURL(url);
    onToast("Workflow evidence exported.");
  };
  return (
    <>
      <button className="back" onClick={onBack}>
        <Icon name="back" size={14} />
        Workflows
      </button>
      <div className="page-heading run-heading">
        <div>
          <div className="row">
            <span className="eyebrow">
              {r.project} / {r.profile}
            </span>
            <RunBadge run={r} />
          </div>
          <h1>{r.name}</h1>
          <p>{r.summary || "No workflow summary was recorded."}</p>
          <p className="run-session">Session: {r.sessionInfo?.name ?? r.session.slice(0, 8)}</p>
          <div className="run-ident">
            <code>{r.id}</code>
            <span>Started {date(r.started)}</span>
            <span>
              {online ? `Last activity ${since(r.modified)}` : `Snapshot ${date(r.indexed)}`}
            </span>
          </div>
        </div>
        <div className="run-actions">
          <ShareButton onClick={onShare} />
          <button onClick={exportRun}>
            <Icon name="download" />
            Export evidence
          </button>
        </div>
      </div>
      {r.outcome && r.executionState === "completed" ? (
        <div className="notice neutral">
          Workflow-reported status: <strong>{r.outcome.status}</strong>.
          {r.outcome.reason ? ` ${r.outcome.reason}` : ""}
          {r.outcome.truncated ? " Preview shortened; the full reported result is in Outputs." : ""}
        </div>
      ) : null}
      {!r.finalPath && r.agents.some((a) => a.state === "failed") ? (
        <div className="notice">
          Agent failure recorded. {r.state === "running" ? "Other agents are still running. " : ""}
          The final workflow outcome is not yet confirmed.
        </div>
      ) : null}
      {r.state === "quiet" && !r.finalPath ? (
        <div className="notice">
          No recent activity, and no final workflow record was found. This run may be waiting,
          disconnected or stopped; its outcome is unconfirmed.
        </div>
      ) : null}
      {r.warnings.map((w, i) => (
        <div className="notice" key={i}>
          {w}
        </div>
      ))}
      <div className="metrics">
        <Metric
          label="Total recorded tokens"
          value={r.usage.requests ? number(r.usage.total) : "—"}
          note={`${number(r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)} input · ${number(r.usage.output)} output`}
        />
        <Metric
          label="Est. API cost"
          value={<Cost usage={r.usage} />}
          note={`${r.usage.pricedRequests}/${r.usage.requests} requests priced · USD${r.agents.some((a) => !a.usage.requests) ? " · missing agent usage" : ""}`}
        />
        <Metric
          label="Elapsed, recorded"
          value={duration(r.duration)}
          note={
            r.finalPath
              ? "Final duration from workflow record"
              : "Through the last recorded activity"
          }
        />
        <Metric
          label="Agents"
          value={`${r.agents.filter((a) => a.state === "completed").length} / ${r.agents.length}`}
          note={`${r.agents.filter((a) => a.state === "running").length} active · completed / launched`}
        />
      </div>
      <nav className="tabs" aria-label="Workflow detail">
        {[
          ["overview", "Overview"],
          ["usage", "Usage & pricing"],
          ["activity", "Activity"],
          ["outputs", "Outputs"],
          ["source", "Source & metadata"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <>
          <div className="section-heading">
            <div>
              <h2>Follow the workflow</h2>
              <p>Select a phase, then expand an agent to inspect its work.</p>
            </div>
            <div className="legend">
              <span>
                <i className="dot running" />
                Running
              </span>
              <span>
                <i className="dot completed" />
                Completed
              </span>
              <span>
                <i className="dot quiet" />
                Attention
              </span>
              <span>
                <i className="dot failed" />
                Failed
              </span>
            </div>
          </div>
          <div className="phases">
            {r.phases.map((p, i) => {
              const agents = r.agents.filter((a) => a.phase === p.title);
              const recordedModels = [...new Set(agents.flatMap((a) => a.models))];
              const requestedModels = [
                ...new Set(agents.map((a) => a.model).filter((m) => m && m !== "Not recorded")),
              ];
              const models = agents.length
                ? recordedModels.length
                  ? recordedModels
                  : requestedModels
                : (p.plannedModels ?? []);
              const modelLabel = agents.length
                ? recordedModels.length
                  ? "Recorded models"
                  : "Requested models"
                : "Planned models";
              const state = agents.some((a) => a.state === "running")
                ? "running"
                : agents.some((a) => a.state === "failed")
                  ? "failed"
                  : agents.length && agents.every((a) => a.state === "completed")
                    ? "completed"
                    : agents.length
                      ? "quiet"
                      : "pending";
              return (
                <section key={p.title} className={`phase ${phase === p.title ? "expanded" : ""}`}>
                  <button
                    className="phase-header"
                    aria-expanded={phase === p.title}
                    onClick={() => setPhase(phase === p.title ? "" : p.title)}
                  >
                    <span className={`phase-index ${state}`}>
                      {state === "completed" ? "✓" : String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="phase-title">
                      <span className="phase-name-row">
                        <strong>{p.title}</strong>
                        {p.conditional ? <span className="badge quiet">Optional</span> : null}
                      </span>
                      <small>{p.detail || `${agents.length} recorded agents`}</small>
                    </span>
                    <span className="phase-summary">
                      <span className="mono">
                        {agents.some((a) => a.usage.pricedRequests)
                          ? money(agents.reduce((s, a) => s + a.usage.cost, 0))
                          : "—"}
                        {agents.some(
                          (a) => !a.usage.requests || a.usage.pricedRequests < a.usage.requests,
                        ) ? (
                          <span className="partial"> partial</span>
                        ) : null}
                      </span>
                      <Badge
                        state={state}
                        label={!agents.length && r.finalPath ? "Not observed" : undefined}
                      />
                      <Icon name="arrow" />
                    </span>
                  </button>
                  <div className="phase-plan-summary">
                    <span className="eyebrow">{modelLabel}</span>
                    {models.length ? (
                      models.map((model) => <ModelInfo key={model} model={model} />)
                    ) : (
                      <span className="small secondary">
                        {agents.length
                          ? "Not recorded"
                          : p.steps?.length && p.steps.every((s) => s.modelOrigin === "inherited")
                            ? "Inherits session model"
                            : "Unresolved from source plan"}
                      </span>
                    )}
                  </div>
                  {phase === p.title ? (
                    <div className="phase-body">
                      {agents.length && p.steps?.length ? (
                        <details className="source-plan-details">
                          <summary>
                            View source plan · {p.steps.length}{" "}
                            {p.steps.length === 1 ? "step" : "steps"}
                          </summary>
                          <PhasePlan phase={p} sourceNote={r.sourceNote} />
                        </details>
                      ) : null}
                      {agents.length ? (
                        agents.map((a) => (
                          <div className="agent" key={a.id}>
                            <div className="agent-row">
                              <button
                                className="agent-expand"
                                aria-expanded={agent === a.id}
                                onClick={() => toggleAgent(a)}
                              >
                                <span className="agent-symbol">
                                  <Icon />
                                </span>
                                <span className="agent-name">
                                  <strong>{a.label}</strong>
                                </span>
                              </button>
                              <ModelInfo model={a.model} resolved={a.models} />
                              <span className="agent-token mono">
                                {number(a.usage.total)}
                                <small>tokens</small>
                              </span>
                              <span className="agent-cost mono">
                                <Cost usage={a.usage} />
                              </span>
                              <Badge state={a.state} />
                              <button
                                className="icon-button"
                                aria-label={`${agent === a.id ? "Collapse" : "Expand"} ${a.label}`}
                                aria-expanded={agent === a.id}
                                onClick={() => toggleAgent(a)}
                              >
                                <Icon name="arrow" size={15} />
                              </button>
                            </div>
                            {agent === a.id ? (
                              <AgentDetail agent={a} onUsage={() => setTab("usage")} />
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <PhasePlan phase={p} sourceNote={r.sourceNote} />
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
          <div className="evidence-strip">
            <div>
              <span className="eyebrow">See the evidence</span>
              <h3>From the work to its cost.</h3>
              <p>Inspect recorded requests, model rates and cache usage behind this run.</p>
            </div>
            <button onClick={() => setTab("usage")}>
              Usage & pricing <Icon name="arrow" size={15} />
            </button>
          </div>
        </>
      ) : null}
      {tab === "usage" ? (
        <>
          <UsageView usage={r.usage} asOf={r.pricingAsOf} />
          <div className="section-heading">
            <div>
              <h2>Cost by agent</h2>
              <p>Exact agent labels and requested models from workflow metadata.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="agent-cost-table">
              <thead>
                <tr>
                  <th>Agent / phase</th>
                  <th>Requested model</th>
                  <th className="num">Tokens</th>
                  <th className="num">Est. API cost</th>
                </tr>
              </thead>
              <tbody>
                {r.agents.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        className="run-link"
                        onClick={() => {
                          setTab("overview");
                          setPhase(a.phase);
                          setExpandedAgents((current) => ({ ...current, [a.phase]: a.id }));
                        }}
                      >
                        {a.label}
                      </button>
                      <small>{a.phase}</small>
                    </td>
                    <td className="mono small">
                      <ModelInfo model={a.model} resolved={a.models} />
                    </td>
                    <td className="num mono">{number(a.usage.total)}</td>
                    <td className="num mono">
                      <Cost usage={a.usage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {tab === "activity" ? (
        <>
          <div className="section-heading">
            <div>
              <h2>Recorded activity</h2>
              <p>
                Tool inputs and results, grouped by exact agent. Latest 300 calls per agent retained
                in this view.
              </p>
            </div>
          </div>
          <div className="filter-row">
            <label className="search">
              <Icon name="search" />
              <input
                aria-label="Search activity"
                placeholder="Search tools, commands and results…"
                value={activityQuery}
                onChange={(e) => {
                  setActivityQuery(e.target.value);
                  setEventLimit(60);
                }}
              />
            </label>
            <select
              aria-label="Filter activity by agent"
              value={activityAgent}
              onChange={(e) => setActivityAgent(e.target.value)}
            >
              <option value="all">All agents</option>
              {r.agents.map((a) => (
                <option key={a.id} value={a.label}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="timeline">
            {events.slice(0, eventLimit).map((e) => (
              <ToolEvidence key={e.agent + e.id} event={e} />
            ))}
          </div>
          {!events.length ? (
            <div className="empty">No matching tool calls recorded.</div>
          ) : events.length > eventLimit ? (
            <button onClick={() => setEventLimit(eventLimit + 100)}>Show 100 more</button>
          ) : null}
        </>
      ) : null}
      {tab === "outputs" ? (
        <>
          <div className="section-heading">
            <div>
              <h2>Results & handoffs</h2>
              <p>Recorded agent outputs and the final workflow result.</p>
            </div>
          </div>
          {r.result !== null ? (
            <section className="panel">
              <h3>Workflow result</h3>
              <Result value={r.result} />
            </section>
          ) : (
            <div className="notice">No final workflow result is recorded yet.</div>
          )}
          {r.agents.map((a) => (
            <details className="output-panel" key={a.id}>
              <summary>
                <span>
                  <strong>{a.label}</strong>
                  <small>
                    {a.phase} · {a.model}
                  </small>
                </span>
                <Badge state={a.state} />
              </summary>
              <Result value={a.result ?? a.latestText ?? "No output recorded."} />
            </details>
          ))}
        </>
      ) : null}
      {tab === "source" ? (
        <>
          <div className="section-heading">
            <div>
              <h2>Source & provenance</h2>
              <p>Workflow source is read as text and parsed statically. It is never executed.</p>
            </div>
          </div>
          <dl className="metadata panel">
            <dt>Project</dt>
            <dd>{r.cwd || "Not recorded"}</dd>
            <dt>Profile</dt>
            <dd>{r.profile}</dd>
            <dt>Session name</dt>
            <dd>
              {r.sessionInfo?.name ?? "Not recorded in Claude"}
              {r.sessionInfo?.nameSource ? ` · ${r.sessionInfo.nameSource}` : ""}
            </dd>
            <dt>Session ID</dt>
            <dd>{r.session}</dd>
            <dt>Session transcript</dt>
            <dd>{r.sessionInfo?.transcript ?? "Not recorded"}</dd>
            <dt>Run ID</dt>
            <dd>{r.id}</dd>
            <dt>Workflow file</dt>
            <dd>{r.sourcePath || "Inline source"}</dd>
            <dt>Final record</dt>
            <dd>{r.finalPath || "Not present"}</dd>
            <dt>Indexed</dt>
            <dd>{date(r.indexed)}</dd>
            <dt>Runtime token metric</dt>
            <dd>
              {r.reportedTokens === null ? "Not recorded" : exact(r.reportedTokens)}{" "}
              <span className="secondary">· kept separate; not added to request usage</span>
            </dd>
          </dl>
          <p className="secondary">{r.sourceNote}</p>
          <CodeBlock
            className="source-code"
            code={r.source || "No workflow source is available for this run."}
            language={languageFor(r.sourcePath || "workflow.js")}
            label={r.sourcePath || "Workflow source"}
          />
        </>
      ) : null}
      {selected && tab === "overview" ? (
        <div className="footnote">
          Agent metadata is authoritative for labels, phases and requested models. Resolved models
          in usage come from the response records.
        </div>
      ) : null}
    </>
  );
}
function AgentDetail({ agent: a, onUsage }: { agent: Agent; onUsage: () => void }) {
  const [section, setSection] = useState("result");
  return (
    <div className="agent-detail">
      <div className="agent-detail-top">
        <div>
          <span className="eyebrow">Agent evidence</span>
          <h3>{a.label}</h3>
        </div>
        <code>{a.id}</code>
      </div>
      {a.availability && a.availability !== "available" ? (
        <p className="warning">
          Transcript unavailable. Cached content was deleted; this agent’s usage is excluded from
          current estimates.
        </p>
      ) : null}
      <div className="agent-facts">
        <div>
          <small>Recorded tokens</small>
          <strong title={exact(a.usage.total)}>
            {a.availability && a.availability !== "available"
              ? "Unavailable"
              : number(a.usage.total)}
          </strong>
        </div>
        <div>
          <small>Est. API cost</small>
          <strong>
            <Cost usage={a.usage} />
          </strong>
        </div>
        <div>
          <small>Peak input context</small>
          <strong>{number(a.usage.peakContext)}</strong>
        </div>
        <div>
          <small>Recorded duration</small>
          <strong>{duration(a.duration)}</strong>
        </div>
      </div>
      <div className="agent-provenance">
        <span>
          Requested <ModelInfo model={a.model} resolved={a.models} />
        </span>
        <span>
          Resolved{" "}
          {a.models.length
            ? a.models.map((m) => <ModelInfo key={m} model={m} />)
            : "No model recorded"}
        </span>
        <span>{a.toolCount} tool calls</span>
      </div>
      <div className="subtabs">
        {[
          ["result", "Result / latest update"],
          ["task", "Assigned task"],
          ["metadata", "Metadata"],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
        <button className="text-link" onClick={onUsage}>
          View pricing ↗
        </button>
      </div>
      {section === "result" ? (
        <Result value={a.result ?? a.latestText ?? "No update recorded yet."} />
      ) : section === "task" ? (
        <CodeBlock
          code={a.task || "No task prompt recorded."}
          language="markdown"
          label="Assigned task"
        />
      ) : (
        <dl className="metadata">
          <dt>Label source</dt>
          <dd>{a.metadataSource}</dd>
          <dt>Phase</dt>
          <dd>{a.phase}</dd>
          <dt>Transcript</dt>
          <dd>{a.transcript}</dd>
          <dt>Started</dt>
          <dd>{date(a.started)}</dd>
          <dt>Last activity</dt>
          <dd>{date(a.modified)}</dd>
          <dt>Runtime token metric</dt>
          <dd>
            {a.reportedTokens === null ? "Not recorded" : exact(a.reportedTokens)} · separate from
            usage
          </dd>
        </dl>
      )}
      {a.warnings.map((w) => (
        <p className="warning small" key={w}>
          {w}
        </p>
      ))}
    </div>
  );
}
function Result({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <p className="secondary">No result recorded yet.</p>;
  if (typeof value === "object" && !Array.isArray(value))
    return (
      <div className="result-fields">
        {Object.entries(value as RecordData).map(([key, v]) => (
          <section key={key}>
            <h4>{key.replace(/([A-Z])/g, " $1")}</h4>
            {Array.isArray(v) && v.every((x) => typeof x === "string") ? (
              <ul>
                {v.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <CodeBlock
                code={typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                language={typeof v === "string" ? "markdown" : "json"}
                label={key}
              />
            )}
          </section>
        ))}
      </div>
    );
  return (
    <CodeBlock
      code={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      language={typeof value === "string" ? "markdown" : "json"}
      label="Recorded output"
    />
  );
}
function UsageView({ usage: u, asOf }: { usage: Usage; asOf: string }) {
  const categories = [
    ["Uncached input", u.input, "input"],
    ["Cache reads", u.cacheRead, "cache"],
    ["Cache writes", u.cacheWrite, "write"],
    ["Output", u.output, "output"],
  ] as const;
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Usage, with the price attached</h2>
          <p>
            Recorded token usage summed across unique response IDs. Context size is shown
            separately. Rates snapshot: {date(Date.parse(asOf))}.
          </p>
        </div>
        <span className="badge pending">USD / 1M tokens</span>
      </div>
      <section className="usage-overview panel">
        <div className="usage-total">
          <span className="eyebrow">Est. API token cost</span>
          <strong>
            <Cost usage={u} />
          </strong>
          <span>
            {u.pricedRequests} of {u.requests} recorded requests priced
          </span>
        </div>
        <div className="usage-breakdown">
          <div className="token-bar">
            {categories.map(([label, count, color]) => (
              <div
                key={label}
                className={color}
                style={{ width: `${u.total ? (count / u.total) * 100 : 0}%` }}
                title={`${label}: ${exact(count)}`}
              />
            ))}
          </div>
          <div className="token-legend">
            {categories.map(([label, count, color]) => (
              <div key={label}>
                <span>
                  <i className={`token-dot ${color}`} />
                  {label}
                </span>
                <strong>{exact(count)}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
      <div className="notice neutral">
        API-equivalent estimate using current standard provider rates from{" "}
        <a href="https://models.dev" target="_blank" rel="noreferrer">
          Models.dev
        </a>
        , with Anthropic’s published one-hour cache-write rate (2× input). This is not your
        subscription bill or a historical invoice. Fast mode, regional uplifts, discounts and
        non-token tool fees are excluded. Unmatched models or missing category rates stay unpriced.
      </div>
      {u.unpricedTokens > 0 ? (
        <p className="warning">
          {exact(u.unpricedTokens)} recorded tokens are excluded from this estimate. See the model
          notes below.
        </p>
      ) : null}
      <div className="model-grid">
        {u.groups.map((g) => (
          <section className="model-card" key={g.model}>
            <header>
              <div>
                <span className="eyebrow">{g.provider ?? "Provider unresolved"}</span>
                <h3>
                  <ModelInfo model={g.model} />
                </h3>
              </div>
              <strong
                className="mono"
                title={`${g.pricedRequests ?? (g.cost === null ? 0 : g.requests)} of ${g.requests} recorded requests priced`}
              >
                {money(g.cost)}
                {g.cost !== null && g.unpricedTokens > 0 ? (
                  <span className="partial"> partial</span>
                ) : null}
              </strong>
            </header>
            <div className="model-stats">
              <span>{number(g.tokens)} tokens</span>
              <span>
                {g.pricedRequests ?? (g.cost === null ? 0 : g.requests)}/{g.requests} requests
                priced
              </span>
              <span>
                {g.contextLimit
                  ? number(g.contextLimit) + " context limit"
                  : "Context limit unknown"}
              </span>
            </div>
            <table className="rate-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Recorded</th>
                  <th className="num">Base / 1M</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Input", g.input, "input"],
                  ["Cache read", g.cacheRead, "cache_read"],
                  [
                    g.provider === "anthropic" ? "Cache write · 5m" : "Cache write · standard",
                    Math.max(0, g.cacheWrite - (g.cacheWrite1h ?? 0)),
                    "cache_write",
                  ],
                  ...(g.provider === "anthropic" || g.cacheWrite1h
                    ? [["Cache write · 1h", g.cacheWrite1h ?? 0, "cache_write_1h"]]
                    : []),
                  ["Output", g.output, "output"],
                ].map(([label, count, key]) => (
                  <tr key={String(key)}>
                    <td>{label}</td>
                    <td className="num mono">{number(Number(count))}</td>
                    <td className="num mono">
                      {typeof g.rates?.[key as string] === "number"
                        ? `$${g.rates[key as string]}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {g.rates?.tiers?.length ? (
              <details className="tier-details">
                <summary>Long-context pricing tiers</summary>
                {g.rates.tiers.map((t: RecordData, i: number) => (
                  <p key={i}>
                    Above {exact(t.tier.size)} {t.tier.type} tokens: input ${t.input}, cache read $
                    {t.cache_read ?? "—"}, cache write ${t.cache_write ?? "—"}
                    {t.cache_write_1h != null ? ` (1h $${t.cache_write_1h})` : ""}, output $
                    {t.output} / 1M.
                  </p>
                ))}
              </details>
            ) : null}
            <p className="small secondary">
              {g.note}
              {g.tiers.length
                ? ` Higher tiers applied above ${g.tiers.map(number).join(", ")} input tokens per request.`
                : ""}
            </p>
            {g.modelMatch === "alias" ? (
              <p className="small secondary">
                Priced using <code>{g.pricedAs}</code> · configured alias. Recorded ID preserved.
              </p>
            ) : null}
            {g.provider === "anthropic" && g.rates?.cache_write_1h != null ? (
              <p className="small secondary">
                1h cache writes use 2× the applicable input rate. Other write tokens use the
                standard 5m rate.{" "}
                <a href={CACHE_WRITE_1H_SOURCE} target="_blank" rel="noreferrer">
                  Anthropic cache pricing ↗
                </a>
              </p>
            ) : null}
            {g.provider ? (
              <a
                className="small"
                href={`https://models.dev/providers/${g.provider}`}
                target="_blank"
                rel="noreferrer"
              >
                Provider catalog ↗
              </a>
            ) : null}
          </section>
        ))}
      </div>
      <div className="context-note">
        <Icon name="layers" />
        <div>
          <strong>Peak input context: {number(u.peakContext)} tokens</strong>
          <p>
            The largest recorded request input, including cache. It is not cumulative usage and is
            not charged again.
          </p>
        </div>
      </div>
      {!u.requests ? (
        <div className="empty">No per-request usage was recorded for this workflow.</div>
      ) : null}
    </>
  );
}
function Sources({
  status,
  online,
  refresh,
  onToast,
}: {
  status: RecordData | null;
  online: boolean;
  refresh: () => void;
  onToast: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const initial = () => location.hash.split("/")[1] || "sources";
  const [tab, setTab] = useState(initial);
  useEffect(() => {
    const change = () => setTab(initial());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return (
    <div className="content settings-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Make it yours</span>
          <h1>Settings</h1>
          <p>Your sources, model pricing and access across devices.</p>
        </div>
      </div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {["sources", "models", "access", "updates"].map((value) => (
          <a
            key={value}
            href={"#settings/" + value}
            className={tab === value ? "selected" : ""}
            aria-current={tab === value ? "page" : undefined}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </a>
        ))}
      </nav>
      {tab === "access" ? (
        <AccessSettings status={status} online={online} onToast={onToast} />
      ) : tab === "updates" ? (
        <UpdateSettings status={status} onToast={onToast} />
      ) : (
        <>
          {tab === "sources" ? (
            <>
              <div className="section-heading">
                <div>
                  <h2>Workflow folders</h2>
                  <p>Profiles are checked every five seconds. Your source files stay untouched.</p>
                </div>
                <button onClick={refresh}>
                  <Icon name="refresh" />
                  Rescan sources
                </button>
              </div>
              <div className="source-cards">
                {status?.sources?.map((source: RecordData) => (
                  <section className="panel" key={source.path}>
                    <header className="row between">
                      <Icon name="folder" size={25} />
                      <Badge
                        state={source.state === "connected" ? "completed" : "quiet"}
                        label={source.state}
                      />
                    </header>
                    <h3>{source.path.replace(/^\/Users\/[^/]+/, "~")}</h3>
                    <p>
                      {source.runs} workflow candidates · last {status?.discoveryDays ?? 7} days
                    </p>
                    <code>{source.path}</code>
                    {source.error ? <p className="warning">{source.error}</p> : null}
                  </section>
                ))}
              </div>
            </>
          ) : null}
          <SourceConfig
            status={status}
            onToast={onToast}
            section={tab === "models" ? "models" : "sources"}
          />
          {tab === "models" ? (
            <>
              {" "}
              <section className="panel catalog-panel">
                <div>
                  <span className="eyebrow">Model data</span>
                  <h2>Models.dev</h2>
                  <p>
                    Exact provider model IDs, token prices, cache rates, context limits and pricing
                    tiers.
                  </p>
                  <p className="small secondary">
                    {status?.catalog?.source ?? "Bundled offline snapshot"} · updated{" "}
                    {status?.catalog?.updated ? date(Date.parse(status.catalog.updated)) : "—"}
                  </p>
                  <a href="https://models.dev" target="_blank" rel="noreferrer">
                    Browse Models.dev ↗
                  </a>
                </div>
                <button
                  disabled={
                    busy || ["queued", "updating"].includes(status?.settings?.catalog?.state)
                  }
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await request("/api/catalog/refresh", { method: "POST" });
                      onToast("Catalog refresh requested.");
                    } catch {
                      onToast("Catalog refresh failed. The saved snapshot remains available.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Icon name="refresh" />
                  {busy || ["queued", "updating"].includes(status?.settings?.catalog?.state)
                    ? "Refreshing…"
                    : "Refresh model data"}
                </button>
              </section>
              {status?.settings?.catalog?.error ? (
                <div className="notice">
                  Could not refresh model data. Using the saved catalog:{" "}
                  {status.settings.catalog.error}
                </div>
              ) : null}
            </>
          ) : null}
          {status?.errors?.length ? (
            <section className="panel">
              <h3>Discovery issues</h3>
              {status.errors.map((e: string) => (
                <p className="warning" key={e}>
                  {e}
                </p>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
