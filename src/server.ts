import { Effect, Scope, Exit } from "effect";
import { createHash } from "node:crypto";
import { stampResponse } from "./observation-protocol";
import { mkdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Companion, openBrowser } from "./companion";
import { userPaths } from "./config";
import { Settings, SettingsConflict } from "./settings";
import { Catalog } from "./catalog";
import { Indexer } from "./indexer";
import { parseWindow, cutoffFor } from "./windows";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = userPaths();
const dataDir = paths.dataDir;
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const settings = await Effect.runPromise(Settings.open(paths.configPath));
const configuration = settings.getSnapshot().saved.config;
const port = Number(process.env.PORT || configuration.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port");
const companion = new Companion(root, dataDir, settings, process.env.PORT || null);
const catalog = new Catalog(dataDir, configuration.modelAliases);
await Effect.runPromise(catalog.load);
const index = new Indexer([], dataDir, catalog);
const assets = new Map<string, ReturnType<typeof Bun.file>>();
const clientDir = join(root, "dist", "client");
if (!(await Bun.file(join(clientDir, "index.html")).exists()))
  throw new Error("Browser assets missing. Run bun run build.");
for await (const name of new Bun.Glob("**/*").scan({ cwd: clientDir, onlyFiles: true }))
  assets.set("/" + name, Bun.file(join(clientDir, name)));
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
// Validate legacy/known evidence before serving snapshots after a restart.
const scope = Effect.runSync(Scope.make());
await Effect.runPromise(
  settings
    .start({ index, catalog, boundPort: port })
    .pipe(Effect.provideService(Scope.Scope, scope)),
);
await Effect.runPromise(
  companion
    .start(async (request, server) => {
      if (!companion.accepts(request)) return new Response("Local requests only", { status: 403 });
      const url = new URL(request.url);
      let response: Response;
      try {
        if (url.pathname === "/api/companion/health")
          return json({ instanceId: companion.instanceId, build: companion.snapshot().build });
        if (url.pathname === "/api/companion/apply" && request.method === "POST") {
          await companion.apply();
          return json(companion.snapshot());
        }
        if (url.pathname === "/api/companion/update-check" && request.method === "POST") {
          void companion.checkUpdates();
          return json({ ok: true });
        }
        if (url.pathname === "/api/companion/stop" && request.method === "POST") {
          if (
            server.requestIP(request)?.address !== "127.0.0.1" ||
            request.headers.get("x-observer-instance") !== companion.instanceId
          )
            return json({ error: "Companion identity mismatch" }, 409);
          setTimeout(() => void shutdown(), 50);
          return json({ ok: true });
        }
        if (url.pathname === "/api/status")
          response = stampResponse(
            json({
              app: "workflow-observer",
              pid: process.pid,
              companion: companion.snapshot(),
              configPath: settings.path,
              configuration: settings.getSnapshot().saved.config,
              settings: settings.getSnapshot(),
              revision: settings.revision,
              evidenceGeneration: index.evidenceGeneration,
              scanning: index.scanning,
              lastScan: index.lastScan,
              discoveryDays: Math.max(...index.windows.active()),
              sources: index.sources,
              errors: index.errors,
              catalog: catalog.info(),
            }),
            index.evidenceStamp,
          );
        else if (url.pathname === "/api/config" && ["PUT", "PATCH"].includes(request.method)) {
          try {
            const body = await request.json();
            const outcome = await Effect.runPromise(
              Effect.either(
                request.method === "PATCH"
                  ? settings.change(body)
                  : settings.replace(
                      body,
                      request.headers.get("if-match")?.replace(/^"|"$/g, "") ?? null,
                    ),
              ),
            );
            if (outcome._tag === "Left") throw outcome.left;
            const result = outcome.right;
            response = json({
              config: result.saved.config,
              revision: result.saved.revision,
              path: settings.path,
              restartRequired: result.restartRequired,
              settings: result,
            });
            response.headers.set("ETag", `"${result.saved.revision}"`);
          } catch (e) {
            response = json(
              { error: e instanceof Error ? e.message : String(e) },
              e instanceof SettingsConflict ? 409 : 400,
            );
          }
        } else if (url.pathname.startsWith("/api/models/") && request.method === "GET") {
          response = json(catalog.modelInfo(decodeURIComponent(url.pathname.slice(12))));
        } else if (
          /^\/api\/logos\/[a-z0-9-]+\.svg$/.test(url.pathname) &&
          request.method === "GET"
        ) {
          const provider = url.pathname.split("/").at(-1)!.slice(0, -4);
          const logo = await catalog.logo(provider);
          response = logo
            ? new Response(logo, {
                headers: {
                  "Content-Type": "image/svg+xml",
                  "Cache-Control": "public, max-age=86400",
                },
              })
            : new Response(null, { status: 404 });
        } else if (url.pathname === "/api/runs" && request.method === "GET") {
          let days;
          try {
            days = parseWindow(url.searchParams.get("days"));
          } catch (e) {
            return json({ error: String(e) }, 400);
          }
          const client = request.headers.get("x-observer-client")?.slice(0, 64) || "default";
          const selectionText = request.headers.get("x-observer-selection") ?? "0";
          const selection = Number(selectionText);
          if (!/^\d+$/.test(selectionText) || !Number.isSafeInteger(selection))
            return json({ error: "Invalid observation selection" }, 400);
          settings.demand(days, Date.now(), client, selection);
          const capturedAt = Date.now();
          const runs = index.list(days, capturedAt);
          response = stampResponse(
            json({
              runs,
              evidenceGeneration: index.evidenceGeneration,
              sessions: index.sessions.list(days, runs),
              days,
              since: cutoffFor(days, capturedAt),
              updatedAt: index.updatedWindows.get(days) ?? 0,
              scanning: index.scanning,
              capturedAt,
            }),
            index.evidenceStamp,
          );
        } else if (/^\/api\/runs\/[a-f0-9]{24}$/.test(url.pathname) && request.method === "GET") {
          let days;
          try {
            days = parseWindow(url.searchParams.get("days"));
          } catch (e) {
            return json({ error: String(e) }, 400);
          }
          const run = index.get(url.pathname.split("/").at(-1)!, cutoffFor(days));
          const stamp = index.evidenceStamp;
          const etag = run
            ? `"${createHash("sha256")
                .update(JSON.stringify([stamp, run]))
                .digest("hex")}"`
            : "";
          response =
            run && request.headers.get("if-none-match") === etag
              ? new Response(null, { status: 304 })
              : run
                ? json({ ...run, evidenceGeneration: index.evidenceGeneration })
                : json(
                    { error: "Run not found", evidenceGeneration: index.evidenceGeneration },
                    404,
                  );
          if (run) response.headers.set("ETag", etag);
          stampResponse(response, stamp);
        } else if (url.pathname === "/api/refresh" && request.method === "POST") {
          await Effect.runPromise(settings.refresh());
          response = json({ ok: true });
        } else if (url.pathname === "/api/catalog/refresh" && request.method === "POST") {
          await Effect.runPromise(settings.refresh("catalog"));
          response = json({ ok: true, settings: settings.getSnapshot() });
        } else if (request.method === "GET" && assets.has(url.pathname))
          response = new Response(assets.get(url.pathname));
        else if (request.method === "GET" && !url.pathname.startsWith("/api/"))
          response = new Response(Bun.file(join(clientDir, "index.html")));
        else response = json({ error: "Not found" }, 404);
      } catch (e) {
        console.error(String(e));
        response = json({ error: "The companion could not complete this request." }, 500);
      }
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
      response.headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      );
      if (!url.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "no-cache");
      return response;
    })
    .pipe(Effect.provideService(Scope.Scope, scope)),
);
console.log(`Workflow Observer → http://127.0.0.1:${port}`);
if (process.env.OBSERVER_OPEN_BROWSER === "1") {
  await companion.apply(false);
  const state = companion.snapshot();
  const address = state.addresses.find((a) => a.kind === state.openAddress);
  if (address) openBrowser(address.url);
  else console.log("The preferred address is unavailable. Open Settings from the local URL.");
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  companion.markStopping();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  index.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
