import { test, expect } from "bun:test";
import { applyConfigChange } from "../src/config-changes";
import { defaultConfig, defaultAccess } from "../src/config";

test("new installs and the shipped sample contain no personal aliases", async () => {
  expect(defaultConfig.modelAliases).toEqual({});
  expect(
    await Bun.file(new URL("../observer.config.example.json", import.meta.url)).json(),
  ).toEqual({ ...defaultConfig, access: defaultAccess });
});

test("alias add, edit, rename and removal preserve other settings and reject conflicting edits", () => {
  const initial = {
    ...defaultConfig,
    claudeDirectories: ["~/.claude", "/work/claude"],
    modelAliases: { existing: "xai/model-one" },
  };
  const added = applyConfigChange(initial, {
    type: "set-alias",
    recorded: " bridge-model ",
    target: " xai/model-two ",
  });
  expect(added.modelAliases).toEqual({
    existing: "xai/model-one",
    "bridge-model": "xai/model-two",
  });
  expect(added.claudeDirectories).toEqual(initial.claudeDirectories);
  expect(initial.modelAliases).toEqual({ existing: "xai/model-one" });
  expect(() =>
    applyConfigChange(added, {
      type: "set-alias",
      recorded: "bridge-model",
      target: "xai/replacement",
    }),
  ).toThrow("already exists");
  const renamed = applyConfigChange(added, {
    type: "set-alias",
    recorded: "renamed",
    target: "xai/model-three",
    previous: { recorded: "bridge-model", target: "xai/model-two" },
  });
  expect(renamed.modelAliases).toEqual({ existing: "xai/model-one", renamed: "xai/model-three" });
  expect(() =>
    applyConfigChange(renamed, { type: "remove-alias", recorded: "renamed", target: "xai/stale" }),
  ).toThrow("changed elsewhere");
  expect(() =>
    applyConfigChange(renamed, {
      type: "set-alias",
      recorded: "renamed",
      target: "xai/new",
      previous: { recorded: "renamed", target: "xai/stale" },
    }),
  ).toThrow("changed elsewhere");
  const removed = applyConfigChange(renamed, {
    type: "remove-alias",
    recorded: "renamed",
    target: "xai/model-three",
  });
  expect(removed).toEqual(initial);
});

test("directory actions preserve aliases; malformed targets and unknown actions fail", () => {
  const initial = { ...defaultConfig, modelAliases: { bridge: "xai/model" } };
  const added = applyConfigChange(initial, { type: "add-directory", path: " /work/claude " });
  expect(added.claudeDirectories).toEqual(["~/.claude", "/work/claude"]);
  expect(added.modelAliases).toEqual(initial.modelAliases);
  expect(applyConfigChange(added, { type: "remove-directory", path: "/work/claude" })).toEqual(
    initial,
  );
  expect(() =>
    applyConfigChange(initial, { type: "set-alias", recorded: "bridge-2", target: "unqualified" }),
  ).toThrow();
  expect(() =>
    applyConfigChange(initial, { type: "set-alias", recorded: "__proto__", target: "xai/model" }),
  ).toThrow();
  expect(() => applyConfigChange(initial, { type: "overwrite", modelAliases: {} })).toThrow();
});
