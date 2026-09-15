import { analyzeWorkflowTopology } from "../vendor/ultracode/scripts/diagram/analyze-topology.mjs";
import { argumentDescriptors } from "./plan-arguments";
import type { Phase, PlannedStep, RecordData } from "./types";

export function analyzePlan(source: string, args?: unknown, defaultModel?: string) {
  const topology = analyzeWorkflowTopology(source, (index: RecordData) =>
    argumentDescriptors(index, args, defaultModel),
  );
  return { ...topology, phases: mergePhases([], topology) };
}

// Final metadata supplies recorded titles/details; static source adds planning evidence
// by exact phase title. Never turn these call sites into recorded agents or usage.
export function mergePhases(recorded: (RecordData | string)[], plan: RecordData): Phase[] {
  const entries = (items: (RecordData | string)[]) =>
    items.map((p) => (typeof p === "string" ? { title: p } : p));
  const source = [...entries(plan.meta?.phases ?? []), ...entries(plan.phases ?? [])];
  const final = entries(recorded);
  const titles = [
    ...new Set([...final, ...source].map((p) => p.title).filter((t) => typeof t === "string" && t)),
  ];
  return titles.map((title) => {
    const p = Object.assign(
      {},
      ...source.filter((p) => p.title === title),
      ...final.filter((p) => p.title === title),
    );
    const direct = (plan.nodes ?? []).filter((n: RecordData) => n.phase === title);
    const delegated = direct.length
      ? []
      : (plan.nodes ?? []).filter(
          (n: RecordData) => n.phase !== title && n.contextPhases?.includes(title),
        );
    const steps: PlannedStep[] = [...direct, ...delegated].map((n: RecordData) => ({
      id: n.id,
      label: n.kind === "workflow" || n.labelDeclared ? n.label : "Agent call",
      labelExact: n.kind === "workflow" || n.labelDeclared ? n.labelExact : false,
      model: n.model ?? null,
      models: n.models ?? [],
      modelsComplete: n.modelsComplete ?? Boolean(n.model),
      modelOrigin: n.modelOrigin,
      assignedPhase: n.phase !== title ? n.phase : undefined,
      effort: n.effort ?? null,
      optional: Boolean(n.conditional),
      conditionalReason: n.conditionalReason ?? null,
      kind: n.kind === "workflow" ? "workflow" : "agent",
      min: n.multiplicity?.min ?? 0,
      max: n.multiplicity?.max ?? null,
      line: n.source?.invocationLine ?? n.source?.definitionLine ?? null,
    }));
    const models = [
      ...new Set(
        [
          ...steps.flatMap((s) => [s.model, ...(s.models ?? [])]),
          ...(Array.isArray(p.models) ? p.models : []),
          ...(typeof p.model === "string" ? [p.model] : []),
        ].filter((m): m is string => typeof m === "string" && m.length > 0),
      ),
    ];
    return {
      title,
      detail: p.detail ?? "",
      planned:
        steps.length && steps.every((s) => s.max !== null && s.min === s.max)
          ? steps.reduce((n, s) => n + s.min, 0)
          : null,
      conditional:
        p.optional === true ||
        p.conditional === true ||
        (steps.length > 0 && steps.every((s) => s.optional)),
      plannedModels: models,
      steps,
    };
  });
}
