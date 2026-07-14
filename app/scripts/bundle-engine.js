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

// Both binaries come from the @vscode/ripgrep platform packages in node_modules.
// Packaging filters (build.win / build.linux) pick rg.exe vs rg per artifact, so
// one machine can produce both as long as both packages are installed.
const RIPGREP = [
  { src: path.join(REPO_ROOT, "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe"), dest: "rg.exe" },
  { src: path.join(REPO_ROOT, "node_modules", "@vscode", "ripgrep-linux-x64", "bin", "rg"), dest: "rg" },
];

async function main() {
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

  for (const { src, dest } of RIPGREP) {
    const target = path.join(OUT_DIR, dest);
    if (!fs.existsSync(src)) {
      console.warn(`WARN: ripgrep not found at ${src} — artifacts for that OS will lack the Grep tool.`);
      continue;
    }
    fs.copyFileSync(src, target);
    fs.chmodSync(target, 0o755);
    console.log(`Copied ripgrep -> ${path.relative(REPO_ROOT, target)}`);
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
  await esbuild.build({
    entryPoints: [path.join(APP_DIR, "main", "config.js"), path.join(APP_DIR, "main", "logging.js")],
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

  console.log(`Bundled engine -> ${path.relative(REPO_ROOT, OUT_FILE)}`);
  console.log(`Minified app  -> ${path.relative(REPO_ROOT, APP_OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
