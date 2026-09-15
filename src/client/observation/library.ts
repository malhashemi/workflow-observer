import type { RunSummary, SessionSummary } from "../../types";
import { cutoffFor, type WindowDays } from "../../windows";

export interface LibrarySnapshot {
  days: WindowDays;
  updatedAt: number;
  capturedAt: number;
  runs: RunSummary[];
  sessions: SessionSummary[];
}
export const emptyLibrary = (days: WindowDays): LibrarySnapshot => ({
  days,
  updatedAt: 0,
  capturedAt: 0,
  runs: [],
  sessions: [],
});

// Offline snapshots age too. Never let a larger window leak into the selected one.
export function limitLibrary(
  saved: LibrarySnapshot | null,
  days: WindowDays,
  now = Date.now(),
): LibrarySnapshot {
  if (!saved || saved.days !== days) return emptyLibrary(days);
  const runs = saved.runs.filter((r) => r.modified >= cutoffFor(days, now));
  const keys = new Set(runs.map((r) => r.key));
  const sessions = saved.sessions.filter(
    (s) => s.windowDays === days && s.runKeys.every((key) => keys.has(key)),
  );
  return { ...saved, runs, sessions };
}
