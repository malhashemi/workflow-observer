import { appendFile } from "node:fs/promises";
import { join } from "node:path";

// Registry failures must fail the job, rather than look like an unpublished version.
const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error("The main release workflow accepts stable major.minor.patch versions only.");
}
const response = await fetch(
  `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
  { signal: AbortSignal.timeout(30_000) },
);
if (response.status !== 404 && !response.ok) {
  throw new Error(`Could not check npm: HTTP ${response.status}`);
}
const published = response.ok;
const archive = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
const values = { published: String(published), version: pkg.version, archive };
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}
console.log(
  `${pkg.name}@${pkg.version}: ${published ? "already published; no release needed" : "ready to publish"}`,
);
