#!/usr/bin/env node
// addon-check — the addon mechanism's invariants, asserted against the built
// output. Promised by docs/ADDONS.md.
//
//   npm run build && node .claude/skills/bigboycoding/addon-check.mjs
//
// The load-bearing one is CHEAP UNTIL USED: only name+description may ride in
// the standing system prompt, and the body may appear only once the Addon tool
// invokes it. Nothing else in the repo guards that, and breaking it is silent —
// the app looks identical while every session pays for every addon body.
//
// Also validates each SHIPPED built-in through the real parser, so an edit to
// the magentron text that breaks its frontmatter fails here rather than at a
// user's next session start.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

let pass = 0;
let fail = 0;
const ok = (n) => { pass++; console.log(`  PASS  ${n}`); };
const bad = (n, why) => { fail++; console.log(`  FAIL  ${n} — ${why}`); };
const check = (n, fn) => { try { fn() === false ? bad(n, "returned false") : ok(n); } catch (e) { bad(n, e.message); } };
const checkAsync = async (n, fn) => { try { (await fn()) === false ? bad(n, "returned false") : ok(n); } catch (e) { bad(n, e.message); } };

const { loadAddons, ADDONS_DIR, ADDON_ENTRY } = await imp("engine/core/dist/agent/addons.js");
const { BUILTIN_ADDONS } = await imp("engine/core/dist/agent/builtinAddons.js");
const { addonsBlock, buildSystemPrompt } = await imp("engine/core/dist/agent/prompts.js");
const protocol = await imp("engine/protocol/dist/index.js");
const { parseFrontmatter } = await imp("engine/core/dist/config/frontmatter.js");
const { addonTool } = await imp("engine/tools/dist/addon.js");

// ── shipped built-ins parse with the REAL parser ───────────────────────────
console.log("\nBuilt-ins\n");
for (const b of BUILTIN_ADDONS) {
  check(`${b.name} · frontmatter parses`, () => {
    const fm = parseFrontmatter(b.text);
    if (!fm.present) throw new Error("no --- frontmatter");
    if (!fm.map.name) throw new Error("no name:");
    if (!fm.map.description) throw new Error("no description:");
    if (fm.map.name !== b.name) throw new Error(`name: "${fm.map.name}" != registered "${b.name}"`);
    if (fm.body.trim() === "") throw new Error("empty body");
    return true;
  });
  check(`${b.name} · description is one physical line`, () => {
    // The parser is line-based; a wrapped description silently truncates.
    const line = b.text.split(/\r?\n/).find((l) => l.startsWith("description:"));
    if (!line) throw new Error("no description line");
    if (line.length < 40) throw new Error("suspiciously short — did it wrap?");
    return true;
  });
  check(`${b.name} · description declares its cost`, () => {
    const d = parseFrontmatter(b.text).map.description.toLowerCase();
    // An always-discoverable addon that front-loads work must say so where the
    // agent decides — see docs/ADDONS.md, "the description is the router".
    if (!/token|cost|expensive/.test(d)) throw new Error("no cost signal in a reconnaissance addon");
    return true;
  });
}

// ── the parser's real contract ─────────────────────────────────────────────
// Pinned because both the docs and the generator prompt used to claim a
// colon-space inside a value "would start a new key". It does not — the parser
// splits at the FIRST colon — and that false rule was taught to every generated
// addon. Assert the true behaviour so it cannot drift back.
console.log("\nFrontmatter contract\n");
check("a colon inside a value stays in the value", () => {
  const fm = parseFrontmatter("---\nname: demo\ndescription: Use when X happens: then do Y.\n---\n\nBody.\n");
  if (Object.keys(fm.map).length !== 2) throw new Error(`split into ${Object.keys(fm.map).length} keys`);
  if (fm.map.description !== "Use when X happens: then do Y.") throw new Error(`truncated: ${fm.map.description}`);
  return true;
});
check("a value that wraps onto a second line loses the remainder", () => {
  const fm = parseFrontmatter("---\nname: demo\ndescription: first part\n  second part\n---\n\nBody.\n");
  if (fm.map.description !== "first part") throw new Error(`unexpectedly kept the wrap: ${fm.map.description}`);
  return true;
});

// ── discovery: both layouts, and precedence ────────────────────────────────
console.log("\nDiscovery\n");
const ws = mkdtempSync(join(tmpdir(), "addon-check-"));
const addonsDir = join(ws, ".magentra", ADDONS_DIR);
mkdirSync(addonsDir, { recursive: true });

