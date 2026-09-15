import type { Catalog } from "./catalog";
import type { RecordData, Usage, UsageGroup } from "./types";
import { providerRates, validRate } from "./pricing-rules";
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  total: 0,
  peakContext: 0,
  requests: 0,
  pricedRequests: 0,
  unpricedTokens: 0,
  cost: 0,
  groups: [],
});
const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
export function normalizeUsage(u: RecordData) {
  const read = number(
    u.cache_read_input_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_tokens_details?.cached_tokens,
  );
  const ttl = u.cache_creation;
  const write1h = number(ttl?.ephemeral_1h_input_tokens);
  const write5m = number(ttl?.ephemeral_5m_input_tokens);
  const write = number(u.cache_creation_input_tokens ?? write1h + write5m);
  const validCacheSplit =
    (ttl?.ephemeral_1h_input_tokens == null || validRate(ttl.ephemeral_1h_input_tokens)) &&
    (ttl?.ephemeral_5m_input_tokens == null || validRate(ttl.ephemeral_5m_input_tokens)) &&
    write1h <= write &&
    write5m <= write &&
    (ttl?.ephemeral_5m_input_tokens == null || write1h + write5m === write);
  const raw = number(u.input_tokens ?? u.prompt_tokens);
  // Claude bridge envelopes already separate cache input, including GPT/Grok.
  const separate =
    "cache_read_input_tokens" in u || "cache_creation_input_tokens" in u || "cache_creation" in u;
  const input = separate ? raw : Math.max(0, raw - read - write);
  const output = number(u.output_tokens ?? u.completion_tokens);
  return {
    input,
    output,
    cacheRead: read,
    cacheWrite: write,
    context: input + read + write,
    total: input + read + write + output,
    write1h,
    validCacheSplit,
  };
}
export function summarizeUsage(messages: Record<string, RecordData>, catalog: Catalog): Usage {
  const total = emptyUsage();
  const groups = new Map<string, UsageGroup>();
  for (const message of Object.values(messages)) {
    const n = normalizeUsage(message.usage ?? {});
    if (!n.total || message.model === "<synthetic>") continue;
    const model = message.model || "Unknown model";
    const found = catalog.lookup(model);
    const base = providerRates(found?.provider, found?.record.cost);
    let rates = base;
    let threshold = 0;
    // Prefer explicit tier thresholds over the legacy context_over_200k alias.
    for (const tier of [...(base?.tiers ?? [])].sort((a, b) => a.tier.size - b.tier.size)) {
      if (tier.tier.type === "context" && n.context > tier.tier.size) {
        rates = { ...base, ...tier };
        threshold = tier.tier.size;
      }
    }
    if (!base?.tiers?.length && base?.context_over_200k && n.context > 200000) {
      rates = { ...base, ...base.context_over_200k };
      threshold = 200000;
    }
    const categories: [number, unknown][] = [
      [n.input, rates?.input],
      [n.output, rates?.output],
      [n.cacheRead, rates?.cache_read],
      [n.cacheWrite - n.write1h, rates?.cache_write],
      [n.write1h, rates?.cache_write_1h],
    ];
    const priced =
      n.validCacheSplit && categories.every(([tokens, rate]) => tokens === 0 || validRate(rate));
    const cost = priced
      ? categories.reduce((sum, [tokens, rate]) => sum + (tokens * number(rate)) / 1e6, 0)
      : null;
    let group = groups.get(model);
    if (!group) {
      group = {
        model,
        pricedAs: found?.matchedModel,
        modelMatch: found?.match,
        provider: found?.provider ?? null,
        tokens: 0,
        requests: 0,
        pricedRequests: 0,
        unpricedTokens: 0,
        cost: null,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        contextLimit: found?.record.limit.context ?? null,
        rates: base ?? null,
        note: found
          ? "Standard API equivalent; current Models.dev rates."
          : "No exact Models.dev provider model match.",
        tiers: [],
      };
      groups.set(model, group);
    }
    group.tokens += n.total;
    group.requests++;
    group.input += n.input;
    group.output += n.output;
    group.cacheRead += n.cacheRead;
    group.cacheWrite += n.cacheWrite;
    group.cacheWrite1h += n.write1h;
    if (cost === null) {
      const note = !n.validCacheSplit
        ? "Cache-write duration counts disagree with recorded totals; affected requests excluded."
        : !found
          ? "No exact Models.dev provider model match; requests excluded from estimate."
          : n.write1h && !validRate(rates?.cache_write_1h)
            ? "1h cache-write rate unavailable for this provider; affected requests excluded."
            : "Some recorded categories have no rate; affected requests excluded from estimate.";
      if (!group.unpricedTokens) group.note = note;
      else if (!group.note.includes(note)) group.note += " " + note;
      group.unpricedTokens += n.total;
      total.unpricedTokens += n.total;
    } else {
      group.cost = (group.cost ?? 0) + cost;
      group.pricedRequests++;
      total.cost += cost;
      total.pricedRequests++;
    }
    if (threshold && !group.tiers.includes(threshold)) group.tiers.push(threshold);
    total.input += n.input;
    total.output += n.output;
    total.cacheRead += n.cacheRead;
    total.cacheWrite += n.cacheWrite;
    total.cacheWrite1h += n.write1h;
    total.total += n.total;
    total.requests++;
    total.peakContext = Math.max(total.peakContext, n.context);
  }
  total.groups = [...groups.values()];
  return total;
}
export function combineUsage(items: Usage[]): Usage {
  const total = emptyUsage();
  const groups = new Map<string, UsageGroup>();
  for (const item of items) {
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cacheWrite1h",
      "total",
      "requests",
      "pricedRequests",
      "unpricedTokens",
      "cost",
    ] as const)
      total[key] += item[key] ?? 0;
    total.peakContext = Math.max(total.peakContext, item.peakContext);
    for (const g of item.groups) {
      const prior = groups.get(g.model);
      if (!prior) groups.set(g.model, { ...g, tiers: [...g.tiers] });
      else {
        for (const k of [
          "tokens",
          "requests",
          "pricedRequests",
          "unpricedTokens",
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "cacheWrite1h",
        ] as const)
          prior[k] = (prior[k] ?? 0) + (g[k] ?? 0);
        prior.cost =
          prior.cost === null && g.cost === null ? null : (prior.cost ?? 0) + (g.cost ?? 0);
        prior.tiers = [...new Set([...prior.tiers, ...g.tiers])];
        if (g.unpricedTokens && !prior.note.includes(g.note)) prior.note += " " + g.note;
      }
    }
  }
  total.groups = [...groups.values()];
  return total;
}
