import { useEffect, useState } from "react";
import { isFinishedRun } from "../status";
import { Drawer } from "@base-ui/react/drawer";
import type { RunSummary } from "../types";
import { Icon } from "./Icon";

type NavigationProps = {
  runs: RunSummary[];
  projects: string[];
  page: string;
  project: string;
  filter: string;
  online: boolean;
  loaded: boolean;
  networkEnabled: boolean;
  onLibrary: (project?: string, filter?: string) => void;
  onSettings: () => void;
};

function NavigationItems({
  runs,
  projects,
  page,
  project,
  filter,
  onLibrary,
  mobile = false,
}: NavigationProps & { mobile?: boolean }) {
  const choices = [
    { value: "all", label: "All workflows", icon: "layers", count: runs.length },
    {
      value: "running",
      label: "Running",
      dot: "running",
      count: runs.filter((r) => r.state === "running").length,
    },
    {
      value: "finished",
      label: "History",
      icon: "clock",
      count: runs.filter(isFinishedRun).length,
    },
    ...(mobile
      ? [
          {
            value: "attention",
            label: "Attention",
            dot: "quiet",
            count: runs.filter((r) => ["quiet", "interrupted"].includes(r.state)).length,
          },
          {
            value: "failed",
            label: "Failed",
            dot: "failed",
            count: runs.filter((r) => r.state === "failed").length,
          },
        ]
      : []),
  ];
  return (
    <nav aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      <div className="nav-group">
        <span className="eyebrow">Workspace</span>
        <div className="workspace-links">
          {choices.map((item) => {
            const selected = page === "library" && project === "all" && filter === item.value;
            return (
              <button
                key={item.value}
                className={`nav-item ${selected ? "selected" : ""}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => onLibrary("all", item.value)}
              >
                {item.dot ? <i className={`dot ${item.dot}`} /> : <Icon name={item.icon} />}
                <span>{item.label}</span>
                <b>{item.count}</b>
              </button>
            );
          })}
        </div>
      </div>
      <div className="nav-group projects">
        <span className="eyebrow">
          Projects <span>{projects.length}</span>
        </span>
        {projects.map((p) => {
          const selected = project === p && page === "library";
          return (
            <button
              key={p}
              className={`nav-item ${selected ? "selected" : ""}`}
              aria-current={selected ? "page" : undefined}
              onClick={() => onLibrary(p)}
              title={runs.find((r) => r.project === p)?.cwd}
            >
              <Icon name="folder" />
              <span>{p}</span>
              <b>{runs.filter((r) => r.project === p).length}</b>
            </button>
          );
        })}
        {!projects.length ? (
          <p className="navigation-empty">Projects appear when workflows are discovered.</p>
        ) : null}
      </div>
    </nav>
  );
}

function SettingsButton({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return (
    <button
      className={`nav-item ${selected ? "selected" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      <Icon name="settings" />
      <span>Settings</span>
      <Icon name="arrow" size={14} />
    </button>
  );
}

export function Navigation(props: NavigationProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 701px)");
    const close = () => setOpen(false);
    const resize = () => {
      if (desktop.matches) close();
    };
    desktop.addEventListener("change", resize);
    window.addEventListener("hashchange", close);
    return () => {
      desktop.removeEventListener("change", resize);
      window.removeEventListener("hashchange", close);
    };
  }, []);
  const navigate = (action: () => void) => {
    setOpen(false);
    action();
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const connection = props.online
    ? "Companion connected"
    : props.loaded
      ? "Companion offline"
      : "Connecting…";
  return (
    <aside className="sidebar">
      <a href="#" className="logo" onClick={() => props.onLibrary()}>
        <Icon size={27} />
        Observer
      </a>
      <div className="desktop-navigation">
        <NavigationItems {...props} />
      </div>
      <div className="sidebar-bottom">
        <SettingsButton selected={props.page === "sources"} onClick={props.onSettings} />
        <div className="connection">
          <i className={`dot ${props.online ? "completed" : "quiet"}`} />
          {connection}
        </div>
        <p>
          {props.networkEnabled ? "Your devices. Your workflows." : "Private. On this computer."}
        </p>
      </div>
      <Drawer.Root open={open} onOpenChange={setOpen} swipeDirection="down">
        <Drawer.Trigger className="mobile-menu-trigger" aria-label="Open navigation">
          <Icon name="menu" size={18} />
          Menu
        </Drawer.Trigger>
        <Drawer.Portal>
          <Drawer.Backdrop className="navigation-backdrop" />
          <Drawer.Viewport className="navigation-viewport">
            <Drawer.Popup
              className="navigation-drawer"
              finalFocus={() =>
                window.matchMedia("(min-width: 701px)").matches
                  ? document.querySelector<HTMLAnchorElement>(".sidebar .logo")
                  : true
              }
            >
              <div className="navigation-handle" aria-hidden="true" />
              <div className="navigation-header">
                <div>
                  <span className="eyebrow">Observer</span>
                  <Drawer.Title>Your workspace</Drawer.Title>
                </div>
                <Drawer.Close className="navigation-close" aria-label="Close navigation">
                  <Icon name="close" size={20} />
                </Drawer.Close>
              </div>
              <Drawer.Description className="navigation-description">
                Browse your workflows, projects, and settings.
              </Drawer.Description>
              <Drawer.Content className="navigation-scroll">
                <NavigationItems
                  {...props}
                  mobile
                  onLibrary={(p, f) => navigate(() => props.onLibrary(p, f))}
                />
              </Drawer.Content>
              <div className="navigation-footer">
                <SettingsButton
                  selected={props.page === "sources"}
                  onClick={() => navigate(props.onSettings)}
                />
                <div className="connection">
                  <i className={`dot ${props.online ? "completed" : "quiet"}`} />
                  {connection}
                </div>
              </div>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    </aside>
  );
}
