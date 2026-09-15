import { test, expect } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, userPaths, validateConfig } from "../src/config";
import { Settings } from "../src/settings";
import { highlight } from "../src/client/highlight";
test("defaults are portable and config/data live outside the package", () => {
  expect(defaultConfig.claudeDirectories).toEqual(["~/.claude"]);
  expect(userPaths({}, "/example/user")).toEqual({
    configPath: "/example/user/.config/workflow-observer/config.json",
    dataDir: "/example/user/.local/share/workflow-observer",
  });
  expect(
    userPaths({ XDG_CONFIG_HOME: "/settings", XDG_DATA_HOME: "/state" }, "/example/user")
      .configPath,
  ).toBe("/settings/workflow-observer/config.json");
});
test("config validates paths and ports and atomically preserves custom directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-config-"));
  try {
    const c = await Effect.runPromise(Settings.open(join(dir, "nested/config.json")));
    const saved = c.getSnapshot().saved;
    expect(saved.config.claudeDirectories).toEqual(["~/.claude"]);
    await Effect.runPromise(
      c.replace(
        {
          ...saved.config,
          claudeDirectories: ["~/.claude", "/Volumes/Work/claude", "/Volumes/Work/claude"],
        },
        saved.revision,
      ),
    );
    const persisted = JSON.parse(await readFile(c.path, "utf8"));
    expect(persisted.claudeDirectories).toEqual(["~/.claude", "/Volumes/Work/claude"]);
    expect(() => validateConfig({ ...defaultConfig, port: 1 })).toThrow();
    expect(() =>
      validateConfig({ ...defaultConfig, claudeDirectories: ["relative/path"] }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...defaultConfig, claudeDirectories: ["https://remote"] }),
    ).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Shiki tokenizes JavaScript without losing or evaluating untrusted text", async () => {
  const source = 'const html = "<script>alert(1)</script>";';
  const tokens = await highlight(source, "javascript");
  expect(
    tokens
      .flat()
      .map((t) => t.content)
      .join(""),
  ).toBe(source);
  expect(new Set(tokens.flat().map((t) => t.color)).size).toBeGreaterThan(1);
});
