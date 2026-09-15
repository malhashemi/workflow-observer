import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { networkInterfaces } from "node:os";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { accessOf, userPaths } from "../config";
import type { Settings } from "../settings";
import { TailscaleAccess } from "./tailscale";
import { checkUpdate, detectInstallation, releaseInfo } from "./install";
import { failure } from "./command";
import type {
  Address,
  CompanionSnapshot,
  InstanceRecord,
  Installation,
  UpdateState,
} from "./types";
export { launch, locate, stopInstance, endpoint, openBrowser } from "./client";
export type { CompanionSnapshot, Address } from "./types";
export const lanHosts = (interfaces = networkInterfaces()) =>
  [
    ...new Set(
      Object.values(interfaces).flatMap((items) =>
        (items ?? [])
          .filter(
            (i) =>
              !i.internal &&
              i.family === "IPv4" &&
              /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address),
          )
          .map((i) => i.address),
      ),
    ),
  ].sort();
export function trusted(request: Request, addresses: Address[], remoteOrigin: string | null) {
  const url = new URL(request.url),
    host = request.headers.get("host") ?? url.host;
  const origins = new Set(addresses.map((a) => new URL(a.url).origin));
  if (remoteOrigin) origins.add(remoteOrigin);
  const hosts = new Set([...origins].map((o) => new URL(o).host));
  const origin = request.headers.get("origin");
  return hosts.has(host) && hosts.has(url.host) && (!origin || origins.has(origin));
}
/** One process owns the index and every listener. Port changes prepare new listeners before retiring old ones. */
export class Companion {
  readonly instanceId = randomUUID();
  readonly remote: TailscaleAccess;
  private lock: Database;
  private listeners = new Map<string, Bun.Server<any>>();
  private candidates = new Map<string, Bun.Server<any>>();
  private retiring = new Set<Bun.Server<any>>();
  private handler!: (request: Request, server: Bun.Server<any>) => Promise<Response>;
  private origin: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private currentPort: number;
  private state: CompanionSnapshot["state"] = "ready";
  private error: string | null = null;
  private lanError: string | null = null;
  private lastRemote = 0;
  private remoteTarget = "";
  private installation!: Installation;
  private release!: { version: string; build: string };
  private update: UpdateState = { state: "unchecked", latest: null, checkedAt: null, error: null };
  private stopped = false;
  constructor(
    readonly root: string,
    readonly dataDir: string,
    readonly settings: Settings,
    readonly portOverride: string | null,
  ) {
    this.currentPort = Number(portOverride || settings.getSnapshot().saved.config.port);
    this.remote = new TailscaleAccess(dataDir);
    this.lock = new Database(join(dataDir, "companion.lock.sqlite"), { create: true });
    this.lock.exec("PRAGMA busy_timeout=0");
    try {
      this.lock.exec("BEGIN IMMEDIATE");
    } catch {
      this.lock.close();
      throw new Error(
        "An Observer companion is already starting or running for this data directory.",
      );
    }
  }
  private addresses(): Address[] {
    return [...this.listeners.keys()].map((key) => ({
      kind: key.startsWith("127.") ? ("local" as const) : ("lan" as const),
      label: key.startsWith("127.") ? "This computer" : "Local network",
      url: `http://${key}/`,
    }));
  }
  private actionCommand() {
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const defaults = userPaths({
      ...process.env,
      WORKFLOW_OBSERVER_CONFIG: undefined,
      OBSERVER_DATA_DIR: undefined,
    });
    const parts = this.installation.kind.endsWith("-global")
      ? ["workflow-observer"]
      : ["bunx", "workflow-observer"];
    if (this.settings.path !== defaults.configPath)
      parts.push("--config", quote(this.settings.path));
    if (this.portOverride) parts.push("--port", this.portOverride);
    parts.push("--background", "--no-open");
    return (
      (this.dataDir !== defaults.dataDir ? "OBSERVER_DATA_DIR=" + quote(this.dataDir) + " " : "") +
      parts.join(" ")
    );
  }
  snapshot(): CompanionSnapshot {
    const config = this.settings.getSnapshot().saved.config,
      access = accessOf(config);
    return {
      actionCommand: this.actionCommand(),
      instanceId: this.instanceId,
      ...this.release,
      installation: this.installation,
      localPort: this.currentPort,
      portOverride: this.portOverride,
      state: this.state,
      error: this.error,
      lanError: this.lanError,
      addresses: [
        ...this.addresses(),
        ...(this.remote.state.state === "ready" && this.remote.state.url
          ? [{ kind: "tailscale" as const, label: "Tailscale HTTPS", url: this.remote.state.url }]
          : []),
      ],
      remote: { ...this.remote.state },
      pending: config.port !== this.currentPort,
      sharingDefault: access.sharingDefault,
      openAddress: access.openAddress,
      update: { ...this.update },
    };
  }
  accepts(request: Request) {
    const health = new URL(request.url).pathname === "/api/companion/health";
    const candidateAddresses: Address[] = health
      ? [...this.candidates.keys()].map((host) => ({
          kind: "local",
          label: "Candidate",
          url: `http://${host}/`,
        }))
      : [];
    return trusted(
      request,
      [
        ...this.addresses(),
        ...candidateAddresses,
        { kind: "local", label: "Localhost", url: `http://localhost:${this.currentPort}/` },
      ],
      health || this.remote.state.state === "ready" ? this.origin : null,
    );
  }
  private listen(host: string, port: number) {
    return Bun.serve({
      hostname: host,
      port,
      maxRequestBodySize: 32768,
      fetch: (request, server) => this.handler(request, server),
    });
  }
  private async record(port = this.currentPort) {
    const record: InstanceRecord = {
      instanceId: this.instanceId,
      pid: process.pid,
      configPath: this.settings.path,
      localUrl: `http://127.0.0.1:${port}/`,
      ...this.release,
      runtime: this.root,
    };
    const path = join(this.dataDir, "companion.json");
    await writeFile(path + ".tmp", JSON.stringify(record), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  start(handler: typeof this.handler) {
    return Effect.gen(this, function* () {
      this.handler = handler;
      this.release = yield* Effect.promise(() => releaseInfo(this.root));
      this.installation = yield* Effect.promise(async () => {
        try {
          return JSON.parse(process.env.OBSERVER_INSTALLATION ?? "") as Installation;
        } catch {
          return detectInstallation(this.root);
        }
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => this.close()));
      this.listeners.set(
        `127.0.0.1:${this.currentPort}`,
        this.listen("127.0.0.1", this.currentPort),
      );
      yield* Effect.promise(() => this.record());
      yield* Effect.forkScoped(
        Effect.gen(this, function* () {
          while (true) {
            yield* Effect.promise(() => this.apply(false));
            yield* Effect.sleep("5 seconds");
          }
        }),
      );
    });
  }
  apply(changePort = true) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.stopped) return;
        const config = this.settings.getSnapshot().saved.config,
          access = accessOf(config);
        const port = changePort ? config.port : this.currentPort;
        if (changePort && this.portOverride && port !== Number(this.portOverride)) {
          this.state = "failed";
          this.error = `Port ${this.portOverride} was set by a launch override. Restart without --port or PORT to apply the saved port.`;
          return;
        }
        const desired = [
          `127.0.0.1:${port}`,
          ...(access.lanEnabled ? lanHosts().map((h) => `${h}:${port}`) : []),
        ];
        const changed = desired.join() !== [...this.listeners.keys()].join();
        if (changed) {
          this.state = "applying";
          this.error = null;
          this.lanError = null;
          const added = new Map<string, Bun.Server<any>>();
          try {
            for (const key of desired)
              if (!this.listeners.has(key)) {
                const [host, p] = key.split(":");
                added.set(key, this.listen(host, Number(p)));
              }
            // Candidate listeners accept only the identity probe until verification commits.
            this.candidates = added;
            if (!(await this.verify(`http://127.0.0.1:${port}/`)))
              throw new Error("The new listener did not confirm this Observer instance.");
            await this.record(port);
            for (const [key, server] of added) this.listeners.set(key, server);
            this.candidates = new Map();
            this.currentPort = port;
            this.settings.setBoundPort(port);
            for (const [key, server] of this.listeners)
              if (!desired.includes(key)) {
                this.listeners.delete(key);
                this.retiring.add(server);
                // Allow the apply response to arrive before retiring the old address.
                setTimeout(() => {
                  server.stop(true);
                  this.retiring.delete(server);
                }, 2000).unref();
              }
            this.state = "ready";
          } catch (e) {
            this.candidates = new Map();
            for (const [key, server] of added) {
              server.stop(true);
              this.listeners.delete(key);
            }
            this.state = "failed";
            this.error = `Could not apply network settings: ${failure(e)} The existing listener remains available.`;
            return;
          }
        }
        if (!changed && config.port === this.currentPort) {
          this.state = "ready";
          this.error = null;
        }
        this.lanError =
          access.lanEnabled && !lanHosts().length
            ? "No private IPv4 network address was found. Connect this computer to a local network."
            : null;
        const target = JSON.stringify([
          access.tailscaleEnabled,
          access.tailscalePort,
          this.currentPort,
        ]);
        if (target !== this.remoteTarget || Date.now() - this.lastRemote > 15000) {
          try {
            const installed = JSON.parse(
              await readFile(join(this.installation.root, "package.json"), "utf8"),
            );
            if (installed.name === "workflow-observer" && typeof installed.version === "string")
              this.installation.version = installed.version;
          } catch {
            this.installation.version = "Unavailable";
          }
          this.remoteTarget = target;
          this.lastRemote = Date.now();
          await this.remote.reconcile(
            access.tailscaleEnabled,
            access.tailscalePort,
            this.currentPort,
            (url) => this.verify(url),
            (url) => {
              this.origin = url ? new URL(url).origin : null;
            },
          );
        }
      });
    this.queue = work;
    return work;
  }
  private async verify(url: string) {
    try {
      const response = await fetch(new URL("/api/companion/health", url), {
        signal: AbortSignal.timeout(6000),
      });
      const info = await response.json();
      return (
        response.ok && info.instanceId === this.instanceId && info.build === this.release.build
      );
    } catch {
      return false;
    }
  }
  async checkUpdates() {
    if (this.update.state === "checking") return;
    this.update = { ...this.update, state: "checking", error: null };
    try {
      const installed = await detectInstallation(this.installation.root);
      this.installation = installed;
      this.update = await checkUpdate(installed);
    } catch (e) {
      this.update = { state: "failed", latest: null, checkedAt: Date.now(), error: failure(e) };
    }
  }
  markStopping() {
    this.stopped = true;
    this.state = "stopping";
  }
  async close() {
    this.markStopping();
    await this.queue.catch(() => {});
    this.origin = null;
    try {
      await this.remote.disable();
    } catch (e) {
      console.error(`Tailscale cleanup: ${failure(e)}`);
    }
    for (const server of [...this.listeners.values(), ...this.retiring]) server.stop(true);
    this.listeners.clear();
    this.retiring.clear();
    const path = join(this.dataDir, "companion.json");
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.instanceId === this.instanceId) await rm(path);
    } catch {
      /* A missing record does not own another instance. */
    }
    try {
      this.lock.exec("ROLLBACK");
    } finally {
      this.lock.close();
    }
  }
}
