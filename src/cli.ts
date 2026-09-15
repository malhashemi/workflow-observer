#!/usr/bin/env bun
import { Effect } from "effect";
import { dirname } from "node:path";
import { userPaths, accessOf } from "./config";
import { Settings } from "./settings";
import { launch, locate, stopInstance, endpoint, openBrowser } from "./companion/client";
import { detectInstallation, checkUpdate, installUpdate } from "./companion/install";
const args = process.argv.slice(2);
function take(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function flag(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a value.`);
  return args.splice(i, 2)[1];
}
const root = dirname(dirname(import.meta.path));
try {
  if (take("--version")) {
    console.log((await Bun.file(root + "/package.json").json()).version);
    process.exit(0);
  }
  if (take("--help") || take("-h")) {
    console.log(
      `Workflow Observer\n\n  workflow-observer                      Start and open the preferred address\n  workflow-observer --background          Start in the background\n  workflow-observer --no-open             Keep the browser closed\n  workflow-observer stop                  Stop this companion\n  workflow-observer restart               Restart with this installed release\n  workflow-observer url [--local|--remote] Print a confirmed address\n  workflow-observer update [--check]      Update a global installation\n  workflow-observer config path|show\n  workflow-observer config add|remove PATH\n\nOptions: --config FILE, --port NUMBER, --version\nDefault local port: 4319. Configure network access and sharing in Settings.`,
    );
    process.exit(0);
  }
  const configOverride = flag("--config");
  if (configOverride) process.env.WORKFLOW_OBSERVER_CONFIG = configOverride;
  const portOverride = flag("--port") ?? process.env.PORT;
  if (
    portOverride &&
    (!Number.isInteger(Number(portOverride)) ||
      Number(portOverride) < 1024 ||
      Number(portOverride) > 65535)
  )
    throw new Error("Port must be an integer between 1024 and 65535.");
  const paths = userPaths(),
    settings = await Effect.runPromise(Settings.open(paths.configPath));
  const config = settings.getSnapshot().saved.config;
  if (args[0] === "config") {
    if (args[1] === "path" && args.length === 2) console.log(settings.path);
    else if ((args[1] === "show" && args.length === 2) || args.length === 1)
      console.log(JSON.stringify(config, null, 2));
    else if (["add", "remove"].includes(args[1]) && args.length === 3) {
      await Effect.runPromise(
        settings.change({
          type: args[1] === "add" ? "add-directory" : "remove-directory",
          path: args[2],
        }),
      );
      console.log(`Updated ${settings.path}`);
    } else throw new Error("Use config path, show, add PATH, or remove PATH.");
    process.exit(0);
  }
  const noOpen = take("--no-open"),
    background = take("--background"),
    local = take("--local"),
    remote = take("--remote"),
    check = take("--check");
  const action = args.shift() ?? "start";
  if (
    args.length ||
    !["start", "stop", "restart", "url", "update"].includes(action) ||
    (local && remote) ||
    ((local || remote) && action !== "url") ||
    (check && action !== "update")
  )
    throw new Error("Unknown command or option. Use --help.");
  const found =
    action === "start" || action === "restart"
      ? null
      : await locate(settings.path, paths.dataDir, Number(portOverride || config.port));
  if (action === "url") {
    if (!found) throw new Error("Observer is not running. Start it before requesting an address.");
    const url = endpoint(
      found.info,
      local ? "local" : remote ? accessOf(config).sharingDefault : undefined,
    );
    if (!url)
      throw new Error("The selected address is unavailable. Check network access in Settings.");
    console.log(url);
  } else if (action === "stop") {
    if (found) {
      await stopInstance(found);
      console.log("Companion stopped.");
    } else console.log("No matching companion is running.");
  } else if (action === "update") {
    const installed = await detectInstallation(root);
    const result = await checkUpdate(installed);
    console.log(
      `Installed: ${installed.version} (${installed.kind})\nRunning: ${found?.info.companion?.version ?? "not running"}\nLatest: ${result.latest ?? "unavailable"}`,
    );
    if (result.error) throw new Error(result.error);
    if (result.state === "available" && !check) {
      await installUpdate(installed, result.latest!, paths.dataDir);
      console.log(`Installed ${result.latest}.`);
      if (found) {
        try {
          await launch(root, settings.path, paths.dataDir, config, {
            background: true,
            portOverride,
            open: false,
            restart: true,
          });
          console.log("Companion restarted.");
        } catch (e) {
          throw new Error(
            `The package was updated, but the companion restart failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } else if (result.state === "current") console.log("The installed package is up to date.");
  } else {
    const started = await launch(root, settings.path, paths.dataDir, config, {
      background,
      portOverride,
      open: !noOpen && config.openBrowser,
      restart: action === "restart",
    });
    if (started) {
      const url = endpoint(started.info);
      console.log(url ?? started.url);
      if (!noOpen && config.openBrowser) {
        if (url) openBrowser(url);
        else
          console.error(
            "The preferred address is unavailable. Check Settings using the local URL.",
          );
      }
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
