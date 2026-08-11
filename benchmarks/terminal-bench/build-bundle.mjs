#!/usr/bin/env node
// Builds the Linux-ready MAGENTRA bundle the Terminal-Bench adapter uploads
// into task containers:
//
//   bundle/engine.cjs    the UNMODIFIED engine host, bundled to one CJS file
//                        with the SAME recipe app/scripts/bundle-engine.js
//                        ships (same entry, same ripgrep shim alias) — only
//                        minification is off, so container stack traces stay
//                        readable;
//   bundle/rg            ripgrep for linux-x64, pinned to the version the
//                        engine's @vscode/ripgrep dependency resolves to;
//   bundle/driver.mjs    the NDJSON driver (this directory's copy);
//   bundle/version.json  provenance: MAGENTRA version + git sha + build time.
//
// Run from anywhere: node bench/terminal-bench/build-bundle.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const ENTRY = join(REPO_ROOT, "engine", "host", "dist", "main.js");
const RIPGREP_SHIM = join(REPO_ROOT, "app", "shims", "ripgrep-shim.cjs");
const OUT_DIR = join(HERE, "bundle");

if (!existsSync(ENTRY)) {
  console.error(`Engine not built: ${ENTRY} is missing. Run \`npm run build\` at the repo root first.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [ENTRY],
  outfile: join(OUT_DIR, "engine.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: false,
  legalComments: "none",
  sourcemap: false,
  // Same swap bundle-engine.js makes: @vscode/ripgrep resolves its binary via
  // import.meta, which cannot survive a single-file CJS bundle. The shim finds
  // `rg` beside the bundle instead.
  alias: { "@vscode/ripgrep": RIPGREP_SHIM },
  logLevel: "info",
});

// ripgrep for the Linux container, pinned to the engine's own resolved version.
const rgVersion = JSON.parse(
  readFileSync(join(REPO_ROOT, "node_modules", "@vscode", "ripgrep", "package.json"), "utf8"),
).version;
const tmp = mkdtempSync(join(tmpdir(), "magentra-rg-"));
try {
  const tgz = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", `@vscode/ripgrep-linux-x64@${rgVersion}`, "--pack-destination", tmp],
    { encoding: "utf8", shell: process.platform === "win32" },
  ).trim().split("\n").pop().trim();
  // cwd + bare filename, never an absolute path: GNU tar (the one Git for
  // Windows puts on PATH) reads the drive letter in "C:\..." as a REMOTE HOST
  // and dies with "Cannot connect to C: resolve failed". --force-local fixes
  // that for GNU tar but is rejected by the bsdtar in System32, and which of
  // the two answers to `tar` depends on the shell. Keeping every argument
  // colon-free is the one form both accept.
  execFileSync("tar", ["-xzf", tgz], { cwd: tmp });
  copyFileSync(join(tmp, "package", "bin", "rg"), join(OUT_DIR, "rg"));
  console.log(`Copied ripgrep ${rgVersion} (linux-x64) -> bundle/rg`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

copyFileSync(join(HERE, "driver.mjs"), join(OUT_DIR, "driver.mjs"));

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
let sha = "unknown";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
} catch {
  /* not a git checkout — provenance stays partial */
}
writeFileSync(
  join(OUT_DIR, "version.json"),
  JSON.stringify({ version: pkg.version, sha, builtAt: new Date().toISOString() }, null, 2) + "\n",
);

console.log(`Bundle ready: ${OUT_DIR} (MAGENTRA ${pkg.version} @ ${sha})`);
