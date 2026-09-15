import type { Phase } from "../types";
import { ModelInfo } from "./ModelInfo";

export function PhasePlan({ phase, sourceNote }: { phase: Phase; sourceNote: string }) {
  if (!phase.steps?.length)
    return (
      <p className="phase-empty">
        No agent launch recorded.{" "}
        {phase.plannedModels?.length
          ? "Models are declared in phase metadata."
          : "Observer could not resolve this phase’s models from the available source and recorded arguments. Models may still have been supplied."}
      </p>
    );
  return (
    <div className="phase-plan">
      <p className="small secondary">
        Source plan · {sourceNote || "Statically analyzed workflow source."} These steps do not add
        recorded usage.
      </p>
      {phase.steps.map((step) => (
        <div className="planned-step" key={step.id}>
          <div className="planned-step-name">
            <strong>{step.label}</strong>
            <small>
              {step.kind === "workflow" ? "Child workflow" : "Planned agent"}
              {!step.labelExact ? " · label unresolved in source plan" : ""}
              {step.line ? ` · source line ${step.line}` : ""}
              {step.assignedPhase ? ` · worker assigned to ${step.assignedPhase}` : ""}
            </small>
          </div>
          <div className="planned-step-model">
            {step.model ? (
              <ModelInfo model={step.model} />
            ) : step.models?.length ? (
              <>
                <small>Possible planned models</small>
                {step.models.map((model) => (
                  <ModelInfo key={model} model={model} />
                ))}
              </>
            ) : (
              <span className="small secondary">
                {step.kind === "workflow"
                  ? "Models defined by child workflow"
                  : step.modelOrigin === "inherited"
                    ? "Inherits session model · default not recorded"
                    : "Model unresolved from source plan"}
              </span>
            )}
            {step.modelOrigin === "inherited" && step.model ? (
              <small>Recorded session default</small>
            ) : null}
            {step.modelOrigin === "mixed" ? <small>May inherit the session model</small> : null}
            {step.models?.length && step.modelsComplete === false ? (
              <small>Some model choices remain unresolved.</small>
            ) : null}
            {step.effort ? <small>Effort: {step.effort}</small> : null}
          </div>
          <div className="planned-step-condition">
            <span className={`badge ${step.optional ? "quiet" : "pending"}`}>
              {step.optional ? "Optional" : "Unconditional"}
            </span>
            <small>
              {step.conditionalReason === "branch"
                ? "Conditional branch"
                : step.conditionalReason === "guard"
                  ? "Depends on earlier checks"
                  : step.conditionalReason === "loop"
                    ? "May run zero times"
                    : ""}
              {step.max === null
                ? ` · ${step.min}+ launches possible`
                : step.max > 1
                  ? ` · ${step.min === step.max ? step.max : `${step.min}–${step.max}`} planned launches`
                  : ""}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}
