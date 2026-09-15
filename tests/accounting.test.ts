import { test, expect } from "bun:test";
import { Catalog } from "../src/catalog";
import { summarizeUsage, normalizeUsage, combineUsage } from "../src/pricing";
const catalog = new Catalog("/unused");
catalog.providers = {
  openai: {
    models: {
      "gpt-fixture": {
        id: "gpt-fixture",
        limit: { context: 1000000 },
        cost: {
          input: 4,
          output: 20,
          cache_read: 0.4,
          cache_write: 5,
          tiers: [
            {
              tier: { type: "context", size: 272000 },
              input: 8,
              output: 30,
              cache_read: 0.8,
              cache_write: 10,
            },
          ],
          context_over_200k: { input: 8, output: 30 },
        },
      },
    },
  },
} as any;
const usage = (u: Record<string, unknown>, model = "gpt-fixture") =>
  summarizeUsage({ r: { model, usage: u } }, catalog);

test("native OpenAI inclusive cache counts do not double count", () => {
  const u = normalizeUsage({
    input_tokens: 25000,
    input_tokens_details: { cached_tokens: 20000 },
    output_tokens: 500,
  });
  expect(u.input).toBe(5000);
  expect(u.total).toBe(25500);
});
test("explicit 272k tier overrides deprecated 200k alias and applies per request", () => {
  expect(usage({ input_tokens: 250000, output_tokens: 1000 }).cost).toBeCloseTo(1.02);
  expect(usage({ input_tokens: 272001, output_tokens: 1000 }).cost).toBeCloseTo(2.206008);
  const combined = combineUsage([usage({ input_tokens: 200000 }), usage({ input_tokens: 200000 })]);
  expect(combined.cost).toBeCloseTo(1.6);
  expect(combined.peakContext).toBe(200000);
});
test("exact unknown IDs stay unpriced; known requested model is not substituted", () => {
  const u = usage({ input_tokens: 1000 }, "gpt-fixture-build");
  expect(u.pricedRequests).toBe(0);
  expect(u.unpricedTokens).toBe(1000);
  expect(u.groups[0].cost).toBeNull();
});
test("Anthropic's 1h multiplier is not inferred for other providers", () => {
  const u = usage({
    input_tokens: 2,
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 1000 },
  });
  expect(u.pricedRequests).toBe(0);
  expect(u.groups[0].note).toContain("1h");
});
test("zero usage, synthetic messages and missing records are not fake priced requests", () => {
  expect(
    summarizeUsage(
      {
        a: { model: "<synthetic>", usage: { input_tokens: 100 } },
        b: { model: "gpt-fixture", usage: { input_tokens: 0 } },
      },
      catalog,
    ).requests,
  ).toBe(0);
});
