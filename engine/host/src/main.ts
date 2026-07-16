import { resolve } from "node:path";
import { encodeFrame } from "@magentra/protocol";
import type { PermissionMode } from "@magentra/protocol";
import { MissingApiKeyError, bootstrapEngine } from "./bootstrap.js";
import { runServe } from "./serve.js";

/**
 * The engine host: a headless process that runs the agent engine and speaks
 * NDJSON over stdio. The desktop app spawns exactly this, and is its only
 * frontend — there is no terminal UI here, by design.
 *
 * Usage: engine --cwd <workspace> [--mode default|acceptEdits|plan] [--dangerously-bypass]
 */

interface HostArgs {
  cwd: string;
  mode?: PermissionMode;
}

/**
 * A fatal boot failure must reach the frontend in-band: the desktop app reads
 * NDJSON from stdout, so an error that only hits stderr leaves the user with a
 * dead process and no message. Emit the protocol frame first, stderr as backup.
 */
function fail(message: string): never {
  process.stdout.write(encodeFrame({ type: "error", message, fatal: true }));
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): HostArgs {
  let cwd = process.cwd();
  let mode: PermissionMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--cwd": {
        const value = argv[++i];
        if (!value) fail("--cwd requires a directory");
        cwd = resolve(value);
        break;
      }
      case "--mode": {
        const value = argv[++i];
        if (!value) fail("--mode requires one of default|acceptEdits|plan");
        if (value === "bypass") fail("use --dangerously-bypass to enable bypass mode");
        if (value !== "default" && value !== "acceptEdits" && value !== "plan") {
          fail(`unknown mode "${value}" (expected default|acceptEdits|plan)`);
        }
        mode = value;
        break;
      }
      case "--dangerously-bypass":
        mode = "bypass";
        break;
      // Serving is the only thing this binary does, but --serve stays accepted
      // so an older launch command still works.
      case "--serve":
        break;
      default:
        // Unknown flags are ignored rather than aborting the session.
        break;
    }
  }

  return { cwd, ...(mode ? { mode } : {}) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const booted = await bootstrapEngine(args).catch((err: unknown) => {
    if (err instanceof MissingApiKeyError) fail(err.message);
    throw err;
  });

  // Warnings go to stderr so stdout stays a clean NDJSON stream.
  for (const warning of booted.warnings) process.stderr.write(`warning ${warning}\n`);

  await runServe(booted.engine);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(encodeFrame({ type: "error", message, fatal: true }));
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
