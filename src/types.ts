// External transcript records vary by Claude version and provider bridge.
export type RecordData = Record<string, any>;
export type State =
  | "running"
  | "completed"
  | "finished"
  | "quiet"
  | "failed"
  | "interrupted"
  | "pending";
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  total: number;
  peakContext: number;
  requests: number;
  pricedRequests: number;
  unpricedTokens: number;
  cost: number;
  groups: UsageGroup[];
}
export interface UsageGroup {
  model: string;
  pricedAs?: string;
  modelMatch?: "exact" | "alias";
  provider: string | null;
  tokens: number;
  requests: number;
  cost: number | null;
  pricedRequests: number;
  unpricedTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  contextLimit: number | null;
  rates: RecordData | null;
  note: string;
  tiers: number[];
}
export interface RecordedEdit {
  file: string;
  before: string;
  after: string;
  replaceAll: boolean;
  outcome: "applied" | "failed" | "unknown";
}
export interface Event {
  id: string;
  time: number;
  agent: string;
  type: string;
  text: string;
  detail?: string;
  inputText?: string;
  outputText?: string;
  edit?: RecordedEdit;
  error?: boolean;
}
export interface Agent {
  availability?: "available" | "missing" | "unreadable";
  id: string;
  label: string;
  phase: string;
  model: string;
  models: string[];
  state: State;
  started: number;
  modified: number;
  duration: number;
  usage: Usage;
  task: string;
  result: unknown;
  latestText: string;
  events: Event[];
  toolCount: number;
  transcript: string;
  metadataSource: string;
  reportedTokens: number | null;
  warnings: string[];
}
export interface PlannedStep {
  modelOrigin?: "explicit" | "inherited" | "mixed" | "dynamic";
  modelsComplete?: boolean;
  assignedPhase?: string;
  id: string;
  label: string;
  labelExact: boolean;
  model: string | null;
  models?: string[];
  effort: string | null;
  optional: boolean;
  conditionalReason: string | null;
  kind: "agent" | "workflow";
  min: number;
  max: number | null;
  line: number | null;
}
export interface Phase {
  title: string;
  detail: string;
  conditional?: boolean;
  planned?: number | null;
  plannedModels?: string[];
  steps?: PlannedStep[];
}
export interface SessionIdentity {
  key: string;
  name: string | null;
  nameSource: "custom-title" | "ai-title" | null;
  transcript: string;
}
export interface SessionSummary extends SessionIdentity {
  windowDays?: number;
  excludedWorkflows?: number;
  id: string;
  profile: string;
  project: string;
  cwd: string;
  runKeys: string[];
  started: number;
  modified: number;
  usage: Usage;
  workflowUsage: Usage;
  parentUsage: Usage;
  otherUsage: Usage;
  warnings: string[];
  pricingAsOf: string;
  indexed: number;
}
export interface Run {
  key: string;
  id: string;
  profile: string;
  project: string;
  cwd: string;
  session: string;
  sessionInfo?: SessionIdentity;
  name: string;
  summary: string;
  state: State;
  executionState?: State | null;
  outcome?: { status: string; reason: string; truncated?: boolean } | null;
  started: number;
  modified: number;
  duration: number;
  agents: Agent[];
  phases: Phase[];
  usage: Usage;
  pricingAsOf: string;
  sourcePath: string;
  source: string;
  sourceNote: string;
  result: unknown;
  warnings: string[];
  indexed: number;
  finalPath: string;
  reportedTokens: number | null;
}
export type RunSummary = Omit<Run, "agents" | "source" | "result"> & {
  agentCount: number;
  activeAgents: number;
};
