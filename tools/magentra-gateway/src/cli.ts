#!/usr/bin/env node
/**
 * magentra-gateway — the single source of truth for every feature MAGENTRA
 * ships, the tests that prove each one, and the reasons those tests exist.
 *
 *   npm run gateway                        → http://127.0.0.1:4320
 *   npm run gateway -- --port 5000
 *   npm run gateway -- --no-open
 *
 * Run through `tsx`, with no build step in front of it: the gateway must start
 * when `npm run build` is broken, because a broken build is exactly when you
 * need to look at what the inventory says (decisions/0002).
 *
 * Port 4320. Prompt Lab holds 4319.
 */

import { spawn } from "node:child_process";

import { checkConnection, describeConnection } from "./connection.js";
import { createGateway } from "./server.js";
import { loadFeatures, repoRoot, RegistryError } from "./registry.js";
import { discoverTests, proofByFeature } from "./tests.js";
import { checkFreshness } from "./freshness.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i !== -1 && next !== undefined && !next.startsWith("--") ? next : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Best-effort; a failure to open a browser is never a reason to stop serving. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // Not `npx`-style indirection: cmd.exe is spawned directly, because
          // `execFile`/`spawn` without a shell cannot run a `.cmd` shim — the
          // lesson tools/prompt-lab/server.mjs records about `npx tsc`.
          [process.env.COMSPEC ?? "cmd.exe", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no browser to open */
  }
}

async function main(): Promise<number> {
  const root = repoRoot();

  const port = Number(arg("port", "4320"));
  const host = arg("host", "127.0.0.1");

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`  !! --port must be a port number, got "${arg("port", "")}"\n`);
    return 2;
  }

  // Records load before anything is served. A malformed record names its file
  // and stops the tool: an inventory that is trusted must never be served
  // partially (SPEC §2, decisions/0001).
  // The test files are read before the records, because a record's `status` is
  // derived from them (decisions/0007) — loading first and asking later is what
  // made the banner and the UI report 164 untested features while tests existed.
  const tests = discoverTests(root);
  let features;
  try {
    features = loadFeatures(root, proofByFeature(tests));
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`\n  !! the inventory did not load\n\n${err.message}\n\n`);
      return 2;
    }
    throw err;
  }

  // Stage 2 is checked at startup, mirroring the TUI (decisions/0005). Unlike
  // the TUI, a refusal here does not stop the tool: the gateway's job is to
  // make the missing precondition visible, and a gateway that will not start
  // is a gateway that cannot show you the inventory.
  const connection = checkConnection(root);
  const freshness = checkFreshness(root, features);

  const gateway = createGateway({ root });
  let bound: { port: number; host: string };
  try {
    bound = await gateway.listen(port, host);
  } catch (err) {
    // A taken port is an ordinary thing to hit — prompt-lab holds 4319 and a
    // second gateway holds 4320 — so it reads as one line, not as a stack.
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE") {
      process.stderr.write(
        `\n  !! ${host}:${port} is already in use — another gateway is probably running.\n` +
          `     npm run gateway -- --port ${port + 1}\n\n`,
      );
      return 2;
    }
    process.stderr.write(`\n  !! could not listen on ${host}:${port} — ${err instanceof Error ? err.message : String(err)}\n\n`);
    return 2;
  }
  const url = `http://${bound.host}:${bound.port}`;

  const deferred = features.filter((f) => f.deferred === true).length;
  const testable = features.length - deferred;
  const untested = features.filter((f) => f.status === "untested" && f.deferred !== true).length;
  process.stdout.write(
    `\n  MAGENTRA Gateway — ${features.length} features (${testable} testable, ${deferred} deferred)\n` +
      `  ${url}\n` +
      `  freshness: ${freshness.ok ? `all ${freshness.checked} records match the code` : `${freshness.stale.length} STALE — review and reconcile before trusting the inventory`}\n` +
      `  tests: ${tests.tests.length} in ${tests.scanned} file${tests.scanned === 1 ? "" : "s"} — ${testable - untested} of ${testable} features proven` +
      `${tests.problems.length > 0 ? `, ${tests.problems.length} DISCOVERY PROBLEM${tests.problems.length === 1 ? "" : "S"} (see the gate panel)` : ""}\n` +
      `  ${describeConnection(connection)}\n\n`,
  );

  if (!flag("no-open")) openBrowser(url);

  const stop = (): void => {
    gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return -1; // keep serving
}

const code = await main();
if (code >= 0) process.exit(code);
