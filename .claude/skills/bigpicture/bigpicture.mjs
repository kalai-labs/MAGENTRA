#!/usr/bin/env node
// bigpicture — the repo's structural map, and the freshness contract for
// BIG-PICTURE.pdf.
//
//   node .claude/skills/bigpicture/bigpicture.mjs <command>
//
//     map                 regenerate docs/big-picture/MAP.md from the code
//     check               which BIG-PICTURE sections are stale vs the code
//     impact <file...>    which sections document these files, + hub warning
//     sync [--section N]  re-record hashes after updating the doc
//     render              rebuild BIG-PICTURE.pdf from its HTML source
//
// WHY IT IMPORTS FROM engine/core/dist/
// This repo already carries three file scanners: engine/core/src/knowledge/
// graph.ts, .../symbols.ts, and .claude/skills/bigboycoding/blast-radius.mjs.
// A fourth would be the exact software entropy this tool exists to reduce, so
// the map is built from the engine's OWN index — the same one GraphQuery serves
// the agent at runtime, so the map and the agent's live view cannot disagree.
//
// The cost is a dependency on engine/core/dist/ being current. That is the trap
// documented in BIG-PICTURE §15 (npm run app never builds), so this script
// checks dist freshness itself and refuses to emit a stale map.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const DOCDIR = join(ROOT, "docs", "big-picture");
const COVERAGE = join(DOCDIR, "coverage.json");
const MAPFILE = join(DOCDIR, "MAP.md");

const rel = (p) => relative(ROOT, p).split(sep).join("/");

// ---------------------------------------------------------------------------
// dist freshness — the guard that this whole script's honesty rests on
// ---------------------------------------------------------------------------

/**
 * Refuse to build a map from stale compiler output — BIG-PICTURE §15's trap
 * (`npm run app` never builds) turned into a guardrail.
 *
 * Asks TypeScript, rather than comparing mtimes. Two mtime schemes were tried
 * and both were wrong:
 *
 *   newest .ts vs ONE dist file — `tsc -b` is incremental, so a file whose
 *   source did not change is never re-emitted and keeps its old mtime. This
 *   reported a 53-hour-stale build seconds after a successful one.
 *
 *   newest .ts vs newest .js — `git checkout` / `stash` / a branch switch
 *   rewrites source mtimes with identical content, so the guard fired on a
 *   clean tree and `npm run build` could not clear it: tsc correctly saw no
 *   content change and emitted nothing, leaving dist mtimes old forever.
 *
 * `tsc -b --dry` consults the same .tsbuildinfo content hashes the real build
 * uses, so it agrees with `npm run build` by construction. Costs ~2s.
 */
