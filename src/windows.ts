export const WINDOW_DAYS = [1, 7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_WINDOW: WindowDays = 7;
export const windowLabel = (days: WindowDays) => (days === 1 ? "Last 24h" : `Last ${days} days`);
export const cutoffFor = (days: WindowDays, now = Date.now()) => now - days * 86_400_000;
export function parseWindow(value: string | null): WindowDays {
  if (value === null) return DEFAULT_WINDOW;
  if (!["1", "7", "30", "90"].includes(value))
    throw new Error("Time window must be 1, 7, 30 or 90 days.");
  return Number(value) as WindowDays;
}

// Browser tabs have independent demands. A delayed selection cannot widen a newer one.
export class WindowDemand {
  private leases = new Map<string, { days: WindowDays; expires: number; selection: number }>();
  touch(days: WindowDays, now = Date.now(), client = "default", selection = 0) {
    const previous = this.leases.get(client);
    if (previous && selection < previous.selection) return false;
    const added = !previous || previous.days !== days || previous.expires <= now;
    this.leases.set(client, { days, expires: now + 30_000, selection });
    return added;
  }
  active(now = Date.now()): WindowDays[] {
    // Keep only tiny ordering metadata after expiry. A delayed request must not resurrect
    // an older range just because its active lease expired; this resets on companion restart.
    const active = [...this.leases.values()].filter((v) => v.expires > now);
    return active.length ? [...new Set(active.map((v) => v.days))] : [DEFAULT_WINDOW];
  }
}
