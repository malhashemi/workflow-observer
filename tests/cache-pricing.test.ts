import { test, expect } from "bun:test";
import { Catalog } from "../src/catalog";
import { combineUsage, normalizeUsage, summarizeUsage } from "../src/pricing";
import { sessionUsage } from "../src/sessions";

const catalog = new Catalog("/unused");
catalog.providers = {
  anthropic: {
    models: {
      "claude-fixture": {
        id: "claude-fixture",
        limit: { context: 1000000 },
        cost: {
          input: 10,
          output: 50,
          cache_read: 0.25,
          cache_write: 12.5,
          tiers: [{ tier: { type: "context", size: 200000 }, input: 20, cache_write: 25 }],
        },
      },
    },
  },
} as any;
const message = (usage: Record<string, unknown>) => ({ model: "claude-fixture", usage });
const recordedParent = message({
  input_tokens: 2,
  output_tokens: 310,
  output_tokens_details: { thinking_tokens: 88 },
  cache_read_input_tokens: 36378,
  cache_creation_input_tokens: 13827,
  cache_creation: { ephemeral_1h_input_tokens: 13827, ephemeral_5m_input_tokens: 0 },
  iterations: [{ input_tokens: 2, output_tokens: 310, cache_creation_input_tokens: 13827 }],
});

test("prices recorded parent 1h writes without counting iterations or thinking twice", () => {
  const u = summarizeUsage({ parent: recordedParent }, catalog);
  expect(u.cost).toBeCloseTo((2 * 10 + 310 * 50 + 36378 * 0.25 + 13827 * 20) / 1e6, 10);
  expect(u.total).toBe(50517);
  expect(u.cacheWrite).toBe(13827);
  expect(u.cacheWrite1h).toBe(13827);
  expect(u.pricedRequests).toBe(1);
  expect(u.unpricedTokens).toBe(0);
  expect(u.groups[0].rates?.cache_read).toBe(0.25);
  expect(u.groups[0].rates?.cache_write_1h).toBe(20);
  expect(catalog.lookup("claude-fixture")?.record.cost).not.toHaveProperty("cache_write_1h");
  expect((catalog.modelInfo("claude-fixture") as any).rates.cache_write_1h).toBe(20);
});

test("mixed cache durations charge disjoint token counts", () => {
  const u = summarizeUsage(
    {
      m: message({
        input_tokens: 100,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      }),
    },
    catalog,
  );
  expect(u.cost).toBeCloseTo((100 * 10 + 1000 * 12.5 + 2000 * 20) / 1e6, 10);
  expect(u.total).toBe(3100);
  expect(u.pricedRequests).toBe(1);
});

test("cache duration details can provide the aggregate when absent", () => {
  const u = normalizeUsage({
    input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  });
  expect(u.input).toBe(100);
  expect(u.cacheWrite).toBe(3000);
  expect(u.total).toBe(3100);
  expect(u.validCacheSplit).toBe(true);
});

test("legacy aggregate writes retain the standard rate; explicit zero 1h agrees", () => {
  for (const detail of [
    {},
    { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1000 } },
  ]) {
    const u = summarizeUsage(
      { m: message({ cache_creation_input_tokens: 1000, ...detail }) },
      catalog,
    );
    expect(u.cost).toBeCloseTo(0.0125, 10);
    expect(u.pricedRequests).toBe(1);
  }
});

test("1h rate follows each request's applicable input tier", () => {
  const u = summarizeUsage(
    {
      m: message({
        input_tokens: 200000,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 1000 },
      }),
    },
    catalog,
  );
  expect(u.cost).toBeCloseTo(4.04, 10);
  expect(u.groups[0].tiers).toEqual([200000]);
  expect(u.groups[0].rates?.tiers[0].cache_write_1h).toBe(40);
});

test("inconsistent cache duration evidence is excluded with a reason", () => {
  for (const ttl of [
    { ephemeral_1h_input_tokens: 2000 },
    { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 1000 },
    { ephemeral_1h_input_tokens: -1 },
  ]) {
    const u = summarizeUsage(
      { m: message({ cache_creation_input_tokens: 1000, cache_creation: ttl }) },
      catalog,
    );
    expect(u.pricedRequests).toBe(0);
    expect(u.unpricedTokens).toBe(1000);
    expect(u.groups[0].note).toContain("disagree");
  }
});

test("known model subtotals survive an unpriced request and combination in either order", () => {
  const good = recordedParent;
  const bad = message({
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 2000 },
  });
  const a = summarizeUsage({ good }, catalog);
  const b = summarizeUsage({ bad }, catalog);
  for (const u of [
    summarizeUsage({ good, bad }, catalog),
    summarizeUsage({ bad, good }, catalog),
    combineUsage([a, b]),
    combineUsage([b, a]),
  ]) {
    expect(u.groups[0].cost).toBe(a.cost);
    expect(u.groups[0].pricedRequests).toBe(1);
    expect(u.groups[0].unpricedTokens).toBe(1000);
    expect(u.groups[0].note).toContain("disagree");
    expect(u.requests).toBe(2);
    expect(u.cacheWrite1h).toBe(15827);
    expect(u.unpricedTokens).toBe(1000);
  }
});

test("session totals price parent writes while shared response IDs count once", () => {
  const u = sessionUsage(
    [
      { kind: "parent", messages: { shared: recordedParent, parent: recordedParent } },
      { kind: "workflow", messages: { shared: recordedParent } },
    ],
    "session",
    catalog,
  );
  const single = summarizeUsage({ recordedParent }, catalog);
  expect(u.usage.requests).toBe(2);
  expect(u.usage.pricedRequests).toBe(2);
  expect(u.parentUsage.cost).toBe(single.cost);
  expect(u.workflowUsage.cost).toBe(single.cost);
  expect(u.usage.cost).toBe(single.cost * 2);
  expect(u.conflictingRequests).toBe(0);
});
