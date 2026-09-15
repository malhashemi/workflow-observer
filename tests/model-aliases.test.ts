import { test, expect } from "bun:test";
import { Catalog } from "../src/catalog";
import { summarizeUsage } from "../src/pricing";
import { defaultConfig, validateConfig } from "../src/config";

function fixture(aliases: Record<string, string> = {}) {
  const c = new Catalog("/unused", aliases);
  c.providers = {
    xai: {
      models: {
        "grok-fixture": {
          id: "grok-fixture",
          limit: { context: 500000 },
          cost: {
            input: 2,
            output: 6,
            cache_read: 0.5,
            tiers: [
              { tier: { type: "context", size: 200000 }, input: 4, output: 12, cache_read: 1 },
            ],
          },
        },
      },
    },
    other: {
      models: {
        "grok-fixture": {
          id: "grok-fixture",
          limit: { context: 500000 },
          cost: { input: 10, output: 20 },
        },
      },
    },
  } as any;
  return c;
}

test("explicit provider/model lookup and native exact IDs take priority over aliases", () => {
  const c = fixture({ "grok-fixture": "other/grok-fixture" });
  expect(c.lookup("xai/grok-fixture")?.provider).toBe("xai");
  expect(c.lookup("other/grok-fixture")?.provider).toBe("other");
  expect(c.lookup("grok-fixture")?.provider).toBe("xai");
  expect(c.lookup("grok-fixture-build")).toBeNull();
});

test("configured aliases preserve the recorded model and apply matched context tiers", () => {
  const c = fixture({ "grok-fixture-build": "xai/grok-fixture" });
  const u = summarizeUsage(
    {
      r: {
        model: "grok-fixture-build",
        usage: { input_tokens: 200001, output_tokens: 100, cache_read_input_tokens: 1000 },
      },
    },
    c,
  );
  expect(u.pricedRequests).toBe(1);
  expect(u.cost).toBeCloseTo((200001 * 4 + 100 * 12 + 1000) / 1e6, 10);
  expect(u.groups[0]).toMatchObject({
    model: "grok-fixture-build",
    pricedAs: "xai/grok-fixture",
    modelMatch: "alias",
    provider: "xai",
  });
  expect(c.modelInfo("grok-fixture-build")).toMatchObject({
    id: "grok-fixture-build",
    matchedModel: "xai/grok-fixture",
    match: "alias",
  });
});

test("missing alias targets and chains never guess a fallback; alias changes invalidate pricing", () => {
  const c = fixture({ "grok-fixture-build": "xai/missing" });
  const before = c.fingerprint;
  expect(c.lookup("grok-fixture-build")).toBeNull();
  c.aliases = { "grok-fixture-build": "xai/grok-fixture" };
  expect(c.fingerprint).not.toBe(before);
  c.aliases = { "grok-fixture-build": "xai/alias", "xai/alias": "xai/grok-fixture" };
  expect(c.lookup("grok-fixture-build")).toBeNull();
});

test("existing configs remain valid and aliases require explicit provider-qualified targets", () => {
  const { modelAliases: _aliases, ...legacy } = defaultConfig;
  expect(validateConfig(legacy).modelAliases).toEqual({});
  expect(
    validateConfig({ ...legacy, modelAliases: { "grok-4.6-build": "xai/grok-4.6" } }).modelAliases,
  ).toEqual({ "grok-4.6-build": "xai/grok-4.6" });
  for (const target of ["grok-4.6", "xai/", "https://example.com", "xai/model with spaces"])
    expect(() => validateConfig({ ...legacy, modelAliases: { model: target } })).toThrow();
});
