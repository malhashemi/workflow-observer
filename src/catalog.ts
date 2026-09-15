import { Models, type ProviderMap } from "@opencode-ai/models";
import { providers as snapshot, generatedAt } from "@opencode-ai/models/snapshot";
import { Effect, Data, Schedule } from "effect";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CACHE_WRITE_1H_SOURCE, providerRates } from "./pricing-rules";

class CatalogError extends Data.TaggedError("CatalogError")<{ message: string }> {}
const fingerprints = new WeakMap<ProviderMap, string>();
export class Catalog {
  providers: ProviderMap = snapshot;
  updated = generatedAt;
  source = "Bundled Models.dev snapshot";
  error: string | null = null;
  constructor(
    readonly dataDir: string,
    public aliases: Record<string, string> = {},
    private readonly fetchProviders = () =>
      Models.make().providers({ signal: AbortSignal.timeout(12000) }),
  ) {}
  snapshot(aliases = this.aliases) {
    const view = new Catalog(this.dataDir, { ...aliases });
    view.providers = this.providers;
    view.updated = this.updated;
    view.source = this.source;
    return view;
  }
  get fingerprint() {
    let rates = fingerprints.get(this.providers);
    if (!rates) {
      rates = createHash("sha256").update(JSON.stringify(this.providers)).digest("hex");
      fingerprints.set(this.providers, rates);
    }
    return JSON.stringify([
      rates,
      Object.entries(this.aliases).sort(([a], [b]) => a.localeCompare(b)),
    ]);
  }
  load = Effect.gen(this, function* () {
    const cached = Bun.file(join(this.dataDir, "models.json"));
    if (yield* Effect.promise(() => cached.exists())) {
      yield* Effect.tryPromise(async () => {
        const data = await cached.json();
        if (data.providers?.anthropic?.models) {
          this.providers = data.providers;
          this.updated = data.updated;
          this.source = "Cached Models.dev catalog";
        }
      }).pipe(Effect.catchAll(() => Effect.void));
    }
  });
  // Fetch and persist a candidate without publishing rates into an in-flight scan.
  prepare: Effect.Effect<Catalog, Error> = Effect.gen(this, function* () {
    const providers = yield* Effect.tryPromise({
      try: () => this.fetchProviders(),
      catch: (e) => new CatalogError({ message: String(e) }),
    }).pipe(Effect.retry(Schedule.recurs(1)));
    const candidate = this.snapshot();
    candidate.providers = providers;
    candidate.updated = new Date().toISOString();
    candidate.source = "Models.dev API";
    yield* Effect.tryPromise(async () => {
      const path = join(this.dataDir, "models.json");
      const tmp = path + "." + crypto.randomUUID() + ".tmp";
      try {
        const file = await open(tmp, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({ providers, updated: candidate.updated }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, path);
        const directory = await open(this.dataDir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(tmp, { force: true });
      }
    });
    return candidate;
  });
  publish(candidate: Catalog) {
    this.providers = candidate.providers;
    this.updated = candidate.updated;
    this.source = candidate.source;
    this.error = null;
  }
  lookup(model: string) {
    const slash = model.indexOf("/");
    const provider =
      slash > 0
        ? model.slice(0, slash)
        : model.startsWith("claude-")
          ? "anthropic"
          : model.startsWith("gpt-")
            ? "openai"
            : model.startsWith("grok-")
              ? "xai"
              : null;
    const id = slash > 0 ? model.slice(slash + 1) : model;
    const record = provider ? this.providers[provider]?.models[id] : undefined;
    if (record)
      return {
        provider: provider!,
        record,
        matchedModel: `${provider}/${id}`,
        match: "exact" as const,
      };
    // Aliases are explicit user configuration, never suffix stripping or fuzzy matching.
    const target = Object.hasOwn(this.aliases, model) ? this.aliases[model] : undefined;
    if (!target) return null;
    const separator = target.indexOf("/");
    const targetProvider = target.slice(0, separator);
    const targetId = target.slice(separator + 1);
    const matched = this.providers[targetProvider]?.models[targetId];
    return matched
      ? { provider: targetProvider, record: matched, matchedModel: target, match: "alias" as const }
      : null;
  }
  modelInfo(model: string) {
    const match = this.lookup(model);
    return match
      ? {
          found: true,
          id: model,
          provider: match.provider,
          matchedModel: match.matchedModel,
          match: match.match,
          providerName: this.providers[match.provider]?.name ?? match.provider,
          logo: `/api/logos/${match.provider}.svg`,
          model: match.record,
          rates: providerRates(match.provider, match.record.cost),
          cachePricingSource: match.provider === "anthropic" ? CACHE_WRITE_1H_SOURCE : null,
          catalogUpdated: this.updated,
          source: "https://models.dev",
        }
      : { found: false, id: model, catalogUpdated: this.updated, source: "https://models.dev" };
  }
  async logo(provider: string): Promise<string | null> {
    if (!/^[a-z0-9-]+$/.test(provider) || !Object.hasOwn(this.providers, provider)) return null;
    const dir = join(this.dataDir, "logos");
    const file = Bun.file(join(dir, provider + ".svg"));
    if (await file.exists()) return file.text();
    try {
      const response = await fetch(`https://models.dev/logos/${provider}.svg`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const svg = await response.text();
      if (svg.length > 200000 || !svg.includes("<svg")) return null;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await Bun.write(file, svg);
      return svg;
    } catch {
      return null;
    }
  }
  info() {
    return {
      updated: this.updated,
      source: this.source,
      error: this.error,
      url: "https://models.dev",
      providerCount: Object.keys(this.providers).length,
      aliasCount: Object.keys(this.aliases).length,
    };
  }
}
