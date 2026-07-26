#!/usr/bin/env node
/**
 * blast-radius — what breaks if I touch this?
 *
 * MAGENTRA has two halves that the compiler treats very differently:
 *   engine/*  TypeScript, covered by `tsc -b`
 *   app/*     plain JS (Electron main + renderer), covered by NOTHING
 *
 * So an import graph alone lies. A frame type or field renamed in
 * engine/protocol typechecks perfectly and silently breaks a renderer
 * `case "..."`. This tool reports both: the typed import graph AND the
 * raw string reach into the untyped half.
 *
 * Usage (from repo root):
 *   node .claude/skills/bigboycoding/blast-radius.mjs <file> [file...]
 *   node .claude/skills/bigboycoding/blast-radius.mjs --symbol <Name>
 *   node .claude/skills/bigboycoding/blast-radius.mjs --frame <frame-type>
 *   node .claude/skills/bigboycoding/blast-radius.mjs --entrypoints
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const ROOT = process.cwd();
const rel = (p) => relative(ROOT, p).split(sep).join("/");

// ── file collection ────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "out", "fonts", ".claude"]);

function walk(dir, exts, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), exts, acc);
    } else if (exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

const engineFiles = walk(join(ROOT, "engine"), [".ts"]).filter((f) => f.includes(`${sep}src${sep}`));
const appFiles = walk(join(ROOT, "app"), [".js", ".mjs", ".html"]);
const toolFiles = walk(join(ROOT, "tools"), [".mjs", ".js", ".ts"]);
const allFiles = [...engineFiles, ...appFiles, ...toolFiles];

const source = new Map();
for (const f of allFiles) {
  try {
    source.set(f, readFileSync(f, "utf8"));
  } catch {
    /* unreadable — skip */
  }
}

// ── import graph (typed half + app's own relative imports) ─────────────────
const WORKSPACE = {
  "@magentra/core": "engine/core/src/index.ts",
  "@magentra/protocol": "engine/protocol/src/index.ts",
  "@magentra/providers": "engine/providers/src/index.ts",
  "@magentra/tools": "engine/tools/src/index.ts",
  "@magentra/host": "engine/host/src/index.ts",
};

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

/** Resolve a specifier to an on-disk file we know about, or null. */
function resolveSpec(spec, fromFile) {
  if (WORKSPACE[spec]) {
    const p = join(ROOT, WORKSPACE[spec]);
    return source.has(p) ? p : null;
  }
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  // NodeNext writes ".js" in TS sources; the real file is ".ts".
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const c of candidates) if (source.has(c)) return c;
  return null;
}

const imports = new Map(); // file -> Set<file>
const importers = new Map(); // file -> Set<file>
for (const [file, text] of source) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    const target = resolveSpec(m[1], file);
    if (target && target !== file) out.add(target);
  }
  imports.set(file, out);
  for (const t of out) {
    if (!importers.has(t)) importers.set(t, new Set());
    importers.get(t).add(file);
  }
}

function transitiveImporters(file) {
  const seen = new Set();
  const queue = [file];
  while (queue.length) {
    const cur = queue.pop();
    for (const imp of importers.get(cur) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      queue.push(imp);
    }
  }
  return seen;
}