function distStaleness() {
  const distEntry = join(ROOT, "engine", "core", "dist", "knowledge", "graph.js");
  if (!existsSync(distEntry)) {
    return "engine/core/dist is missing entirely — run `npm run build` first.";
  }
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) return null; // no compiler to ask; trust what is on disk
  let out;
  try {
    out = execFileSync(process.execPath, [tsc, "-b", "--dry"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const behind = [...out.matchAll(/would build project '([^']+)'/g)].map((m) =>
    rel(m[1]).replace(/\/tsconfig\.json$/, ""),
  );
  if (behind.length) {
    return `${behind.join(", ")} ${behind.length === 1 ? "is" : "are"} not compiled — run \`npm run build\` first.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The index — the engine's own graph + symbols, plus a member layer
// ---------------------------------------------------------------------------

async function loadIndex() {
  const stale = distStaleness();
  if (stale) {
    console.error(`!! ${stale}`);
    console.error("   The map would describe code that is no longer there.");
    process.exit(2);
  }
  const graphMod = await import(pathToFileURL(join(ROOT, "engine/core/dist/knowledge/graph.js")).href);
  const symMod = await import(pathToFileURL(join(ROOT, "engine/core/dist/knowledge/symbols.js")).href);
  const graph = graphMod.buildGraph(ROOT);
  const symbols = symMod.buildSymbolIndex(ROOT);
  return { graph, symbols };
}

/**
 * Members worth naming: top-level functions, exported consts, and — only for a
 * file that actually declares a class — its 2-space-indented members.
 *
 * The class rule is gated because app/renderer/* are classic scripts full of
 * nested closures at exactly that indent; ungated it reported `renderPaneQueue`
 * three times from three different enclosing functions.
 */
function extractMembers(src) {
  const lines = src.split(/\r?\n/);
  const hasClass = /^(?:export\s+)?(?:abstract\s+)?class\s/m.test(src);
  const out = [];
  const seen = new Set();
  const push = (name, line) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, line });
  };
  const RESERVED = /^(if|for|while|switch|catch|return|constructor|typeof|new|await|else|do|try)$/;

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(L);
    if (m) { push(m[1], i + 1); continue; }
    m = /^export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(L);
    if (m) { push(m[1], i + 1); continue; }
    if (hasClass) {
      m = /^ {2}(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(<]/.exec(L);
      if (m && !RESERVED.test(m[1])) push(m[1], i + 1);
    }
  }
  return out;
}

/**
 * A file's local imports — workspace-relative ids only, externals dropped.
 *
 * This used to re-scan for multi-line imports and re-map `@magentra/*` itself,
 * because engine/core/src/knowledge/graph.ts saw neither. Both were fixed in
 * graph.ts (graph version 2) and verified to produce byte-identical edges, so
 * the workaround is gone: one scanner, one answer.
 */
function localImports(graph, f) {
  return [...new Set((graph.files[f]?.imports || []).filter((i) => !i.startsWith("pkg:") && graph.files[i] && i !== f))];
}

function fanIn(graph) {
  const inbound = new Map();
  for (const f of Object.keys(graph.files)) inbound.set(f, []);
  for (const f of Object.keys(graph.files)) {
    for (const imp of localImports(graph, f)) inbound.get(imp).push(f);
  }
  return inbound;
}

function transitiveFanIn(file, inbound) {
  const seen = new Set();
  const stack = [...(inbound.get(file) || [])];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const up of inbound.get(f) || []) if (!seen.has(up)) stack.push(up);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

const TIER_A = 22; // files that get full detail

async function cmdMap() {
  const { graph, symbols } = await loadIndex();
  const files = Object.keys(graph.files).sort();
  const inbound = fanIn(graph);

  const rows = files.map((f) => {
    const sym = symbols.files[f];
    const src = existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "";
    const loc = src ? src.split(/\r?\n/).length : 0;
    const direct = inbound.get(f) || [];
    const imports = localImports(graph, f);
    return {
      f,
      loc,
      imports,
      direct,
      transitive: transitiveFanIn(f, inbound).size,
      exports: sym?.symbols ?? [],
      members: extractMembers(src),
    };
  });

  /**
   * Hub score — what a code-writing model needs spelled out, which is not the
   * same as "most depended upon".
   *
   * Ranking by fan-in alone put engine/core/src/util/fsAtomic.ts (35 lines, one
   * export) at #1 and left session.ts (2801 lines, where the agent's entire
   * behaviour lives) out of the list entirely. Leaf utilities always win a
   * pure-fan-in race, and they are the files you least need a member index for.
   *
   * So: reach (who breaks if this changes) + coordination (how much this file
   * pulls together) + size (where the logic actually is). Test files are
   * excluded — app/tests/ui.e2e.js is 1877 lines and scores well, but nobody
   * orients themselves by reading it.
   */
  const score = (r) => r.loc / 50 + r.transitive * 1.5 + r.imports.length * 1.5;
  const isTest = (f) => /(^|\/)tests?\//.test(f) || /\.test\.|\.e2e\./.test(f);
  const ranked = [...rows].filter((r) => !isTest(r.f)).sort((a, b) => score(b) - score(a) || b.loc - a.loc);

  /**
   * app/ gets a reserved quota rather than competing on score.
   *
   * Renderer modules are classic scripts sharing one global scope and main.js is
   * CommonJS, so almost nothing under app/ carries an import edge the graph can
   * see. On a purely edge-weighted score the whole desktop half ranks zero and
   * the hub list came back 22/22 engine files — hiding precisely the half that
   * `tsc -b` does not check, which is the seam this repo breaks at.
   */
  const APP_QUOTA = 7;
  const appHubs = ranked.filter((r) => r.f.startsWith("app/")).slice(0, APP_QUOTA);
  const appSet = new Set(appHubs.map((r) => r.f));
  const rest = ranked.filter((r) => !appSet.has(r.f)).slice(0, TIER_A - appHubs.length);
  const hubs = [...rest, ...appHubs].sort((a, b) => score(b) - score(a) || b.loc - a.loc);
  const hubSet = new Set(hubs.map((r) => r.f));

  const engineCount = files.filter((f) => f.startsWith("engine/")).length;
  const appCount = files.filter((f) => f.startsWith("app/")).length;

  const L = [];
  L.push("# MAGENTRA — Structure Map");
  L.push("");
  L.push("<!-- GENERATED by .claude/skills/bigpicture/bigpicture.mjs map — do not hand-edit. -->");
  L.push("");
  L.push(
    "A compact skeleton of every scanned file: exports, members with line numbers, and",
    "import edges. Built from the engine's OWN index (`engine/core/src/knowledge/`), the",
    "same one `GraphQuery` serves at runtime — so this file and the agent's live view",
    "cannot drift apart.",
  );
  L.push("");
  L.push("**Read this to find where something already lives before writing a second one.**");
  L.push("Narrative and rationale are in `BIG-PICTURE.pdf`; this is the index.");
  L.push("");
  L.push(`- files scanned **${files.length}** — engine ${engineCount}, app ${appCount}, other ${files.length - engineCount - appCount}`);
  L.push(`- \`app/\` is typechecked by **nothing**; \`tsc -b\` covers \`engine/*\` only.`);
  L.push("");
  L.push("---");
  L.push("");
  L.push(`## Hubs — the ${TIER_A} files with the widest reach`);
  L.push("");
  L.push("Changing one of these reaches the whole system. `↓N` = transitive importers.");
  L.push("");

  for (const r of hubs) {
    L.push(`### \`${r.f}\``);
    const bits = [`${r.loc}L`, `↓${r.transitive} transitive`, `←${r.direct.length} direct`];
    L.push(`*${bits.join(" · ")}*`);
    L.push("");
    if (r.exports.length) L.push(`**exports** ${r.exports.map((s) => `\`${s}\``).join(" ")}`);
    if (r.members.length) {
      const shown = r.members.slice(0, 40).map((m) => `${m.name}:${m.line}`).join(" ");
      const more = r.members.length > 40 ? ` …+${r.members.length - 40}` : "";
      L.push(`**members** \`${shown}\`${more}`);
    }
    if (r.direct.length) {
      L.push(`**imported by** ${r.direct.slice(0, 8).map((d) => `\`${d}\``).join(" ")}${r.direct.length > 8 ? ` …+${r.direct.length - 8}` : ""}`);
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("## Every file");
  L.push("");
  L.push("`path · lines · ↓transitive` then exported symbols. Grep this section for a name");
  L.push("before adding one.");
  L.push("");

  let group = "";
  for (const r of rows.sort((a, b) => a.f.localeCompare(b.f))) {
    const g = r.f.split("/").slice(0, 3).join("/");
    if (g !== group) {
      group = g;
      L.push("");
      L.push(`**${group}/**`);
      L.push("");
    }
    const star = hubSet.has(r.f) ? " ⬢" : "";
    const ex = r.exports.length ? ` — ${r.exports.slice(0, 10).join(", ")}${r.exports.length > 10 ? ", …" : ""}` : "";
    L.push(`- \`${r.f.slice(group.length + 1)}\`${star} · ${r.loc}L · ↓${r.transitive}${ex}`);
  }

  L.push("");
  L.push("---");
  L.push("");
  L.push("*⬢ = hub. Regenerate with `node .claude/skills/bigpicture/bigpicture.mjs map`.*");

  writeFileSync(MAPFILE, L.join("\n") + "\n", "utf8");
  console.log(`wrote ${rel(MAPFILE)}`);
  console.log(`  ${files.length} files · ${TIER_A} hubs detailed · ${L.length} lines`);
}

// ---------------------------------------------------------------------------
// coverage / check / sync — the freshness contract
// ---------------------------------------------------------------------------

function loadCoverage() {
  if (!existsSync(COVERAGE)) {
    console.error(`!! ${rel(COVERAGE)} missing — cannot check freshness.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(COVERAGE, "utf8"));
}

/** Expand a coverage entry's path patterns to real files. Supports a trailing
 *  `/**` for a whole subtree and a leading `*.ext` filter after it. */
function expand(patterns) {
  const out = new Set();
  for (const pat of patterns) {
    if (!pat.includes("*")) {
      if (existsSync(join(ROOT, pat))) out.add(pat);
      continue;
    }
    const [base, tail] = pat.split("/**");
    const extFilter = tail && tail.startsWith("/*.") ? tail.slice(2) : null;
    const walk = (d) => {
      let entries;
      try {
        entries = readdirSync(join(ROOT, d), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (!extFilter || e.name.endsWith(extFilter.slice(1))) out.add(p);
      }
    };
    walk(base);
  }
  return [...out].sort();
}

function hashFiles(files) {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    try {
      h.update(readFileSync(join(ROOT, f)));
    } catch {
      h.update("MISSING");
    }
  }
  return h.digest("hex").slice(0, 16);
}

function cmdCheck() {
  const cov = loadCoverage();
  const stale = [];
  const ok = [];
  for (const s of cov.sections) {
    const files = expand(s.paths);
    const now = hashFiles(files);
    if (now !== s.hash) stale.push({ ...s, files, now });
    else ok.push(s);
  }

  console.log(`BIG-PICTURE freshness — ${cov.sections.length} sections tracked`);
  console.log(`  recorded against: ${cov.recordedAt}`);
  console.log("");

  if (stale.length === 0) {
    console.log("✓ every tracked section matches the code it documents.");
    return 0;
  }

  console.log(`${stale.length} section(s) document code that has changed:`);
  console.log("");
  for (const s of stale) {
    console.log(`  §${s.id}  ${s.title}`);
    console.log(`      backed by: ${s.paths.join(", ")}`);
    const changed = s.files.filter((f) => {
      const one = hashFiles([f]);
      const prev = (s.fileHashes || {})[f];
      return prev === undefined || prev !== one;
    });
    if (changed.length && changed.length <= 12) {
      for (const c of changed) console.log(`      changed:   ${c}`);
    } else if (changed.length) {
      console.log(`      changed:   ${changed.length} files`);
    }
    console.log("");
  }
  console.log("Next: re-read those sections in docs/big-picture/big-picture.html,");
  console.log("update what is now wrong, then:");
  console.log("  node .claude/skills/bigpicture/bigpicture.mjs render");
  console.log("  node .claude/skills/bigpicture/bigpicture.mjs sync");
  return 1;
}

function cmdSync(only) {
  const cov = loadCoverage();
  let touched = 0;
  for (const s of cov.sections) {
    if (only && String(s.id) !== String(only)) continue;
    const files = expand(s.paths);
    const fileHashes = {};
    for (const f of files) fileHashes[f] = hashFiles([f]);
    const next = hashFiles(files);
    if (next !== s.hash) touched++;
    s.hash = next;
    s.fileHashes = fileHashes;
  }
  cov.recordedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(COVERAGE, JSON.stringify(cov, null, 2) + "\n", "utf8");
  console.log(`sync: ${touched} section(s) re-recorded, ${cov.sections.length} tracked (${cov.recordedAt})`);
}

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

async function cmdImpact(targets) {
  const cov = loadCoverage();
  const { graph, symbols } = await loadIndex();
  const inbound = fanIn(graph);

  for (const t of targets) {
    const f = t.split(sep).join("/").replace(/^\.\//, "");
    console.log(`FILE  ${f}`);
    if (!graph.files[f]) {
      console.log("  !! not in the scanned graph — typo, or you pointed at dist/.");
      console.log("");
      continue;
    }
    const trans = transitiveFanIn(f, inbound);
    const direct = inbound.get(f) || [];
    const appReach = [...trans].filter((x) => x.startsWith("app/"));
    console.log(`  reach       ${direct.length} direct · ${trans.size} transitive importers`);
    const sym = symbols.files[f];
    if (sym?.symbols?.length) console.log(`  exports     ${sym.symbols.join(", ")}`);
    if (appReach.length) {
      console.log(`  !! app reach ${appReach.length} untyped app/ file(s) downstream — tsc will not protect you`);
    }
    // Renderer modules are classic scripts with no import edges, so graph reach
    // can never find them. A protocol change reaches app/ through bare frame
    // STRINGS instead, which only a text scan sees.
    if (f.startsWith("engine/protocol/")) {
      console.log("  !! wire seam  app/ consumes this by frame STRING, not by import —");
      console.log("                graph reach cannot see it. For each frame you touch:");
      console.log("                node .claude/skills/bigboycoding/blast-radius.mjs --frame <type>");
    }

    const owning = cov.sections.filter((s) => expand(s.paths).includes(f));
    if (owning.length) {
      console.log("  documented in BIG-PICTURE:");
      for (const s of owning) console.log(`      §${s.id}  ${s.title}`);
      console.log("      → if your change alters what those sections claim, update them.");
    } else {
      console.log("  documented in BIG-PICTURE: (no section tracks this file)");
    }
    console.log("");
  }
  console.log("Blast-radius detail (importers, symbol + frame seams):");
  console.log(`  node .claude/skills/bigboycoding/blast-radius.mjs ${targets.join(" ")}`);
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function cmdRender() {
  const script = join(ROOT, "docs", "big-picture", "render.mjs");
  if (!existsSync(script)) {
    console.error(`!! ${rel(script)} missing`);
    process.exit(2);
  }
  // Resolve electron's real binary rather than shelling out to npx: Node 20+
  // refuses to spawnSync a Windows `.cmd` without `shell: true`
  // (CVE-2024-27980), so `npx.cmd` dies with EINVAL. The electron package
  // exports its executable path as a plain string.
  let electronPath;
  try {
    electronPath = createRequire(join(ROOT, "package.json"))("electron");
  } catch {
    console.error("!! electron is not installed — run `npm install` first.");
    process.exit(2);
  }
  execFileSync(electronPath, ["docs/big-picture/render.mjs"], { cwd: ROOT, stdio: "inherit" });
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "map":
    await cmdMap();
    break;
  case "check":
    process.exitCode = cmdCheck();
    break;
  case "sync": {
    const i = rest.indexOf("--section");
    cmdSync(i >= 0 ? rest[i + 1] : null);
    break;
  }
  case "impact":
    if (rest.length === 0) {
      console.error("usage: bigpicture.mjs impact <file> [file...]");
      process.exit(2);
    }
    await cmdImpact(rest);
    break;
  case "render":
    cmdRender();
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 2 : 0);
}
