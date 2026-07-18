"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** Resolve a renderer-supplied relative file without leaving the workspace.
 * Existing symlinks are resolved too, preventing arbitrary-path launches. */
function resolveWorkspaceFile(workspace, relPath, mustExist = true) {
  if (!workspace || typeof relPath !== "string" || !relPath || relPath.length > 4096 || relPath.includes("\0")) {
    return null;
  }
  const root = path.resolve(workspace);
  const target = path.resolve(root, relPath);
  if (target === root || !target.startsWith(root + path.sep)) return null;
  if (mustExist && !fs.existsSync(target)) return null;
  if (fs.existsSync(target)) {
    try {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
    } catch {
      return null;
    }
  }
  return target;
}

function diffTargetsOnly(diff, relPath) {
  const normalizedExpected = relPath.replaceAll("\\", "/");
  const headers = String(diff)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("--- ") || line.startsWith("+++ "))
    .map((line) => line.slice(4).split("\t")[0].trim())
    .filter((value) => value !== "/dev/null")
    .map((value) => value.replace(/^[ab]\//, ""));
  return headers.length >= 1 && headers.every((value) => value === normalizedExpected);
}

function applyWorkspaceDiff(workspace, diff, reverse) {
  return new Promise((resolve) => {
    const args = ["apply", ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn", "-"];
    const child = spawn("git", args, {
      cwd: workspace,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, error: "git apply timed out" });
    }, 15000);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on("error", (error) => settle({ ok: false, error: error.message }));
    child.on("close", (code) => {
      settle(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git apply exited ${code}` });
    });
    child.stdin.end(diff);
  });
}

function reverseApplyDiff(workspace, diff) {
  return applyWorkspaceDiff(workspace, diff, true);
}

async function undoWorkspaceDiffs(workspace, relPath, diffs) {
  const target = resolveWorkspaceFile(workspace, relPath, false);
  if (!target || !Array.isArray(diffs) || diffs.length < 1 || diffs.length > 100) {
    return { ok: false, error: "invalid undo request" };
  }
  if (diffs.some((diff) => typeof diff !== "string" || diff.length > 2_000_000 || !diffTargetsOnly(diff, relPath))) {
    return { ok: false, error: "diff does not match the selected workspace file" };
  }
  const reversed = [];
  for (let index = diffs.length - 1; index >= 0; index--) {
    const result = await reverseApplyDiff(workspace, diffs[index]);
    if (!result.ok) {
      // Restore any newer edits already reversed before reporting failure, so
      // Undo is all-or-nothing even when an older hunk no longer matches.
      for (let rollback = reversed.length - 1; rollback >= 0; rollback--) {
        const restored = await applyWorkspaceDiff(workspace, reversed[rollback], false);
        if (!restored.ok) {
          return { ok: false, error: `${result.error}; rollback also failed: ${restored.error}` };
        }
      }
      return result;
    }
    reversed.push(diffs[index]);
  }
  return { ok: true };
}

module.exports = { resolveWorkspaceFile, diffTargetsOnly, reverseApplyDiff, undoWorkspaceDiffs };