writeFileSync(join(addonsDir, "flat-one.md"), `---\nname: flat-one\ndescription: Use when testing the flat layout.\n---\n\nDo the flat thing.\n`);
mkdirSync(join(addonsDir, "dir-one", "references"), { recursive: true });
writeFileSync(join(addonsDir, "dir-one", ADDON_ENTRY), `---\nname: dir-one\ndescription: Use when testing the directory layout.\n---\n\nFollow references/notes.md.\n`);
writeFileSync(join(addonsDir, "dir-one", "references", "notes.md"), "the bundled note\n");
// Same name as a built-in — the workspace copy must win outright.
writeFileSync(join(addonsDir, "magentron.md"), `---\nname: magentron\ndescription: Overridden by the workspace.\n---\n\nWORKSPACE OVERRIDE BODY\n`);
// A directory with no ADDON.md is skipped rather than guessed at.
mkdirSync(join(addonsDir, "not-an-addon"), { recursive: true });
writeFileSync(join(addonsDir, "not-an-addon", "stray.md"), "nothing\n");

const loaded = loadAddons(ws);
const byName = new Map(loaded.map((a) => [a.name, a]));

check("flat <name>.md is discovered", () => byName.has("flat-one"));
check("<name>/ADDON.md is discovered", () => byName.has("dir-one"));
check("directory without ADDON.md is skipped", () => !byName.has("not-an-addon"));
check("built-ins are present", () => byName.has("magentron"));
check("workspace addon REPLACES the built-in of the same name", () => {
  const m = byName.get("magentron");
  if (!m.body.includes("WORKSPACE OVERRIDE BODY")) throw new Error("built-in body still in place");
  if (loaded.filter((a) => a.name === "magentron").length !== 1) throw new Error("both copies loaded");
  return true;
});
check("bundled siblings are advertised as paths", () => {
  const d = byName.get("dir-one");
  if (!d.resources || d.resources.length === 0) throw new Error("no resources listed");
  if (JSON.stringify(d.resources).includes("the bundled note")) throw new Error("resource CONTENT was inlined");
  return true;
});

// ── the core invariant: cheap until used ───────────────────────────────────
console.log("\nCheap until used\n");
const summaries = loaded.map((a) => ({ name: a.name, description: a.description }));
const system = buildSystemPrompt({
  env: { cwd: ws, isGitRepo: false, platform: "linux", model: "m", date: "2026-01-01" },
  addons: summaries,
});

check("roster block lists every addon", () => {
  const block = addonsBlock(summaries);
  for (const a of loaded) if (!block.includes(a.name)) throw new Error(`${a.name} missing from roster`);
  return true;
});
check("NO addon body reaches the standing system prompt", () => {
  // Passes the FULL addon objects — bodies included — not the name/description
  // summaries. That is the realistic regression: a caller hands loadAddons()'s
  // output straight to buildSystemPrompt, or addonsBlock starts reading .body.
  // Handing it summaries proves nothing, since they carry no body to leak.
  const withBodies = buildSystemPrompt({
    env: { cwd: ws, isGitRepo: false, platform: "linux", model: "m", date: "2026-01-01" },
    addons: loaded,
  });
  for (const a of loaded) {
    const probe = a.body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 25);
    if (probe && withBodies.includes(probe)) throw new Error(`${a.name}'s body leaked into the system prompt`);
  }
  return true;
});
check("descriptions DO reach the system prompt", () => {
  for (const a of loaded) if (!system.includes(a.name)) throw new Error(`${a.name} not offered to the model`);
  return true;
});
check("empty roster contributes no block at all", () => addonsBlock([]) === undefined);

// ── the invocation header: one definition, user on top ─────────────────────
// The header used to be the same sentence written out at BOTH call sites (the
// Addon tool and the /<name> dispatch), in two packages. It also claimed only
// that an addon "takes priority over general guidance", with no limit — so a
// relentless procedure kept interviewing straight through the user delegating
// the decision back and asking it to stop.
console.log("\nInvocation header\n");
const { addonInvocationHeader } = await imp("engine/core/dist/agent/addons.js");
const header = addonInvocationHeader("grill-me");

