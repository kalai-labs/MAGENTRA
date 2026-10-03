// The engine probe: load the BUILT engine with a given brain and report what it
// makes of it. Run as a child process by engine.ts — never imported — so each
// probe starts from fresh module state (the engine registers its prompts and
// tools once per process).
//
//   BRAIN_PROBE_GENERATED  the brain to load: the compiled brain module
//                          (brain.generated.ts text) in a file of its own; its
//                          types are stripped here, next to a .mjs copy
//   MAGENTRA_PROMPTS_DIR   set by the caller to an empty folder, so no prompt
//                          override on this machine colours the result
//
// A module resolve hook swaps engine/protocol/dist/brain.generated.js for that
// file, so the engine code is the last build's and the brain is the one asked
// about. Then it does what the engine does at load: build the tool registry
// (every toolDescription/toolParam/assertToolParamStates runs) and load the
// core (every brainPrompt id is checked). It renders the standing system prompt
// for one fixed environment and hashes every tool's wire text, so a plan can
// say whether either changes.
//
// Prints ONE JSON line on stdout.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const target = pathToFileURL(realpathSync(join(repo, "engine", "protocol", "dist", "brain.generated.js"))).href;
const source = process.env.BRAIN_PROBE_GENERATED;
const stripped = `${source}.mjs`;
writeFileSync(stripped, stripTypeScriptTypes(readFileSync(source, "utf8")), "utf8");
const swapped = pathToFileURL(stripped).href;

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return resolved.url === target ? { ...resolved, url: swapped, shortCircuit: true } : resolved;
  },
});

// One fixed environment, so two probes differ only where their brains do.
const ENV = { cwd: "/w", isGitRepo: false, platform: "win32", model: "m", date: "2026-01-01" };

const out = { ok: true };
try {
  const protocol = await import(pathToFileURL(join(repo, "engine", "protocol", "dist", "index.js")).href);
  const tools = await import(pathToFileURL(join(repo, "engine", "tools", "dist", "index.js")).href);
  const core = await import(pathToFileURL(join(repo, "engine", "core", "dist", "index.js")).href);
  const { z } = await import("zod");
  const wire = tools
    .createDefaultRegistry()
    .list()
    .map((t) => ({ name: t.name, description: t.description, descriptionVars: Object.keys(t.descriptionVars ?? {}).sort(), inputSchema: z.toJSONSchema(t.inputSchema) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.systemPrompt = core.buildSystemPrompt({ env: ENV }).replace(/\r\n/g, "\n").trimEnd() + "\n";
  out.toolContractHash = createHash("sha256").update(JSON.stringify(wire)).digest("hex").slice(0, 16);
  out.unreadParams = protocol.unreadToolParams();
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? err.message : String(err);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
