// Run with `bun run test:package`. Uses only a disposable profile/config/data directory.
import { mkdtemp, mkdir, writeFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../src/companion/command";
import { defaultConfig } from "../src/config";
const root = join(import.meta.dir, ".."),
  pkg = await Bun.file(join(root, "package.json")).json();
const dir = await mkdtemp(join(tmpdir(), "observer-package-")),
  config = join(dir, "config.json"),
  data = join(dir, "data");
const archive = join(root, `${pkg.name}-${pkg.version}.tgz`);
const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = socket.port!;
socket.stop(true);
const env = { ...process.env, PORT: "", WORKFLOW_OBSERVER_CONFIG: config, OBSERVER_DATA_DIR: data };
const packageDir = join(dir, "package"),
  cli = join(packageDir, "dist", "cli.js");
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
let started = false;
const directories: string[] = [];
try {
  await command(["tar", "-xzf", archive, "-C", dir]);
  const files = Array.from(new Bun.Glob("**/*").scanSync({ cwd: packageDir, onlyFiles: true }));
  assert(
    !files.some(
      (f) =>
        f.includes("node_modules") ||
        f.endsWith(".sqlite") ||
        f.endsWith("config.json") ||
        f.startsWith("design/"),
    ),
    "Private/development files entered the package",
  );
  for (const file of files) await chmod(join(packageDir, file), 0o444);
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: packageDir, onlyFiles: false })) {
    const path = join(packageDir, entry);
    if ((await stat(path)).isDirectory()) directories.push(path);
  }
  for (const path of directories) await chmod(path, 0o555);
  await chmod(packageDir, 0o555);
  await writeFile(
    config,
    JSON.stringify({ ...defaultConfig, claudeDirectories: [], port, openBrowser: false }),
  );
  await mkdir(data);
  await command([process.execPath, cli, "--background", "--no-open"], { env, timeout: 50000 });
  started = true;
  const url = `http://127.0.0.1:${port}/`;
  const status = await fetch(url + "api/status").then((r) => r.json());
  assert(status.companion.version === pkg.version, "Wrong packaged version");
  const list = await fetch(url + "api/runs").then((r) => r.json());
  assert(list.days === 7 && list.runs.length === 0, "Default library mismatch");
  assert((await fetch(url)).ok, "Browser assets unavailable");
  assert(
    (await command([process.execPath, cli, "url", "--local"], { env })) === url,
    "CLI URL mismatch",
  );
  const before = status.companion.instanceId;
  await command([process.execPath, cli, "restart", "--background", "--no-open"], {
    env,
    timeout: 50000,
  });
  const after = await fetch(url + "api/status").then((r) => r.json());
  assert(after.companion.instanceId !== before, "Restart did not replace the instance");
  assert(after.companion.version === pkg.version, "Restart changed release");
  console.log(
    `Package smoke passed: ${files.length} files, read-only package, no node_modules, default 7-day library, URL and restart verified.`,
  );
} finally {
  if (started) await command([process.execPath, cli, "stop"], { env, timeout: 50000 });
  await chmod(packageDir, 0o755).catch(() => {});
  // Runtime snapshots inherit read-only directory modes from the extracted package.
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: false, dot: true })) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) await chmod(path, 0o755);
  }
  await rm(dir, { recursive: true, force: true });
}