check("names the addon and opens a system-reminder", () => {
  if (!header.startsWith("<system-reminder>")) throw new Error("no system-reminder wrapper");
  if (!header.includes('"grill-me"')) throw new Error("addon name absent");
  if (!header.includes("<command-name>/grill-me</command-name>")) throw new Error("no command-name line");
  return true;
});
check("the USER outranks a loaded addon", () => {
  // The behaviour bug: an addon that outranks everything ignores the person
  // typing. Assert the carve-out survives any future rewording of the header.
  if (!/user\s+outranks/i.test(header)) throw new Error("no user-precedence clause");
  for (const [label, re] of [
    ["delegating a decision back", /handing a decision back/i],
    ["asking it to stop", /stop or move on/i],
    ["narrowing the request", /narrowing what they want/i],
  ]) {
    if (!re.test(header)) throw new Error(`does not cover: ${label}`);
  }
  return true;
});
check("both invocation paths share ONE definition", () => {
  // Drift guard: the tool and the slash dispatch must not carry their own copy.
  const toolSrc = readFileSync(join(ROOT, "engine/tools/src/addon.ts"), "utf8");
  const engineSrc = readFileSync(join(ROOT, "engine/core/src/runtime/engine.ts"), "utf8");
  for (const [file, src] of [["tools/addon.ts", toolSrc], ["runtime/engine.ts", engineSrc]]) {
    if (!src.includes("addonInvocationHeader")) throw new Error(`${file} does not use the shared header`);
    if (/addon was invoked\. Follow its instructions/.test(src)) {
      throw new Error(`${file} still inlines its own copy of the header`);
    }
  }
  return true;
});
check("the header is editable from the prompt registry", () => {
  const src = readFileSync(join(ROOT, "engine/core/src/agent/addons.ts"), "utf8");
  if (!/definePrompt\(\{[\s\S]*id: "addon\.invoke-header"/.test(src)) {
    throw new Error("not registered — an operator cannot inspect or override it");
  }
  return true;
});

// ── naming an addon in a message reaches it ────────────────────────────────
// "bana /grill-me yap" was answered with a clarify menu asking what /grill-me
// ought to be — for an addon already installed, whose description says exactly
// what it does. Nothing told the model that a leading slash in a USER message
// names an addon, and clarify ran before anything could.
console.log("\nNaming an addon\n");
const { addonNamedIn } = await imp("engine/core/dist/runtime/session.js");
const fake = [{ name: "grill-me" }, { name: "magentron" }, { name: "review" }, { name: "review-sql" }];

check("a name mid-message is found", () => {
  for (const [text, want] of [
    ["bana /grill-me yap", "grill-me"],
    ["use /magentron on this", "magentron"],
    ["/grill-me", "grill-me"],
    ["/grill-me, then stop", "grill-me"],
  ]) {
    const got = addonNamedIn(text, fake);
    if (got !== want) throw new Error(`${JSON.stringify(text)} → ${got}, want ${want}`);
  }
  return true;
});
check("the longest matching name wins", () => {
  if (addonNamedIn("check /review-sql now", fake) !== "review-sql") throw new Error("/review shadowed /review-sql");
  if (addonNamedIn("/review please", fake) !== "review") throw new Error("shorter name stopped matching");
  return true;
});
check("paths, URLs and unknown names do not match", () => {
  for (const text of ["look at src/grill-me/file.ts", "see http://x/review", "what about /unknown-thing"]) {
    const got = addonNamedIn(text, fake);
    if (got !== undefined) throw new Error(`${JSON.stringify(text)} matched ${got}`);
  }
  return true;
});
check("the roster teaches the slash form", () => {
  const block = addonsBlock([{ name: "grill-me", description: "d" }]);
  if (!/leading slash/i.test(block)) throw new Error("never says a user may name an addon with a slash");
  if (!/ANYWHERE in a message/i.test(block)) throw new Error("does not say mid-message counts");
  return true;
});
check("the named-addon reminder is registered", () => {
  const text = protocol.promptText("reminder.addon-named");
  if (!text || !text.includes("{{name}}")) throw new Error("reminder.addon-named missing or has no {{name}} slot");
  return true;
});

// ── the Addon tool loads the body on invoke ────────────────────────────────
console.log("\nOn invoke\n");
const ctx = { cwd: ws, session: { addons: loaded, emit: () => {}, remind: () => {} } };
const signal = new AbortController().signal;
const runTool = (input) => addonTool.execute(addonTool.inputSchema.parse(input), ctx, signal);

await checkAsync("invoking an addon returns its body", async () => {
  const r = await runTool({ addon: "flat-one" });
  if (!r.content.includes("Do the flat thing")) throw new Error("body not loaded");
  return true;
});
await checkAsync("$ARGUMENTS is substituted", async () => {
  writeFileSync(join(addonsDir, "argy.md"), `---\nname: argy\ndescription: Use when testing arguments.\n---\n\nTarget is $ARGUMENTS now.\n`);
  const fresh = loadAddons(ws);
  const c2 = { cwd: ws, session: { addons: fresh, emit: () => {}, remind: () => {} } };
  const r = await addonTool.execute(addonTool.inputSchema.parse({ addon: "argy", args: "the-widget" }), c2, signal);
  if (!r.content.includes("Target is the-widget now")) throw new Error(`not substituted: ${r.content.slice(0, 120)}`);
  return true;
});
await checkAsync("an unknown addon errors and lists the real names", async () => {
  const r = await runTool({ addon: "no-such-addon" });
  if (r.isError !== true) throw new Error("did not error");
  if (!r.content.includes("flat-one")) throw new Error("did not list available addons");
  return true;
});
await checkAsync("bundled files are named, never inlined, on invoke", async () => {
  const r = await runTool({ addon: "dir-one" });
  if (!r.content.includes("notes.md")) throw new Error("sibling path not advertised");
  if (r.content.includes("the bundled note")) throw new Error("sibling CONTENT was inlined");
  return true;
});

rmSync(ws, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
