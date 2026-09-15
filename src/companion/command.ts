import { spawn } from "node:child_process";
import { Effect } from "effect";
export type Command = (
  argv: string[],
  options?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;
/** Every process has a deadline and closes with its Effect scope; arguments never enter a shell. */
export const commandEffect = (
  argv: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          signal,
          timeout: options.timeout ?? 12000,
        });
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 2_000_000) child.kill();
        });
        child.stderr.on("data", (chunk) => {
          error += chunk;
          if (error.length > 100_000) child.kill();
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve(output.trim())
            : reject(new Error((error || output || `${argv[0]} exited ${code}`).slice(0, 3000))),
        );
      }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
export const command: Command = (argv, options) => Effect.runPromise(commandEffect(argv, options));
export const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));
