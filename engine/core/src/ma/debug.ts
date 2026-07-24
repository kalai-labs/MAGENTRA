/**
 * Support for the `repro-failed` tool gate (reproduce-first debugging): a skill
 * can require the model to write a self-checking repro script under DEBUG_DIR,
 * observe it fail (which unlocks editing), then iterate until the same script
 * passes. This module names the script location and detects repro runs.
 *
 * No built-in ships with a `repro-failed` gate today (the /debug command and the
 * debug discipline were retired — see /obsolete), so this machinery is dormant;
 * it stays as generic gate support for a future Addon that opts into the oracle.
 */

/** Workspace-relative directory the model owns for the repro script (writable while a repro-failed gate is active). */
export const DEBUG_DIR = ".magentra/debug";

/** Workspace-relative path of the repro script — a PowerShell script on Windows, a shell script elsewhere. */
export function reproScriptRelPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? ".magentra/debug/repro.ps1" : ".magentra/debug/repro.sh";
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
 * semantically would cost a model call on every Bash result; the gate's value is
 * making the agent WRITE an oracle at all, so the cheap structural trigger is
 * the deliberate trade-off.
 */
export function commandRunsRepro(command: string): boolean {
  return /\brepro\.(?:sh|ps1)\b/.test(command);
}
