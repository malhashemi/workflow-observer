import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntime, releaseInfo } from "../src/companion/install";

test("version-only releases get distinct immutable runtime snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-release-"));
  const root = join(dir, "package");
  try {
    await mkdir(join(root, "src", "client"), { recursive: true });
    await mkdir(join(root, "public"));
    await cp(join(import.meta.dir, "../src/build.ts"), join(root, "src", "build.ts"));
    for (const file of ["cli.ts", "server.ts", "client/main.tsx"])
      await Bun.write(join(root, "src", file), 'console.log("same application");');
    await Bun.write(join(root, "public", "index.html"), "<!doctype html><title>Observer</title>");
    const build = async (version: string) => {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ name: "workflow-observer", version }),
      );
      const child = Bun.spawn([process.execPath, "src/build.ts"], {
        cwd: root,
        stdout: "ignore",
        stderr: "pipe",
      });
      const error = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) throw new Error(error);
      return releaseInfo(root);
    };
    const before = await build("0.1.0");
    const first = await prepareRuntime(root, join(dir, "data"));
    const after = await build("0.1.1");
    expect(after.build).not.toBe(before.build);
    const second = await prepareRuntime(root, join(dir, "data"));
    expect(second).not.toBe(first);
    expect((await releaseInfo(first)).version).toBe("0.1.0");
    expect((await releaseInfo(second)).version).toBe("0.1.1");
    expect((await build("0.1.1")).build).toBe(after.build);
    expect(await prepareRuntime(root, join(dir, "data"))).toBe(second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
