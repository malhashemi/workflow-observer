import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { command, failure, type Command } from "./command";
import type { RemoteState } from "./types";
type Mapping = { host: string; port: number; target: string };
const disabled = (): RemoteState => ({ state: "disabled", hostname: null, url: null, error: null });
export class TailscaleAccess {
  state = disabled();
  private owned: Mapping | null = null;
  private loaded = false;
  constructor(
    private dataDir: string,
    private run: Command = command,
  ) {}
  private path() {
    return join(this.dataDir, "tailscale-route.json");
  }
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.path(), "utf8"));
      if (
        typeof value.host === "string" &&
        Number.isInteger(value.port) &&
        /^http:\/\/127\.0\.0\.1:\d+$/.test(value.target)
      )
        this.owned = value;
    } catch {
      /* No prior owned route. */
    }
  }
  private async save(value: Mapping | null) {
    if (value) {
      await writeFile(this.path() + ".tmp", JSON.stringify(value), { mode: 0o600 });
      await rename(this.path() + ".tmp", this.path());
    } else await rm(this.path(), { force: true });
    this.owned = value;
  }
  private async status() {
    return JSON.parse(await this.run(["tailscale", "serve", "status", "--json"]));
  }
  private matches(config: any, m: Mapping) {
    const handlers = config.Web?.[`${m.host}:${m.port}`]?.Handlers;
    return (
      config.TCP?.[m.port]?.HTTPS === true &&
      handlers?.["/"]?.Proxy === m.target &&
      Object.keys(handlers).length === 1 &&
      !config.AllowFunnel?.[`${m.host}:${m.port}`]
    );
  }
  async disable() {
    await this.load();
    if (!this.owned) {
      this.state = disabled();
      return;
    }
    const config = await this.status();
    if (this.matches(config, this.owned))
      await this.run(["tailscale", "serve", `--https=${this.owned.port}`, "off"]);
    else if (config.TCP?.[this.owned.port])
      throw new Error("The Tailscale endpoint changed outside Observer. It was left untouched.");
    await this.save(null);
    this.state = disabled();
  }
  async reconcile(
    enabled: boolean,
    port: number,
    localPort: number,
    verify: (url: string) => Promise<boolean>,
    allow: (url: string | null) => void,
  ) {
    await this.load();
    if (!enabled) {
      allow(null);
      try {
        await this.disable();
      } catch (e) {
        this.state = { ...disabled(), state: "failed", error: failure(e) };
      }
      return;
    }
    const continuing =
      this.state.state === "ready" &&
      this.owned?.port === port &&
      this.owned.target === `http://127.0.0.1:${localPort}`;
    if (!continuing) {
      this.state = { ...this.state, state: "connecting", url: null, error: null };
      allow(null);
    }
    try {
      const machine = JSON.parse(await this.run(["tailscale", "status", "--json"]));
      const hostname = machine.Self?.DNSName?.replace(/\.$/, "");
      if (machine.BackendState !== "Running" || machine.Self?.Online === false)
        throw new Error("Connect Tailscale on this computer to enable remote access.");
      if (typeof hostname !== "string" || !/^[a-z0-9.-]+\.ts\.net$/.test(hostname))
        throw new Error(
          "A Tailscale MagicDNS hostname is not available. Enable MagicDNS in Tailscale.",
        );
      this.state.hostname = hostname;
      const desired = { host: hostname, port, target: `http://127.0.0.1:${localPort}` };
      let config = await this.status();
      const same = this.owned && JSON.stringify(this.owned) === JSON.stringify(desired);
      if (this.owned && !same) {
        await this.disable();
        config = await this.status();
      }
      if (config.TCP?.[port] && !(this.owned && this.matches(config, this.owned)))
        throw new Error(
          `Tailscale port ${port} is already configured for another service. Choose a different HTTPS port.`,
        );
      if (!this.owned || !this.matches(config, desired)) {
        // Record intent before the command: an interrupted setup can be reconciled on restart.
        await this.save(desired);
        await this.run(["tailscale", "serve", "--bg", `--https=${port}`, desired.target], {
          timeout: 20000,
        });
      }
      config = await this.status();
      if (!this.matches(config, desired))
        throw new Error("Tailscale did not confirm Observer’s private HTTPS mapping.");
      const url = `https://${hostname}:${port}/`;
      allow(url);
      if (!(await verify(url)))
        throw new Error(
          "The Tailscale mapping is configured, but HTTPS has not reached this Observer yet. Check Tailscale HTTPS setup and retry.",
        );
      this.state = { state: "ready", hostname, url, error: null };
    } catch (e) {
      allow(null);
      this.state = { ...this.state, state: "failed", url: null, error: failure(e) };
    }
  }
}