// ── exported symbols ───────────────────────────────────────────────────────
const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:declare\s+)?(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

function exportsOf(file) {
  const text = source.get(file) ?? "";
  return [...text.matchAll(EXPORT_RE)].map((m) => m[1]);
}

// ── the untyped seam: raw string reach into app/ ───────────────────────────
const isEngine = (f) => rel(f).startsWith("engine/");
const isApp = (f) => rel(f).startsWith("app/");

/**
 * Every file mentioning `needle` as a word, split by compiler coverage.
 * `scriptsOnly` drops .html — index.html is full of English prose ("Usage",
 * "Session") that word-matches type names and produces pure noise.
 */
function textReach(needle, scriptsOnly = false) {
  const re = new RegExp(`(?<![\\w$])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  const typed = [];
  const untyped = [];
  for (const [file, text] of source) {
    if (scriptsOnly && file.endsWith(".html")) continue;
    if (!re.test(text)) continue;
    const lines = text.split("\n");
    const hits = [];
    lines.forEach((l, i) => {
      if (re.test(l)) hits.push({ line: i + 1, text: l.trim().slice(0, 110) });
    });
    (isApp(file) ? untyped : typed).push({ file, hits });
  }
  return { typed, untyped };
}

// ── entrypoints ────────────────────────────────────────────────────────────
const ENTRYPOINTS = [
  "engine/host/src/index.ts",
  "engine/core/src/index.ts",
  "app/main.js",
  "app/preload.js",
  "app/renderer/index.html",
];

// ── reporting ──────────────────────────────────────────────────────────────
const bar = (s) => `\n${"─".repeat(74)}\n${s}\n${"─".repeat(74)}`;

function reportFile(target) {
  const abs = resolve(ROOT, target);
  if (!source.has(abs)) {
    console.log(`\n!! ${target} — not in the scanned graph (typo, or in dist/node_modules?)`);
    return;
  }
  const direct = [...(importers.get(abs) ?? [])].map(rel).sort();
  const trans = transitiveImporters(abs);
  const fanout = [...(imports.get(abs) ?? [])].map(rel).sort();
  const exps = exportsOf(abs);

  console.log(bar(`FILE  ${rel(abs)}`));
  console.log(`risk        ${riskVerdict(direct.length, trans.size, rel(abs))}`);
  console.log(`exports     ${exps.length ? exps.join(", ") : "(none found)"}`);
  console.log(`fan-out     imports ${fanout.length} local file(s)`);
  for (const f of fanout) console.log(`              → ${f}`);
  console.log(`fan-in      ${direct.length} direct importer(s), ${trans.size} transitive`);
  for (const f of direct) console.log(`              ← ${f}`);

  const reachedApp = [...trans].filter(isApp).map(rel);
  if (reachedApp.length) {
    console.log(`app reach   ${reachedApp.length} untyped app file(s) import this transitively`);
    for (const f of reachedApp) console.log(`              ! ${f}`);
  }

  // Anything exported from here that the untyped half names by string.
  const seam = [];
  for (const name of exps) {
    const { untyped } = textReach(name, true);
    if (untyped.length) seam.push({ name, files: untyped.map((u) => rel(u.file)) });
  }
  if (seam.length) {
    console.log(`\nUNTYPED SEAM — these exports are named in app/ where tsc cannot see them:`);
    for (const s of seam) console.log(`  ${s.name}  →  ${s.files.join(", ")}`);
    console.log(`  Renaming or changing the shape of these will NOT fail the build.`);
  }
  if (rel(abs).startsWith("engine/protocol/")) {
    console.log(
      `\nNOTE: a type-only export can't break app/ by NAME — app/ never imports it.\n` +
        `      It breaks by SHAPE. Trace the actual wire strings instead:\n` +
        `        node .claude/skills/bigboycoding/blast-radius.mjs --frame <frame-type>`,
    );
  }
}

function riskVerdict(direct, trans, path) {
  if (path.startsWith("engine/protocol/")) return "CRITICAL — protocol is the engine↔app contract; app/ is untyped";
  if (trans >= 20) return `HIGH — ${trans} files downstream`;
  if (trans >= 5) return `MEDIUM — ${trans} files downstream`;
  if (direct === 0) return "LOW — nothing imports this (entrypoint, dead code, or dynamically loaded)";
  return `LOW — ${trans} file(s) downstream`;
}

