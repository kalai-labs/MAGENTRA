#!/usr/bin/env node
// Runs electron-builder for MAGENTRA.
//
// This script used to swap package.json's version for a 3-part prefix, because
// the repo versioned as MAJOR.MINOR.PATCH.BUILD and electron-builder rejects a
// 4-part version. That truncation made two different releases report the same
// version, which is how self-update stayed broken (see
// docs/adr/0008-the-version-is-semver.md). The version is semver now, so the
// swap is gone: electron-builder reads the real version straight from
// package.json, and `${version}` in the artifact names is that same version.
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");

// Workspaces hoist electron to the repo root, where electron-builder cannot
// resolve the "^33.0.0" range on its own — hand it the exact installed version.
const electronVersion = require("electron/package.json").version;

/** The commit this build came from. Traceability lived in the BUILD part of the
 *  version until it became semver; the commit says the same thing and says it
 *  more precisely. Absent from a source tarball with no git metadata, which is
 *  not an error — the build simply carries no commit. */
function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const commit = currentCommit();

// npm puts node_modules/.bin on PATH for script children, so the bare name
// resolves; shell:true covers the .cmd shim on Windows.
// electron-builder turns on GitHub publishing implicitly when it detects CI
// (CI=true). We never want that: the Release workflow uploads the artifacts
// itself with `gh release upload`, and the packaging step carries no
// GH_TOKEN, so the implicit publish throws after a successful build. Force it
// off. A caller who wants publishing can still pass `--publish` explicitly —
// an argv-supplied flag wins over this one.
//
// extraMetadata merges into the packaged package.json without touching the file
// in the working tree, so a build never leaves the repository dirty.
const result = spawnSync(
  "electron-builder",
  [
    "--publish",
    "never",
    ...process.argv.slice(2),
    `-c.electronVersion=${electronVersion}`,
    ...(commit ? [`-c.extraMetadata.magentraCommit=${commit}`] : []),
  ],
  { stdio: "inherit", shell: true },
);

process.exit(result.status ?? 1);
