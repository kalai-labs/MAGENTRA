#!/usr/bin/env node
// Runs electron-builder with MAGENTRA's 4-part version made palatable.
//
// The repo versions as MAJOR.MINOR.PATCH.BUILD (see VERSIONING.md), which
// electron-builder rejects ("Invalid version" — it validates package.json
// against semver before any config override applies). So for the duration of
// the build this script swaps package.json's version for its semver prefix,
// restoring the original afterwards, and:
//   - artifact names carry the REAL 4-part version via ${env.MAGENTRA_VERSION}
//     (two releases differing only in BUILD must not collide),
//   - the swapped package.json carries `magentraVersion` (the 4-part), which
//     the packaged main.js prefers over app.getVersion().
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const pkgPath = path.join(__dirname, "..", "package.json");
const original = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original);
const version = pkg.version;
const semver = version.split(".").slice(0, 3).join(".");

pkg.version = semver;
pkg.magentraVersion = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Workspaces hoist electron to the repo root, where electron-builder cannot
// resolve the "^33.0.0" range on its own — hand it the exact installed version.
const electronVersion = require("electron/package.json").version;

let status = 1;
try {
  // npm puts node_modules/.bin on PATH for script children, so the bare name
  // resolves; shell:true covers the .cmd shim on Windows.
  const result = spawnSync(
    "electron-builder",
    [...process.argv.slice(2), `-c.electronVersion=${electronVersion}`],
    {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, MAGENTRA_VERSION: version },
    },
  );
  status = result.status ?? 1;
} finally {
  fs.writeFileSync(pkgPath, original);
}
process.exit(status);