function reportSymbol(name) {
  const { typed, untyped } = textReach(name);
  console.log(bar(`SYMBOL  ${name}`));
  const defs = typed
    .filter(({ file }) => exportsOf(file).includes(name))
    .map(({ file }) => rel(file));
  console.log(`defined in  ${defs.length ? defs.join(", ") : "(no exported definition found)"}`);
  console.log(`\ntyped references — tsc WILL catch a break (${typed.length} file(s))`);
  for (const { file, hits } of typed) {
    console.log(`  ${rel(file)}`);
    for (const h of hits.slice(0, 4)) console.log(`      ${h.line}: ${h.text}`);
    if (hits.length > 4) console.log(`      … ${hits.length - 4} more`);
  }
  console.log(`\nUNTYPED references — tsc will NOT catch a break (${untyped.length} file(s))`);
  if (!untyped.length) console.log("  (none — this symbol does not cross into app/)");
  for (const { file, hits } of untyped) {
    console.log(`  ! ${rel(file)}`);
    for (const h of hits.slice(0, 6)) console.log(`      ${h.line}: ${h.text}`);
    if (hits.length > 6) console.log(`      … ${hits.length - 6} more`);
  }
}

function reportFrame(type) {
  console.log(bar(`FRAME  type: "${type}"`));
  const re = new RegExp(`["'\`]${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
  const producers = [];
  const consumers = [];
  for (const [file, text] of source) {
    if (!re.test(text)) continue;
    text.split("\n").forEach((l, i) => {
      if (!re.test(l)) return;
      const entry = { file: rel(file), line: i + 1, text: l.trim().slice(0, 110) };
      if (/case\s|===|==|\.type\s*[=!]==?|switch/.test(l)) consumers.push(entry);
      else producers.push(entry);
    });
  }
  console.log(`\nemitted / declared (${producers.length})`);
  for (const p of producers) console.log(`  ${p.file}:${p.line}  ${p.text}`);
  console.log(`\nmatched / handled (${consumers.length})`);
  for (const c of consumers) console.log(`  ${isApp(join(ROOT, c.file)) ? "!" : " "} ${c.file}:${c.line}  ${c.text}`);
  const appSide = [...producers, ...consumers].filter((e) => e.file.startsWith("app/"));
  if (appSide.length)
    console.log(`\n${appSide.length} of these live in app/ — untyped. Rename this string and the build still passes.`);
}

function reportEntrypoints() {
  console.log(bar("ENTRYPOINTS & COVERAGE"));
  for (const e of ENTRYPOINTS) {
    const abs = join(ROOT, e);
    const known = source.has(abs);
    console.log(`  ${known ? "ok " : "?? "} ${e}`);
  }
  const eng = allFiles.filter(isEngine).length;
  const app = allFiles.filter(isApp).length;
  console.log(`\n  engine/  ${eng} .ts files   — checked by \`npm run build\` (tsc -b)`);
  console.log(`  app/     ${app} .js/.html files — NOT typechecked by anything`);
  console.log(`\n  regression gates that actually exist:`);
  console.log(`    npm run build                 typecheck engine/* only`);
  console.log(`    npm run test:ui               app/tests/run-ui-tests.js`);
  console.log(`    npm run test:main --workspace app   changes/window/connection/reasoning`);
  console.log(`    npm run test:version          tools/version`);
  console.log(`\n  engine/* has NO unit test suite. tsc is its only automated gate.`);
}

// ── main ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (!argv.length) {
  console.log(`blast-radius — what breaks if I touch this?

  node .claude/skills/bigboycoding/blast-radius.mjs <file> [file...]
  node .claude/skills/bigboycoding/blast-radius.mjs --symbol <Name>
  node .claude/skills/bigboycoding/blast-radius.mjs --frame <frame-type>
  node .claude/skills/bigboycoding/blast-radius.mjs --entrypoints

Indexed ${allFiles.length} files (${engineFiles.length} engine .ts, ${appFiles.length} app, ${toolFiles.length} tools).`);
  process.exit(0);
}

const mode = argv[0];
if (mode === "--entrypoints") reportEntrypoints();
else if (mode === "--symbol") argv.slice(1).forEach(reportSymbol);
else if (mode === "--frame") argv.slice(1).forEach(reportFrame);
else argv.forEach(reportFile);
console.log("");
