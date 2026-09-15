import { Schema } from "effect";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
const ConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  claudeDirectories: Schema.Array(Schema.String),
  port: Schema.Number.pipe(Schema.int(), Schema.between(1024, 65535)),
  openBrowser: Schema.Boolean,
  access: Schema.optional(
    Schema.Struct({
      lanEnabled: Schema.Boolean,
      tailscaleEnabled: Schema.Boolean,
      tailscalePort: Schema.Number.pipe(Schema.int(), Schema.between(1024, 65535)),
      sharingDefault: Schema.Literal("lan", "tailscale"),
      openAddress: Schema.Literal("local", "lan", "tailscale"),
    }),
  ),
  modelAliases: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
export type ObserverConfig = typeof ConfigSchema.Type;
export const defaultAccess = {
  lanEnabled: false,
  tailscaleEnabled: false,
  tailscalePort: 8443,
  sharingDefault: "tailscale",
  openAddress: "local",
} as const;
export const accessOf = (config: ObserverConfig) => ({ ...defaultAccess, ...config.access });
export const defaultConfig: ObserverConfig = {
  version: 1,
  claudeDirectories: ["~/.claude"],
  port: 4319,
  openBrowser: true,
  modelAliases: {},
};
export const expandDirectory = (path: string, home = homedir()) => path.replace(/^~(?=\/|$)/, home);
export function validateModelAlias(recorded: string, target: string) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(recorded) ||
    !/^[a-z0-9-]+\/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(target)
  )
    throw new Error("Model aliases must map an exact recorded ID to provider/model.");
}
export function validateConfig(value: unknown): ObserverConfig {
  const config = Schema.decodeUnknownSync(ConfigSchema)(value);
  if (config.claudeDirectories.length > 32) throw new Error("Use at most 32 Claude directories.");
  const aliases = Object.entries(config.modelAliases ?? {});
  if (aliases.length > 128) throw new Error("Use at most 128 model aliases.");
  for (const [recorded, target] of aliases) validateModelAlias(recorded, target);
  for (const path of config.claudeDirectories)
    if (!path.trim() || !isAbsolute(expandDirectory(path)) || path.includes("\0"))
      throw new Error("Claude directories must be absolute paths or start with ~/");
  return {
    ...config,
    modelAliases: Object.fromEntries(aliases),
    claudeDirectories: [...new Set(config.claudeDirectories.map((p) => p.trim()))],
  };
}
export function userPaths(env: Record<string, string | undefined> = process.env, home = homedir()) {
  const configBase = env.XDG_CONFIG_HOME || join(home, ".config");
  const dataBase = env.XDG_DATA_HOME || join(home, ".local", "share");
  if (!isAbsolute(configBase) || !isAbsolute(dataBase))
    throw new Error("XDG_CONFIG_HOME and XDG_DATA_HOME must be absolute paths.");
  return {
    configPath: env.WORKFLOW_OBSERVER_CONFIG
      ? resolve(expandDirectory(env.WORKFLOW_OBSERVER_CONFIG, home))
      : join(configBase, "workflow-observer", "config.json"),
    dataDir: env.OBSERVER_DATA_DIR
      ? resolve(expandDirectory(env.OBSERVER_DATA_DIR, home))
      : join(dataBase, "workflow-observer"),
  };
}
