import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readFile, realpath, lstat, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { command, type Command } from "./command";
import type { Installation, UpdateState } from "./types";
export const PACKAGE = "workflow-observer";
const manifest = async (root: string) =>
  JSON.parse(await readFile(join(root, "package.json"), "utf8"));
export async function releaseInfo(root: string) {
  const pkg = await manifest(root);
  const build = await readFile(join(root, "dist", "build.json"), "utf8").then(JSON.parse);
  if (pkg.name !== PACKAGE || pkg.version !== build.version || !/^[a-f0-9]{64}$/.test(build.id))
    throw new Error("Package release metadata is inconsistent. Rebuild Observer.");
  for (const file of ["cli.js", "server.js", "client/index.html"])
    if (!(await stat(join(root, "dist", file))).isFile())
      throw new Error("The package is missing built assets.");
  return { version: pkg.version as string, build: build.id as string };
}
export async function detectInstallation(
  root: string,
  run: Command = command,
): Promise<Installation> {
  root = await realpath(root);
  const pkg = await manifest(root);
  const result: Installation = { kind: "unknown", root, version: pkg.version };
  if (await Bun.file(join(root, "src", "cli.ts")).exists())
    return { ...result, kind: "development" };
  if (/[\\/]install[\\/]cache[\\/]|[\\/]bunx-/.test(root)) return { ...result, kind: "bunx" };
  try {
    const listing = await run([process.execPath, "pm", "ls", "-g"]);
    const global = listing.split("\n")[0]?.match(/^(.*?) node_modules/)?.[1];
    const candidate = global && join(global, "node_modules", PACKAGE);
    if (
      candidate &&
      !(await lstat(candidate)).isSymbolicLink() &&
      (await realpath(candidate)) === root
    )
      return { ...result, kind: "bun-global", manager: process.execPath, prefix: global };
  } catch {
    /* Not a Bun global install. */
  }
  try {
    const npm = Bun.which("npm");
    if (npm) {
      const global = await run([npm, "root", "-g"]);
      const candidate = join(global, PACKAGE);
      if (!(await lstat(candidate)).isSymbolicLink() && (await realpath(candidate)) === root)
        return {
          ...result,
          kind: "npm-global",
          manager: npm,
          prefix: await run([npm, "prefix", "-g"]),
        };
    }
  } catch {
    /* A package extracted by hand stays unknown. */
  }
  return result;
}
/** Snapshot all runtime files before launch: package upgrades never remove active browser chunks. */
export async function prepareRuntime(root: string, dataDir: string) {
  const info = await releaseInfo(root);
  const releases = join(dataDir, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const target = join(releases, info.build);
  try {
    if ((await releaseInfo(target)).build === info.build) return target;
  } catch {
    /* Build a complete candidate. */
  }
  const stage = join(releases, ".prepare-" + randomUUID());
  await mkdir(stage, { mode: 0o700 });
  try {
    await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
    await cp(join(root, "package.json"), join(stage, "package.json"));
    await releaseInfo(stage);
    try {
      await rename(stage, target);
    } catch (e) {
      if (!(await Bun.file(join(target, "dist", "build.json")).exists())) throw e;
    }
    return target;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export const compareVersions = (a: string, b: string) => {
  const aa = a.split(".").map(Number),
    bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
};
export async function checkUpdate(
  installed: Installation,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<UpdateState> {
  if (installed.kind === "development")
    return {
      state: "failed",
      latest: null,
      checkedAt: Date.now(),
      error:
        "This is a development checkout. Update and rebuild the checkout; it is not a global installation.",
    };
  const response = await fetcher(`https://registry.npmjs.org/${PACKAGE}/latest`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "No published release is available yet."
        : `The package registry returned ${response.status}.`,
    );
  const pkg = await response.json();
  if (
    pkg.name !== PACKAGE ||
    !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
    pkg.bin?.[PACKAGE] !== "dist/cli.js"
  )
    throw new Error("The registry entry is not a compatible Workflow Observer release.");
  return {
    state: compareVersions(pkg.version, installed.version) > 0 ? "available" : "current",
    latest: pkg.version,
    checkedAt: Date.now(),
    error: null,
  };
}
export async function installUpdate(
  installed: Installation,
  version: string,
  dataDir: string,
  run: Command = command,
) {
  if (
    !["bun-global", "npm-global"].includes(installed.kind) ||
    !installed.manager ||
    !installed.prefix
  )
    throw new Error(
      installed.kind === "bunx"
        ? "Use bunx workflow-observer@latest to run a published release."
        : "Self-update requires a verified Bun or npm global installation. Update this checkout or installation directly.",
    );
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version.");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const guard = new Database(join(dataDir, "update.lock.sqlite"));
  try {
    guard.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  } catch {
    guard.close();
    throw new Error("Another Observer update is already in progress.");
  }
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(tmpdir(), "observer-update-"));
    await run([process.execPath, "add", "--ignore-scripts", `${PACKAGE}@${version}`], {
      cwd: stage,
      timeout: 120000,
    });
    const candidate = join(stage, "node_modules", PACKAGE);
    const verified = await releaseInfo(candidate);
    if (verified.version !== version) throw new Error("Downloaded release version does not match.");
    await prepareRuntime(candidate, dataDir);
    // Verify installation ownership again immediately before touching the global package.
    const current = await detectInstallation(installed.root, run);
    if (current.kind !== installed.kind || current.prefix !== installed.prefix)
      throw new Error("Installation ownership changed. Update cancelled.");
    const args =
      installed.kind === "bun-global"
        ? [installed.manager, "add", "--global", "--ignore-scripts", `${PACKAGE}@${version}`]
        : [
            installed.manager,
            "install",
            "--global",
            "--prefix",
            installed.prefix,
            "--ignore-scripts",
            `${PACKAGE}@${version}`,
          ];
    await run(args, { timeout: 120000 });
    const actual = await releaseInfo(installed.root);
    if (actual.version !== version)
      throw new Error("The global package manager did not install the selected release.");
    return actual;
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      try {
        guard.exec("ROLLBACK");
      } finally {
        guard.close();
      }
    }
  }
}
