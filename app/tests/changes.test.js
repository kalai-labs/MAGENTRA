"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveWorkspaceFile, diffTargetsOnly, undoWorkspaceDiffs } = require("../main/changes.js");

async function main() {
  // Keep the fixture inside the workspace: Codex/CI sandboxes commonly mount
  // the host temp directory read-only for child processes such as git.
  const fixtureRoot = path.join(__dirname, ".tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(fixtureRoot, "changes-"));
  try {
    const file = path.join(workspace, "app.js");
    fs.writeFileSync(file, "const theme = 'old';\n", "utf8");
    const git = (args, encoding) => {
      const result = spawnSync("git", args, { cwd: workspace, encoding: encoding || "utf8" });
      // Managed sandboxes can attach an EPERM marker even when the child exits
      // successfully; the exit status and stderr remain the reliable result.
      if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} exited ${result.status}`);
      return result.stdout || "";
    };
    git(["init", "-q"]);
    git(["add", "app.js"]);
    git(["-c", "user.name=Magentra Tests", "-c", "user.email=tests@example.invalid", "commit", "-qm", "baseline"]);
    fs.writeFileSync(file, "const theme = 'workbench';\n", "utf8");
    const diff = git(["diff", "--", "app.js"], "utf8");
    const secondDiff = [
      "diff --git a/app.js b/app.js",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1 +1 @@",
      "-const theme = 'workbench';",
      "+const theme = 'refined';",
      "",
    ].join("\n");
    fs.writeFileSync(file, "const theme = 'refined';\n", "utf8");

    assert.equal(resolveWorkspaceFile(workspace, "app.js"), file);
    assert.equal(resolveWorkspaceFile(workspace, "../outside.js", false), null);
    assert.equal(diffTargetsOnly(diff, "app.js"), true);
    assert.equal(diffTargetsOnly(diff, "other.js"), false);
    assert.deepEqual(await undoWorkspaceDiffs(workspace, "../outside.js", [diff]), {
      ok: false,
      error: "invalid undo request",
    });
    assert.deepEqual(await undoWorkspaceDiffs(workspace, "app.js", [diff, secondDiff]), { ok: true });
    assert.equal(fs.readFileSync(file, "utf8"), "const theme = 'old';\n");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  process.stdout.write("✓ validated path containment, diff/file binding, and a real reverse patch\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
