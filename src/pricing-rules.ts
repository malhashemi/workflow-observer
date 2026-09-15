import type { RecordData } from "./types";

// Include this revision in index fingerprints so cached usage is repriced after a rule change.
export const PRICING_REVISION = "cache-ttl-v1";
export const CACHE_WRITE_1H_SOURCE =
  "https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching";
export const validRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function providerRates(provider: string | undefined, cost: RecordData | undefined) {
  if (!cost) return undefined;
  const rates = { ...cost };
  // Models.dev supplies the model's base rates. Anthropic documents the separate
  // 1-hour write price as 2x input. Preserve its model-specific cache-read price.
  if (provider === "anthropic" && validRate(cost.input)) {
    rates.cache_write_1h = cost.input * 2;
    if (cost.tiers)
      rates.tiers = cost.tiers.map((tier: RecordData) => ({
        ...tier,
        cache_write_1h: (tier.input ?? cost.input) * 2,
      }));
    if (cost.context_over_200k)
      rates.context_over_200k = {
        ...cost.context_over_200k,
        cache_write_1h: (cost.context_over_200k.input ?? cost.input) * 2,
      };
  }
  return rates;
}
