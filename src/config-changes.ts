import { Schema } from "effect";
import { validateConfig, validateModelAlias, accessOf, type ObserverConfig } from "./config";

const PreviousAlias = Schema.Struct({ recorded: Schema.String, target: Schema.String });
const ChangeSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("set-preference"),
    field: Schema.Literal(
      "port",
      "openBrowser",
      "lanEnabled",
      "tailscaleEnabled",
      "tailscalePort",
      "sharingDefault",
      "openAddress",
    ),
    value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    previous: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("add-directory", "remove-directory"), path: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("set-alias"),
    recorded: Schema.String,
    target: Schema.String,
    previous: Schema.optional(PreviousAlias),
  }),
  Schema.Struct({
    type: Schema.Literal("remove-alias"),
    recorded: Schema.String,
    target: Schema.String,
  }),
);
export type ConfigChange = typeof ChangeSchema.Type;

export function applyConfigChange(config: ObserverConfig, value: unknown): ObserverConfig {
  const change = Schema.decodeUnknownSync(ChangeSchema)(value);
  if (change.type === "set-preference") {
    const local = change.field === "port" || change.field === "openBrowser";
    const current = local
      ? config[change.field as "port" | "openBrowser"]
      : accessOf(config)[change.field as keyof ReturnType<typeof accessOf>];
    if (current !== change.previous)
      throw new Error("This setting changed elsewhere. Reload before saving it.");
    return validateConfig(
      local
        ? { ...config, [change.field]: change.value }
        : { ...config, access: { ...accessOf(config), [change.field]: change.value } },
    );
  }
  if (change.type === "add-directory" || change.type === "remove-directory")
    return validateConfig({
      ...config,
      claudeDirectories:
        change.type === "add-directory"
          ? [...config.claudeDirectories, change.path.trim()]
          : config.claudeDirectories.filter((p) => p !== change.path),
    });
  const aliases = { ...config.modelAliases };
  if (change.type === "remove-alias") {
    if (aliases[change.recorded] !== change.target)
      throw new Error("This alias changed elsewhere. Reload its values before removing it.");
    delete aliases[change.recorded];
  } else if (change.type === "set-alias") {
    const recorded = change.recorded.trim();
    validateModelAlias(recorded, change.target.trim());
    if (change.previous && aliases[change.previous.recorded] !== change.previous.target)
      throw new Error(
        "This alias changed elsewhere. Cancel editing and reopen it to use the latest values.",
      );
    if (Object.hasOwn(aliases, recorded) && change.previous?.recorded !== recorded)
      throw new Error("An alias for this recorded model already exists. Edit that alias instead.");
    if (change.previous) delete aliases[change.previous.recorded];
    aliases[recorded] = change.target.trim();
  }
  return validateConfig({ ...config, modelAliases: aliases });
}
