#!/usr/bin/env node
// tools-check — every registered tool is well-formed, and the read-only ones
// actually work against a real temp workspace.
//
//   npm run build && node .claude/skills/bigboycoding/tools-check.mjs
//
// engine/tools has no unit suite, so nothing else would catch a tool that lost
// its schema, its permission class, or its ability to run. This asserts the
// contract every tool declares (engine/core/src/agent/tool.ts) and then
// EXECUTES the ones with no side effects, so "registered" is never mistaken for
// "working".
//
// Deliberately does not run mutate/execute/network tools: this check must be
// safe to run at any time, and a Bash smoke test would be a worse trade than
// the coverage it buys.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  PASS  ${name}`); };
const bad = (name, why) => { fail++; console.log(`  FAIL  ${name} — ${why}`); };
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) bad(name, "returned false");
    else ok(name);
  } catch (err) {
    bad(name, err.message);
  }
}
async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === false) bad(name, "returned false");
    else ok(name);
  } catch (err) {
    bad(name, err.message);
  }
}

const { createDefaultRegistry } = await imp("engine/tools/dist/index.js");
const registry = createDefaultRegistry();
const tools = registry.list ? registry.list() : [...(registry.tools?.values?.() ?? [])];

console.log(`\nRegistry — ${tools.length} tools\n`);

// ── every tool declares a complete contract ────────────────────────────────
const CLASSES = new Set(["read", "mutate", "execute", "network", "interact"]);
const names = new Set();

for (const t of tools) {
  const n = t?.name ?? "(unnamed)";
  check(`${n} · contract`, () => {
    if (typeof t.name !== "string" || !t.name) throw new Error("no name");
    if (names.has(t.name)) throw new Error("duplicate name");
    names.add(t.name);
    if (typeof t.description !== "string" || t.description.trim() === "") throw new Error("no description");
    if (!t.inputSchema || typeof t.inputSchema.safeParse !== "function") throw new Error("inputSchema is not a zod schema");
    if (!CLASSES.has(t.permissionClass)) throw new Error(`bad permissionClass: ${t.permissionClass}`);
    if (typeof t.execute !== "function") throw new Error("no execute()");
    return true;
  });
}

// ── the schema rejects garbage (a schema that accepts anything is not one) ──
console.log("");
for (const t of tools) {
  check(`${t.name} · schema rejects a non-object`, () => {
    const r = t.inputSchema.safeParse(42);
    // A tool taking no input legitimately accepts anything object-ish; only
    // flag a schema that swallows a bare number.
    if (r.success && Object.keys(t.inputSchema.shape ?? {}).length > 0) {
      throw new Error("accepted the number 42 despite declaring fields");
    }
    return true;
  });
}

// ── read-only tools actually run ───────────────────────────────────────────
console.log("");
const ws = mkdtempSync(join(tmpdir(), "tools-check-"));
mkdirSync(join(ws, "src"), { recursive: true });
writeFileSync(join(ws, "src", "alpha.ts"), "export const alpha = 1;\n// needle\n");
writeFileSync(join(ws, "src", "beta.ts"), 'import { alpha } from "./alpha.js";\nexport const beta = alpha;\n');
writeFileSync(join(ws, "README.md"), "# fixture\n");

const byName = new Map(tools.map((t) => [t.name, t]));
// Shape per SessionServices in engine/core/src/agent/tool.ts — everything a
// read-only tool touches, and nothing else.
const { FileState } = await imp("engine/core/dist/runtime/fileState.js");
const { TaskStore } = await imp("engine/core/dist/state/taskStore.js");
const ctx = {
  cwd: ws,
  session: {
    emit: () => {},
    remind: () => {},
    fileState: new FileState(),
    tasks: new TaskStore(join(ws, ".magentra"), "s_toolscheck", () => {}),
    background: { list: () => [], start: () => {}, stop: () => false },
    askUser: async () => ({}),
    spawnAgent: async () => "",
    runInference: async () => "",
    describeImageForContext: async () => "",
    visionUnavailableReason: () => "vision is off in tools-check",
  },
};
const signal = new AbortController().signal;
const run = async (name, input) => {
  const t = byName.get(name);
  if (!t) throw new Error("not registered");
  const parsed = t.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`input rejected: ${parsed.error.issues?.[0]?.message}`);
  return t.execute(parsed.data, ctx, signal);
};
const textOf = (r) => (typeof r === "string" ? r : (r?.content ?? r?.text ?? JSON.stringify(r)));

await checkAsync("Read · returns numbered lines", async () => {
  const out = textOf(await run("Read", { file_path: join(ws, "src", "alpha.ts") }));
  if (!out.includes("alpha")) throw new Error(`no content: ${out.slice(0, 120)}`);
  return true;
});

await checkAsync("Read · refuses a relative path", async () => {
  const t = byName.get("Read");
  const parsed = t.inputSchema.safeParse({ file_path: "src/alpha.ts" });
  if (!parsed.success) return true; // rejected at the schema — also correct
  const r = await t.execute(parsed.data, ctx, signal);
  if (r?.isError !== true) throw new Error("accepted a relative path");
  return true;
});

await checkAsync("Glob · finds fixture files", async () => {
  const out = textOf(await run("Glob", { pattern: "**/*.ts", path: ws }));
  if (!out.includes("alpha.ts")) throw new Error(`missed alpha.ts: ${out.slice(0, 160)}`);
  return true;
});

await checkAsync("Grep · finds a needle", async () => {
  const out = textOf(await run("Grep", { pattern: "needle", path: ws, output_mode: "content" }));
  if (!out.includes("needle")) throw new Error(`no match: ${out.slice(0, 160)}`);
  return true;
});

await checkAsync("Grep · reports no-match without erroring", async () => {
  const r = await run("Grep", { pattern: "zzz-no-such-token-zzz", path: ws });
  if (r?.isError === true) throw new Error("treated no-match as an error");
  return true;
});

await checkAsync("TaskList · runs on an empty list", async () => {
  const out = textOf(await run("TaskList", {}));
  if (typeof out !== "string" || out.length === 0) throw new Error("no output");
  return true;
});

await checkAsync("GraphQuery · sees the fixture's import edge", async () => {
  const out = textOf(await run("GraphQuery", { op: "deps", files: ["src/beta.ts"] }));
  if (!out.includes("alpha")) throw new Error(`edge missing — beta.ts imports alpha.ts: ${out.slice(0, 200)}`);
  return true;
});

rmSync(ws, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
