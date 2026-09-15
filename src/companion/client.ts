import { spawn } from "node:child_process";
import { mkdir, readFile, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ObserverConfig } from "../config";
import { accessOf } from "../config";
import { prepareRuntime, releaseInfo, detectInstallation, compareVersions } from "./install";
import type { InstanceRecord, CompanionSnapshot, Address } from "./types";
export const probe = async (url: string) =>
  fetch(new URL("/api/status", url), { signal: AbortSignal.timeout(1500) })
    .then(async (r) => (r.ok ? await r.json() : null))
    .catch(() => null);
export async function locate(configPath: string, dataDir: string, port: number) {
  configPath = await realpath(configPath);
  let record: InstanceRecord | null = null;
  try {
    record = JSON.parse(await readFile(join(dataDir, "companion.json"), "utf8"));
  } catch {
    /* No instance record yet. */
  }
  if (record && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(record.localUrl)) {
    const info = await probe(record.localUrl);
    if (info?.app === "workflow-observer" && info.companion?.instanceId === record.instanceId) {
      if (info.configPath !== configPath)
        throw new Error(
          "This data directory belongs to another running Observer configuration. Use a separate OBSERVER_DATA_DIR.",
        );
      return { url: record.localUrl, info };
    }
  }
  const url = `http://127.0.0.1:${port}/`,
    info = await probe(url);
  if (info && (info.app !== "workflow-observer" || info.configPath !== configPath))
    throw new Error(`Port ${port} is occupied by another app or configuration.`);
  return info ? { url, info } : null;
}
export function endpoint(info: any, kind?: Address["kind"]) {
  const c: CompanionSnapshot | undefined = info.companion;
  if (!c) return null;
  const chosen = kind ?? c.openAddress;
  return c.addresses.find((a) => a.kind === chosen)?.url ?? null;
}
export async function stopInstance(found: NonNullable<Awaited<ReturnType<typeof locate>>>) {
  const identity = found.info.companion?.instanceId;
  if (!identity)
    throw new Error(
      "This older companion needs to be stopped with its original CLI before upgrading.",
    );
  const response = await fetch(new URL("/api/companion/stop", found.url), {
    method: "POST",
    headers: { "X-Observer-Instance": identity },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("The companion identity changed; it was not stopped.");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const info = await probe(found.url);
    if (!info || info.companion?.instanceId !== identity) return;
    await Effect.runPromise(Effect.sleep("100 millis"));
  }
  throw new Error("Observer is still finishing its work. Wait before restarting.");
}
export async function launch(
  root: string,
  configPath: string,
  dataDir: string,
  config: ObserverConfig,
  options: { background: boolean; portOverride?: string; open: boolean; restart?: boolean },
) {
  const port = Number(options.portOverride || config.port);
  const release = await releaseInfo(root);
  const found = await locate(configPath, dataDir, port);
  if (found) {
    if (!options.restart) {
      if (found.info.companion?.build !== release.build)
        throw new Error(
          `Observer ${found.info.companion?.version ?? "an older version"} is running. This command is ${release.version}. Run workflow-observer restart to switch releases.`,
        );
      return found;
    }
    if (
      found.info.companion?.version &&
      compareVersions(found.info.companion.version, release.version) > 0
    )
      throw new Error(
        "A newer companion is running. Update this installation before restarting it.",
      );
  }
  const runtime = await prepareRuntime(root, dataDir);
  const installation = await detectInstallation(root);
  if (found) await stopInstance(found);
  const env = {
    ...process.env,
    WORKFLOW_OBSERVER_CONFIG: configPath,
    OBSERVER_DATA_DIR: dataDir,
    OBSERVER_INSTALLATION: JSON.stringify(installation),
    PORT: options.portOverride ?? "",
    OBSERVER_OPEN_BROWSER: options.open ? "1" : "0",
  };
  if (!options.background) {
    Object.assign(process.env, env);
    await import(pathToFileURL(join(runtime, "dist", "server.js")).href);
    return null;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = await open(join(dataDir, "companion.log"), "a", 0o600);
  const child = spawn(process.execPath, [join(runtime, "dist", "server.js")], {
    env: { ...env, OBSERVER_OPEN_BROWSER: "0" },
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  let spawnError: Error | null = null;
  child.once("error", (e) => {
    spawnError = e;
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const ready = await locate(configPath, dataDir, port);
    if (ready?.info.companion?.build === release.build && ready.info.companion.state !== "stopping")
      return ready;
    if (spawnError) throw spawnError;
    if (child.exitCode !== null && child.exitCode !== 0) {
      // A simultaneous starter may own the lock and still be warming its index.
      if (Date.now() > deadline - 40000) break;
    }
    await Effect.runPromise(Effect.sleep("150 millis"));
  }
  throw new Error(
    `Observer could not become ready on port ${port}. Check ${join(dataDir, "companion.log")}.`,
  );
}
export function openBrowser(url: string) {
  const args =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(args[0], args.slice(1), { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
export { accessOf };
