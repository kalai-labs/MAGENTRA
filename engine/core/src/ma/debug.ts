import { execFileSync } from "node:child_process";

/**
 * Support for the /debug reproduce-first debugging mode (the debug skill). The mode
 * runs a repro-oracle loop: the model writes a self-checking repro script here,
 * observes it fail (which unlocks editing), then iterates until the same script
 * passes. This module names the script location and builds the one-shot context
 * header the /debug command prepends to the user's bug report.
 */

/** Workspace-relative directory the model owns for the debug repro script (always writable while the debug skill is active). */
export const DEBUG_DIR = ".magentra/debug";

/** Workspace-relative path of the repro script — a PowerShell script on Windows, a shell script elsewhere. */
export function reproScriptRelPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".magentra/debug/repro.ps1" : ".magentra/debug/repro.sh";
}

/**
 * A compact (~150 token), deterministic context header for a debug turn:
 * platform + shell, the git branch with its uncommitted-file count, the last
 * five commit subjects, and the repro script path. It orients a weak model in
 * the workspace before it starts the repro loop. Never throws — a non-git
 * workspace simply omits the git lines. Prepended to the user's bug report by
 * the /debug command.
 */
export function buildDebugHeader(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const shell = platform === "win32" ? "powershell" : "bash";
  const lines: string[] = ["[debug context]", `Platform: ${platform} (shell: ${shell})`];

  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== undefined) {
    const status = runGit(cwd, ["status", "--porcelain"]);
    const dirty = status ? status.split("\n").filter((l) => l.trim().length > 0).length : 0;
    lines.push(`Git branch: ${branch} (${dirty} uncommitted file${dirty === 1 ? "" : "s"})`);
    const log = runGit(cwd, ["log", "-5", "--format=%s"]);
    if (log) {
      lines.push("Recent commits:");
      for (const subject of log.split("\n").filter((l) => l.trim().length > 0)) lines.push(`- ${subject}`);
    }
  }

  lines.push(`Repro script path: ${reproScriptRelPath(platform)}`);
  return lines.join("\n");
}

/**
 * True when a Bash command invokes the repro script — matched structurally on
 * the script basename (repro.sh / repro.ps1) so any launch form counts (`bash
 * .magentra/debug/repro.sh`, `./repro.sh`, `pwsh repro.ps1`). Weak models phrase
 * the run many ways; the basename is the stable signal.
 *
 * Known, accepted limitation: the check is structural only — a repro.sh that
 * exits nonzero for an UNRELATED reason (syntax error, missing dependency)
 * unlocks edits exactly like a genuine bug reproduction. Verifying the failure
 * semantically would cost a model call on every Bash result; the discipline's
 * value is making the agent WRITE an oracle at all, so the cheap structural
 * trigger is the deliberate trade-off.
 */
export function commandRunsRepro(command: string): boolean {
  return /\brepro\.(?:sh|ps1)\b/.test(command);
}

/** Runs a git command, returning its trimmed stdout, or undefined when git fails / the workspace is not a repo. */
function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
