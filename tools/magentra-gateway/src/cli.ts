#!/usr/bin/env node
/**
 * magentra-gateway — the single source of truth for every feature MAGENTRA
 * ships, the tests that prove each one, and the reasons those tests exist.
 *
 *   npm run gateway                        → http://127.0.0.1:4320
 *   npm run gateway -- --port 5000
 *   npm run gateway -- --no-open
 *   npm run gateway -- brief <feature-id>  → the agent briefing, as Markdown
 *
 * Run through `tsx`, with no build step in front of it: the gateway must start
 * when `npm run build` is broken, because a broken build is exactly when you
 * need to look at what the inventory says (decisions/0002).
 *
 * Port 4320. Prompt Lab holds 4319.
 */

import { spawn } from "node:child_process";

import { buildBrief, renderBrief } from "./brief.js";
import { checkConnection, describeConnection } from "./connection.js";
import { createGateway } from "./server.js";
import { loadDescriptions, loadFeatures, repoRoot, RegistryError } from "./registry.js";
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

/**
 * SPEC §8's other half: the brief on stdout, so an agent can be handed it
 * without a server running. Same assembly as the HTTP route — one definition.
 */
async function briefCommand(root: string, id: string | undefined): Promise<number> {
  if (id === undefined || id.startsWith("--")) {
    process.stderr.write("\n  usage: npm run gateway -- brief <feature-id>\n\n");
    return 2;
  }
  const features = loadFeatures(root);
  const feature = features.find((f) => f.id === id);
  if (feature === undefined) {
    const near = features.filter((f) => f.id.includes(id)).slice(0, 8).map((f) => f.id);
    process.stderr.write(
      `\n  !! no feature record with id "${id}"\n` +
        (near.length ? `     did you mean: ${near.join(", ")}\n` : "") + "\n",
    );
    return 2;
  }
  process.stdout.write(renderBrief(await buildBrief(root, feature, features, loadDescriptions(root))));
  return 0;
}

async function main(): Promise<number> {
  const root = repoRoot();

  if (process.argv[2] === "brief") return briefCommand(root, process.argv[3]);
  const port = Number(arg("port", "4320"));
  const host = arg("host", "127.0.0.1");

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`  !! --port must be a port number, got "${arg("port", "")}"\n`);
    return 2;
  }

  // Records load before anything is served. A malformed record names its file
  // and stops the tool: an inventory that is trusted must never be served
  // partially (SPEC §2, decisions/0001).
  let features;
  try {
    features = loadFeatures(root);
  } catch (err) {
    if (err instanceof RegistryError) {
      process.stderr.write(`\n  !! the inventory did not load\n\n${err.message}\n\n`);
      return 2;
    }
    throw err;
  }

  // Stage 2 is checked at startup, mirroring the TUI (decisions/0005). Unlike
  // the TUI, a refusal here does not stop the tool: the gateway's job is to
  // make the missing precondition visible and keep RUN disabled, and a gateway
  // that will not start is a gateway that cannot show you the inventory.
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
  process.stdout.write(
    `\n  MAGENTRA Gateway — ${features.length} features (${features.length - deferred} testable, ${deferred} deferred)\n` +
      `  ${url}\n` +
      `  freshness: ${freshness.ok ? `all ${freshness.checked} records match the code` : `${freshness.stale.length} STALE — every run is blocked`}\n` +
      `  ${describeConnection(connection)}\n` +
      `  ${gateway.gate().runAllowed ? "RUN is available" : "RUN is DISABLED until both lamps are green"}\n\n`,
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
