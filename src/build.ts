import { cp, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
const out = join(root, "dist");
await mkdir(out, { recursive: true });
await rm(join(out, "client"), { recursive: true, force: true });
await cp(join(root, "public"), join(out, "client"), { recursive: true });
const builds = await Promise.all([
  Bun.build({
    entrypoints: [join(root, "src/client/main.tsx")],
    outdir: join(out, "client"),
    target: "browser",
    external: ["/fonts/*"],
    splitting: true,
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    naming: {
      entry: "[name].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  }),
  Bun.build({
    entrypoints: [join(root, "src/cli.ts"), join(root, "src/server.ts")],
    outdir: out,
    target: "bun",
    packages: "bundle",
    minify: true,
    naming: "[name].[ext]",
  }),
]);
for (const result of builds) if (!result.success) throw new Error(result.logs.join("\n"));
const files = [];
for await (const file of new Bun.Glob("**/*").scan({ cwd: join(out, "client"), onlyFiles: true }))
  files.push("/" + file);
console.log(`Built server, CLI and ${files.length} browser assets.`);

const pkg = await Bun.file(join(root, "package.json")).json();
const hash = createHash("sha256");
for (const file of ["cli.js", "server.js", ...files.sort().map((f) => "client" + f)])
  hash.update(
    await Bun.file(join(out, file))
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
  );
await Bun.write(
  join(out, "build.json"),
  JSON.stringify({ version: pkg.version, id: hash.digest("hex") }),
);
