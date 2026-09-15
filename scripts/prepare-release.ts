import { join } from "node:path";

const root = join(import.meta.dir, "..");
const path = join(root, "package.json");
const pkg = await Bun.file(path).json();
const bump = Bun.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  throw new Error("Usage: bun run release:prepare patch|minor|major");
}
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) throw new Error("Release preparation requires a stable major.minor.patch version.");
const [major, minor, patch] = match.slice(1).map(Number);
pkg.version =
  bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
const lock = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (lock.exitCode !== 0) throw new Error("Version saved; refresh bun.lock before committing.");
console.log(`Prepared ${pkg.name}@${pkg.version}. Commit package.json and bun.lock in your PR.`);
console.log(
  "Merging to main runs checks and publishes this version. Nothing has been committed or published yet.",
);
