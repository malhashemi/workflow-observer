import { test, expect } from "bun:test";
import { Effect, Scope, Exit } from "effect";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { Companion, trusted, lanHosts } from "../src/companion";
import { TailscaleAccess } from "../src/companion/tailscale";
import { Settings } from "../src/settings";
import { defaultConfig, validateConfig, accessOf } from "../src/config";
import { applyConfigChange } from "../src/config-changes";
import { shareUrl } from "../src/sharing";
import { prepareRuntime, releaseInfo, checkUpdate, installUpdate } from "../src/companion/install";
import { locate, stopInstance, launch, endpoint } from "../src/companion/client";
import type { Command } from "../src/companion/command";
const root = join(import.meta.dir, "..");
const temporary = () => mkdtemp(join(tmpdir(), "observer-lifecycle-"));
const freePort = () => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
  const p = s.port!;
  s.stop(true);
  return p;
};
test("access preferences are validated, stale edits fail, and other settings survive", () => {
  let config = validateConfig({ ...defaultConfig, modelAliases: { bridge: "openai/gpt-5.6-sol" } });
  config = applyConfigChange(config, {
    type: "set-preference",
    field: "sharingDefault",
    previous: "tailscale",
    value: "lan",
  });
  expect(accessOf(config).sharingDefault).toBe("lan");
  expect(config.modelAliases?.bridge).toBe("openai/gpt-5.6-sol");
  for (const [field, value] of [
    ["port", 80],
    ["tailscalePort", 99999],
    ["lanEnabled", "yes"],
    ["sharingDefault", "local"],
  ])
    expect(() =>
      applyConfigChange(config, {
        type: "set-preference",
        field,
        previous:
          field === "port"
            ? 4319
            : field === "tailscalePort"
              ? 8443
              : field === "lanEnabled"
                ? false
                : "lan",
        value,
      }),
    ).toThrow();
  expect(() =>
    applyConfigChange(config, {
      type: "set-preference",
      field: "sharingDefault",
      previous: "tailscale",
      value: "lan",
    }),
  ).toThrow("changed elsewhere");
});
test("LAN and Tailscale QR links round-trip and never fall back to loopback", () => {
  const key = "a".repeat(24);
  for (const address of [
    { kind: "lan" as const, label: "LAN", url: "http://192.168.1.10:4319/" },
    { kind: "tailscale" as const, label: "Tailscale", url: "https://fixture.example.ts.net:8443/" },
  ]) {
    const url = shareUrl(address, key, 90)!;
    expect(url).toContain("?days=90#run/" + key);
    const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
    const side = (qr.modules.size + 8) * 5;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < qr.modules.size; y++)
      for (let x = 0; x < qr.modules.size; x++)
        if (qr.modules.get(y, x))
          for (let dy = 0; dy < 5; dy++)
            for (let dx = 0; dx < 5; dx++) {
              const p = ((y * 5 + 20 + dy) * side + x * 5 + 20 + dx) * 4;
              pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
            }
    expect(jsQR(pixels, side, side)?.data).toBe(url);
  }
  expect(shareUrl({ kind: "local", label: "local", url: "http://127.0.0.1:4319/" })).toBeNull();
  expect(shareUrl(undefined)).toBeNull();
  expect(shareUrl({ kind: "tailscale", label: "wrong", url: "https://example.com/" })).toBeNull();
});
test("network origins are exact and LAN discovery excludes loopback and Tailscale IPs", () => {
  const addresses = [
    { kind: "local" as const, label: "Local", url: "http://127.0.0.1:4319/" },
    { kind: "lan" as const, label: "LAN", url: "http://192.168.1.10:4319/" },
  ];
  const remote = "https://fixture.example.ts.net:8443";
  expect(
    trusted(
      new Request(remote + "/api/status", { headers: { origin: remote } }),
      addresses,
      remote,
    ),
  ).toBe(true);
  expect(
    trusted(
      new Request(addresses[1].url, { headers: { origin: "https://evil.test" } }),
      addresses,
      remote,
    ),
  ).toBe(false);
  expect(
    trusted(
      new Request(remote + "/", { headers: { origin: "http://fixture.example.ts.net:8443" } }),
      addresses,
      remote,
    ),
  ).toBe(false);
  expect(
    trusted(
      new Request("http://127.0.0.1:4319/", { headers: { host: "evil.test" } }),
      addresses,
      remote,
    ),
  ).toBe(false);
  const entries = [
    "127.0.0.1",
    "100.70.1.1",
    "192.168.1.10",
    "10.0.0.4",
    "172.19.1.1",
    "8.8.8.8",
  ].map((address) => ({ address, family: "IPv4", internal: address === "127.0.0.1" }));
  expect(lanHosts({ fixture: entries } as any)).toEqual(["10.0.0.4", "172.19.1.1", "192.168.1.10"]);
});
async function tailFixture() {
  const dir = await temporary();
  let config: any = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      "fixture.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
    },
  };
  let online = true,
    healthy = true;
  const calls: string[][] = [];
  const run: Command = async (args) => {
    calls.push(args);
    if (args[1] === "status")
      return JSON.stringify({
        BackendState: online ? "Running" : "Stopped",
        Self: { Online: online, DNSName: "fixture.example.ts.net." },
      });
    if (args[2] === "status") return JSON.stringify(config);
    const port = Number(args.find((v) => v.startsWith("--https="))!.slice(8)),
      host = `fixture.example.ts.net:${port}`;
    if (args.at(-1) === "off") {
      delete config.TCP[port];
      delete config.Web[host];
    } else {
      config.TCP[port] = { HTTPS: true };
      config.Web[host] = { Handlers: { "/": { Proxy: args.at(-1) } } };
    }
    return "";
  };
  const access = new TailscaleAccess(dir, run);
  let allowed: string | null = null;
  const reconcile = () =>
    access.reconcile(
      true,
      8443,
      4319,
      async () => healthy,
      (url) => {
        allowed = url;
      },
    );
  return {
    dir,
    access,
    calls,
    reconcile,
    allowed: () => allowed,
    config: () => config,
    offline: () => {
      online = false;
    },
    unhealthy: () => {
      healthy = false;
    },
    run,
  };
}
test("Tailscale owns only its mapping, verifies readiness, and preserves another service on 443", async () => {
  const f = await tailFixture();
  try {
    await f.reconcile();
    expect(f.access.state.state).toBe("ready");
    expect(f.allowed()).toBe("https://fixture.example.ts.net:8443/");
    expect(f.config().Web["fixture.example.ts.net:443"].Handlers["/"].Proxy).toBe(
      "http://127.0.0.1:3773",
    );
    await f.reconcile();
    expect(f.calls.filter((c) => c.includes("--bg"))).toHaveLength(1);
    const restored = new TailscaleAccess(f.dir, f.run);
    await restored.disable();
    expect(f.config().TCP[443]).toEqual({ HTTPS: true });
    expect(f.config().TCP[8443]).toBeUndefined();
    expect(f.calls.some((c) => c.includes("reset"))).toBe(false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("Tailscale conflicts, changed ownership, offline and failed HTTPS never produce a shareable address", async () => {
  const f = await tailFixture();
  try {
    f.config().TCP[8443] = { HTTPS: true };
    f.config().Web["fixture.example.ts.net:8443"] = {
      Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } },
    };
    await f.reconcile();
    expect(f.access.state.state).toBe("failed");
    expect(f.calls.some((c) => c.includes("--bg"))).toBe(false);
    expect(f.allowed()).toBeNull();
    delete f.config().TCP[8443];
    delete f.config().Web["fixture.example.ts.net:8443"];
    await f.reconcile();
    f.unhealthy();
    await f.reconcile();
    expect(f.access.state.url).toBeNull();
    expect(f.allowed()).toBeNull();
    f.config().Web["fixture.example.ts.net:8443"].Handlers["/"].Proxy = "http://127.0.0.1:9000";
    await expect(f.access.disable()).rejects.toThrow("left untouched");
    expect(f.config().TCP[8443]).toBeDefined();
    f.offline();
    await f.reconcile();
    expect(f.access.state.url).toBeNull();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("port changes verify the new listener; conflicts leave the current listener available", async () => {
  const dir = await temporary(),
    port = freePort(),
    configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ ...defaultConfig, claudeDirectories: [], port }));
  const settings = await Effect.runPromise(Settings.open(configPath)),
    scope = Effect.runSync(Scope.make());
  const c = new Companion(root, dir, settings, null);
  const candidates: { advertised: boolean; readable: boolean }[] = [];
  const handler = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/companion/health" && Number(url.port) !== c.snapshot().localPort)
      candidates.push({
        advertised: c.snapshot().addresses.some((a) => new URL(a.url).origin === url.origin),
        readable: c.accepts(new Request(url.origin + "/api/runs")),
      });
    return c.accepts(request)
      ? Response.json({ instanceId: c.instanceId, build: c.snapshot().build })
      : new Response(null, { status: 403 });
  };
  try {
    await Effect.runPromise(c.start(handler).pipe(Effect.provideService(Scope.Scope, scope)));
    const conflict = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const conflictPort = conflict.port!;
    await Effect.runPromise(
      settings.change({
        type: "set-preference",
        field: "port",
        previous: port,
        value: conflictPort,
      }),
    );
    await c.apply();
    expect(c.snapshot().state).toBe("failed");
    expect(c.snapshot().localPort).toBe(port);
    expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
    conflict.stop(true);
    await c.apply();
    expect(c.snapshot().state).toBe("ready");
    expect(c.snapshot().localPort).toBe(conflictPort);
    expect(candidates).toEqual([{ advertised: false, readable: false }]);
    expect(c.snapshot().addresses.some((a) => a.url === `http://127.0.0.1:${conflictPort}/`)).toBe(
      true,
    );
    expect(JSON.parse(await readFile(join(dir, "companion.json"), "utf8")).localUrl).toBe(
      `http://127.0.0.1:${conflictPort}/`,
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(dir, { recursive: true, force: true });
  }
});
test("a packaged companion serializes simultaneous launches, reuses one instance, reports versions, and stops by identity", async () => {
  const dir = await temporary(),
    port = freePort(),
    configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ ...defaultConfig, claudeDirectories: [], port, openBrowser: false }),
  );
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  try {
    const options = { background: true, open: false };
    const [a, b] = await Promise.all([
      launch(root, configPath, dir, config, options),
      launch(root, configPath, dir, config, options),
    ]);
    expect(a?.info.companion.instanceId).toBe(b?.info.companion.instanceId);
    expect(endpoint(a!.info, "local")).toBe(`http://127.0.0.1:${port}/`);
    expect(endpoint(a!.info, "tailscale")).toBeNull();
    const old = a!.info.companion.instanceId;
    await fetch(new URL("/api/companion/stop", a!.url), {
      method: "POST",
      headers: { "X-Observer-Instance": "stale" },
    }).then((r) => expect(r.status).toBe(409));
    expect((await locate(configPath, dir, port))!.info.companion.instanceId).toBe(old);
    const restarted = await launch(root, configPath, dir, config, { ...options, restart: true });
    expect(restarted!.info.companion.instanceId).not.toBe(old);
    expect(restarted!.info.companion.version).toBe((await releaseInfo(root)).version);
  } finally {
    const found = await locate(configPath, dir, port);
    if (found) await stopInstance(found);
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
test("runtime snapshots survive package-file replacement and unsafe update targets are refused", async () => {
  const dir = await temporary();
  try {
    const runtime = await prepareRuntime(root, dir);
    expect(runtime).not.toBe(root);
    expect((await releaseInfo(runtime)).build).toBe((await releaseInfo(root)).build);
    const installation = { kind: "bunx" as const, root: runtime, version: "0.1.0" };
    await expect(installUpdate(installation, "0.2.0", dir)).rejects.toThrow("bunx");
    expect((await checkUpdate({ ...installation, kind: "development" })).error).toContain(
      "development",
    );
    await expect(
      checkUpdate(installation, async () => Response.json({ name: "wrong", version: "0.2.0" })),
    ).rejects.toThrow("compatible");
    expect(
      (
        await checkUpdate(installation, async () =>
          Response.json({
            name: "workflow-observer",
            version: "0.2.0",
            bin: { "workflow-observer": "dist/cli.js" },
          }),
        )
      ).state,
    ).toBe("available");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("global updates stage and verify a release before mutating the verified package prefix", async () => {
  const dir = await temporary(),
    prefix = join(dir, "global"),
    installedRoot = join(prefix, "node_modules", "workflow-observer");
  const { mkdir } = await import("node:fs/promises");
  const packageAt = async (path: string, version: string) => {
    await mkdir(join(path, "dist", "client"), { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name: "workflow-observer", version }),
    );
    await writeFile(
      join(path, "dist", "build.json"),
      JSON.stringify({ version, id: version === "0.1.0" ? "1".repeat(64) : "2".repeat(64) }),
    );
    for (const f of ["cli.js", "server.js", "client/index.html"])
      await writeFile(join(path, "dist", f), version);
  };
  const calls: string[][] = [];
  const run: Command = async (argv, options) => {
    calls.push(argv);
    if (argv[1] === "pm") return `${prefix} node_modules (1)`;
    if (argv.includes("--global")) {
      await packageAt(installedRoot, "0.2.0");
      return "";
    }
    await packageAt(join(options!.cwd!, "node_modules", "workflow-observer"), "0.2.0");
    return "";
  };
  try {
    await packageAt(installedRoot, "0.1.0");
    const oldRuntime = await prepareRuntime(installedRoot, dir);
    const result = await installUpdate(
      {
        kind: "bun-global",
        root: installedRoot,
        version: "0.1.0",
        manager: process.execPath,
        prefix,
      },
      "0.2.0",
      dir,
      run,
    );
    expect(result.version).toBe("0.2.0");
    expect((await releaseInfo(oldRuntime)).version).toBe("0.1.0");
    expect(calls.findIndex((c) => c.includes("--global"))).toBeGreaterThan(
      calls.findIndex((c) => c[1] === "pm"),
    );
    expect(calls.filter((c) => c.includes("--global"))).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
