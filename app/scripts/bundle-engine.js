#!/usr/bin/env node
// Packs everything the shipped app needs that is not already a plain asset:
//
//   1. the engine  — engine/host is bundled into ONE CommonJS file that Electron
//      can spawn via process.execPath + ELECTRON_RUN_AS_NODE=1, with no
//      node_modules on disk at runtime;
//   2. ripgrep     — the Grep tool shells out to a real rg binary, so the right
//      one per OS is copied in beside the bundle;
//   3. the app     — main/preload/renderer are minified into build-resources/app,
//      which is what the packaged artifact ships (dev keeps the readable sources).
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const APP_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(APP_DIR, "..");

const ENTRY = path.join(REPO_ROOT, "engine", "host", "dist", "main.js");
const OUT_DIR = path.join(APP_DIR, "build-resources", "engine");
const OUT_FILE = path.join(OUT_DIR, "engine.cjs");
const RIPGREP_SHIM = path.join(APP_DIR, "shims", "ripgrep-shim.cjs");

// The composer's "attach context" file picker reads files in the Electron main
// process, and reuses the engine's own dependency-free document extractor
// (PDF/DOCX/…) rather than reimplementing it. That extractor is engine ESM, so
// it ships to packaged builds as this standalone bundle next to engine.cjs.
// (In development main.js imports engine/core/dist directly — no bundle needed.)
const DOC_EXTRACT_ENTRY = path.join(REPO_ROOT, "engine", "core", "src", "knowledge", "docs.ts");
const DOC_EXTRACT_OUT = path.join(OUT_DIR, "doc-extract.mjs");

// The binaries come from the @vscode/ripgrep platform packages in node_modules.
// Packaging filters (build.win / build.linux / build.mac) pick rg.exe vs rg per
// artifact. `--target win|linux|mac` (repeatable) names the OS(es) this run is
// packaging for: a missing rg for a *target* OS fails the build — shipping an
// artifact whose Grep tool is broken must never happen silently — while other
// OSes' binaries stay optional so one machine can stage several.
const RIPGREP = [
  { target: "win", src: path.join(REPO_ROOT, "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe"), dest: "rg.exe" },
  { target: "linux", src: path.join(REPO_ROOT, "node_modules", "@vscode", "ripgrep-linux-x64", "bin", "rg"), dest: "rg" },
  // Mac artifacts are built per-arch on a matching runner; the darwin package
  // npm installed there matches process.arch. Same "rg" dest as linux — the
  // two are never staged on the same machine for the same artifact.
  { target: "mac", src: path.join(REPO_ROOT, "node_modules", "@vscode", `ripgrep-darwin-${process.arch}`, "bin", "rg"), dest: "rg" },
];

function parseTargets(argv) {
  const targets = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") {
      const value = argv[++i];
      if (!["win", "linux", "mac"].includes(value)) {
        throw new Error(`--target expects win|linux|mac, got "${value}"`);
      }
      targets.add(value);
    }
  }
  return targets;
}

async function main() {
  const targets = parseTargets(process.argv.slice(2));
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`Engine not built: ${ENTRY} is missing. Run \`npm run build\` at the repo root first.`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // The engine is the product's core: strip comments, mangle names, collapse
    // whitespace, so the shipped bundle is not casually readable.
    minify: true,
    legalComments: "none",
    sourcemap: false,
    // @vscode/ripgrep is pure ESM and resolves its native binary at runtime via
    // createRequire(import.meta.url), which does not survive a single-file CJS
    // bundle. Swap in a plain-CJS shim pointing at the rg copied in below.
    alias: { "@vscode/ripgrep": RIPGREP_SHIM },
    logLevel: "info",
  });

  // Standalone document extractor for the desktop shell's attach-context picker.
  await esbuild.build({
    entryPoints: [DOC_EXTRACT_ENTRY],
    outfile: DOC_EXTRACT_OUT,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });

  for (const { target: rgTarget, src, dest } of RIPGREP) {
    const outPath = path.join(OUT_DIR, dest);
    if (!fs.existsSync(src)) {
      if (targets.has(rgTarget)) {
        throw new Error(
          `ripgrep for target "${rgTarget}" not found at ${src} — refusing to package an artifact with a broken Grep tool. ` +
            (rgTarget === "win" ? "Run \`npm run fetch:rg-win\` at the repo root first." : "Run \`npm ci\` on a matching machine."),
        );
      }
      console.warn(`WARN: ripgrep not found at ${src} — artifacts for that OS will lack the Grep tool.`);
      continue;
    }
    fs.copyFileSync(src, outPath);
    fs.chmodSync(outPath, 0o755);
    console.log(`Copied ripgrep -> ${path.relative(REPO_ROOT, outPath)}`);
  }

  // The packaged app ships minified copies; development keeps the sources.
  const APP_OUT = path.join(APP_DIR, "build-resources", "app");
  fs.rmSync(APP_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(APP_OUT, "renderer", "modules"), { recursive: true });
  fs.mkdirSync(path.join(APP_OUT, "main"), { recursive: true });

  const rendererModules = fs
    .readdirSync(path.join(APP_DIR, "renderer", "modules"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(APP_DIR, "renderer", "modules", f));

  // bundle:false — every file is minified in place. The renderer modules share
  // one global scope and rely on the load order index.html lists, so they must
  // stay separate files rather than being bundled together.
  await esbuild.build({
    entryPoints: [path.join(APP_DIR, "main.js"), path.join(APP_DIR, "preload.js")],
    outdir: APP_OUT,
    bundle: false,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  // Every module in app/main/ ships — a hardcoded list here once dropped
  // main/changes.js from the package, crashing packaged builds at require
  // time ("Cannot find module './main/changes.js'") while dev runs, which use
  // the source tree, kept working.
  const mainModules = fs
    .readdirSync(path.join(APP_DIR, "main"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(APP_DIR, "main", f));
  await esbuild.build({
    entryPoints: mainModules,
    outdir: path.join(APP_OUT, "main"),
    bundle: false,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });

  await esbuild.build({
    entryPoints: rendererModules,
    outdir: path.join(APP_OUT, "renderer", "modules"),
    bundle: false,
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  await esbuild.build({
    entryPoints: [path.join(APP_DIR, "renderer", "styles.css")],
    outdir: path.join(APP_OUT, "renderer"),
    bundle: false,
    minify: true,
    legalComments: "none",
    sourcemap: false,
  });
  fs.copyFileSync(
    path.join(APP_DIR, "renderer", "index.html"),
    path.join(APP_OUT, "renderer", "index.html"),
  );
  // Bundled UI fonts ship as-is (woff2 is already compressed).
  fs.cpSync(path.join(APP_DIR, "renderer", "fonts"), path.join(APP_OUT, "renderer", "fonts"), {
    recursive: true,
  });

  console.log(`Bundled engine -> ${path.relative(REPO_ROOT, OUT_FILE)}`);
  console.log(`Minified app  -> ${path.relative(REPO_ROOT, APP_OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
