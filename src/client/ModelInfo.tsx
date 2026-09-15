import { useEffect, useState } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import type { RecordData } from "../types";
function load(model: string) {
  return fetch("/api/models/" + encodeURIComponent(model))
    .then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    })
    .catch(() => {
      return { found: false, offline: true, id: model };
    });
}
const count = (n: unknown) =>
  typeof n === "number"
    ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(n)
    : "—";
const price = (n: unknown) => (typeof n === "number" ? `$${n}` : "—");
export function ModelInfo({ model, resolved = [] }: { model: string; resolved?: string[] }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RecordData | null>(null);
  useEffect(() => {
    let active = true;
    if (open)
      load(model).then((d) => {
        if (active) setData(d);
      });
    return () => {
      active = false;
    };
  }, [open, model]);
  const provider =
    data?.provider ??
    (model.includes("/")
      ? model.split("/")[0]
      : model.startsWith("claude-")
        ? "anthropic"
        : model.startsWith("gpt-")
          ? "openai"
          : model.startsWith("grok-")
            ? "xai"
            : null);
  const m = data?.model;
  const rates = data?.rates ?? m?.cost;
  return (
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={180} closeDelay={200}>
      <HoverCard.Trigger asChild>
        <button
          className="model-trigger"
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            if (!e.relatedTarget?.closest?.(".model-popover")) setOpen(false);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              e.stopPropagation();
            }
          }}
          aria-expanded={open}
          aria-label={`Model information: ${model}`}
        >
          {provider ? (
            <img
              className="provider-logo"
              src={`/api/logos/${provider}.svg`}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          ) : null}
          <span>{model}</span>
          <span className="model-info-mark">ⓘ</span>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="model-popover"
          sideOffset={9}
          collisionPadding={16}
          side="bottom"
          onEscapeKeyDown={() => setOpen(false)}
          onPointerDownOutside={() => setOpen(false)}
        >
          <header>
            <div>
              {provider ? (
                <img className="provider-logo large" src={`/api/logos/${provider}.svg`} alt="" />
              ) : null}
              <div>
                <span className="eyebrow">{data?.providerName ?? "Model information"}</span>
                <h3>{m?.name ?? model}</h3>
              </div>
            </div>
            <button
              className="icon-button"
              aria-label="Close model information"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          {!data ? (
            <p className="secondary">Loading Models.dev metadata…</p>
          ) : !data.found ? (
            <>
              <p className="secondary">
                {data.offline
                  ? "Model metadata is unavailable offline."
                  : "No exact catalog model or configured alias matches this ID. Its generation is not inferred."}
              </p>
              {resolved.length ? (
                <p className="small">
                  Resolved in this agent: <code>{resolved.join(", ")}</code>
                </p>
              ) : null}
            </>
          ) : (
            <>
              {data.match === "alias" ? (
                <p className="small secondary">
                  Recorded ID: <code>{model}</code>
                  <br />
                  Priced using <code>{data.matchedModel}</code> · configured alias.
                </p>
              ) : null}
              <p className="model-description">{m.description}</p>
              <div className="model-info-grid">
                <div>
                  <small>Context capacity</small>
                  <strong>{count(m.limit?.context)}</strong>
                </div>
                <div>
                  <small>Max output</small>
                  <strong>{count(m.limit?.output)}</strong>
                </div>
                <div>
                  <small>Released</small>
                  <strong>{m.release_date ?? "—"}</strong>
                </div>
                <div>
                  <small>Knowledge cutoff</small>
                  <strong>{m.knowledge ?? "—"}</strong>
                </div>
              </div>
              <div className="capabilities">
                {[
                  ["Reasoning", m.reasoning],
                  ["Tools", m.tool_call],
                  ["Structured output", m.structured_output],
                  ["Images", m.modalities?.input?.includes("image")],
                ]
                  .filter(([, value]) => value)
                  .map(([label]) => (
                    <span key={String(label)}>{label}</span>
                  ))}
              </div>
              <div className="popover-rates">
                <span>Standard API · USD / 1M tokens</span>
                <div>
                  <span>
                    Input <b>{price(rates?.input)}</b>
                  </span>
                  <span>
                    Output <b>{price(rates?.output)}</b>
                  </span>
                  <span>
                    Cache read <b>{price(rates?.cache_read)}</b>
                  </span>
                  <span>
                    Cache write{data.provider === "anthropic" ? " · 5m" : ""}{" "}
                    <b>{price(rates?.cache_write)}</b>
                  </span>
                  {rates?.cache_write_1h != null ? (
                    <span>
                      Cache write · 1h <b>{price(rates.cache_write_1h)}</b>
                    </span>
                  ) : null}
                </div>
              </div>
              {data.cachePricingSource ? (
                <p className="small secondary">
                  1h cache writes: 2× input, per{" "}
                  <a href={data.cachePricingSource} target="_blank" rel="noreferrer">
                    Anthropic pricing
                  </a>
                  .
                </p>
              ) : null}
              {m.cost?.tiers?.length ? (
                <p className="small secondary">
                  Higher rates apply above{" "}
                  {m.cost.tiers.map((t: RecordData) => count(t.tier.size)).join(", ")} input tokens
                  per request.
                </p>
              ) : null}
              <p className="small secondary">
                Context capacity is a model limit, not this run’s recorded usage.
              </p>
            </>
          )}
          <footer>
            <a href="https://models.dev" target="_blank" rel="noreferrer">
              Models.dev ↗
            </a>
            <span>
              {data?.catalogUpdated
                ? `Catalog ${new Date(data.catalogUpdated).toLocaleDateString()}`
                : ""}
            </span>
          </footer>
          <HoverCard.Arrow className="model-popover-arrow" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
