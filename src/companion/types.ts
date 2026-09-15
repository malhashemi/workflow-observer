export type Address = { kind: "local" | "lan" | "tailscale"; label: string; url: string };
export type RemoteState = {
  state: "disabled" | "connecting" | "ready" | "unavailable" | "failed";
  hostname: string | null;
  url: string | null;
  error: string | null;
};
export type Installation = {
  kind: "bun-global" | "npm-global" | "development" | "bunx" | "unknown";
  root: string;
  version: string;
  manager?: string;
  prefix?: string;
};
export type UpdateState = {
  state: "unchecked" | "checking" | "current" | "available" | "failed";
  latest: string | null;
  checkedAt: number | null;
  error: string | null;
};
export type CompanionSnapshot = {
  actionCommand: string;
  instanceId: string;
  version: string;
  build: string;
  installation: Installation;
  localPort: number;
  portOverride: string | null;
  addresses: Address[];
  state: "ready" | "applying" | "failed" | "stopping";
  error: string | null;
  remote: RemoteState;
  lanError: string | null;
  pending: boolean;
  sharingDefault: "lan" | "tailscale";
  openAddress: Address["kind"];
  update: UpdateState;
};
export type InstanceRecord = {
  instanceId: string;
  pid: number;
  configPath: string;
  localUrl: string;
  version: string;
  build: string;
  runtime: string;
};
