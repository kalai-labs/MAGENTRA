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
// about. Then it does what the engine and the pin tests do at load: build the
// tool registry (every toolDescription/toolParam/assertToolParamStates runs),
// load the core (every brainPrompt id is checked), and render the two pinned
// artifacts with tests/lib/approved.ts — the same printers the tests and
// `npm run approve` use, never a copy.
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

const out = { ok: true };
try {
  const approved = await import(pathToFileURL(join(repo, "tests", "lib", "approved.ts")).href);
  const protocol = await import(pathToFileURL(join(repo, "engine", "protocol", "dist", "index.js")).href);
  await import(pathToFileURL(join(repo, "engine", "core", "dist", "index.js")).href);
  const systemPrompt = approved.renderSystemPrompt();
  const toolContract = approved.renderToolContract();
  const pin = (featureId, name, rendered) => {
    let approvedText;
    try {
      approvedText = approved.readApproved(featureId, name);
    } catch {
      return { holds: false, difference: "no approved artifact on disk" };
    }
    const difference = approved.firstDifference(rendered, approvedText);
    return difference === undefined ? { holds: true } : { holds: false, difference };
  };
  out.systemPrompt = systemPrompt;
  out.toolContractHash = createHash("sha256").update(toolContract).digest("hex").slice(0, 16);
  out.pins = {
    "system-prompt-is-pinned": pin("system-prompt-is-pinned", "system-prompt.txt", systemPrompt),
    "tool-wire-contract-is-pinned": pin("tool-wire-contract-is-pinned", "tools.json", toolContract),
  };
  out.unreadParams = protocol.unreadToolParams();
} catch (err) {
  out.ok = false;
  out.error = err instanceof Error ? err.message : String(err);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
