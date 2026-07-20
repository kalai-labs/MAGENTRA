import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve, sep as pathSep } from "node:path";
import { z } from "zod";
import type { SessionServices, ToolDefinition, ToolResult } from "@magentra/core";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const PWD_MARKER = "__MAGENTRA_PWD__";

// Single-word commands that delete files/folders (POSIX + cmd.exe + common
// cross-platform CLIs). Matched case-insensitively as a standalone command
// token — not as a substring of a longer hyphenated token, so "npm run
// del-lint" does not false-positive on "del", while "format" and "mkdir"
// never match at all (no boundary-aligned occurrence of any keyword).
const DELETION_SINGLE_WORDS = [
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "unlink",
  "rimraf",
  "shred",
  "trash",
  "remove-item",
];
// Multi-word phrases matched as a unit (case-insensitive, via DELETION_PATTERN
// below). Each ends in a word character so the shared trailing \b(?=\s|$)
// assertion applies cleanly.
const DELETION_PHRASES = [
  "git\\s+clean",
  "git\\s+rm",
  "git\\s+push\\s+--force",
  "git\\s+push\\s+-f",
  "git\\s+reset\\s+--hard",
  "git\\s+stash\\s+drop",
  "git\\s+stash\\s+clear",
  "terraform\\s+destroy",
  "drop\\s+table",
  "drop\\s+database",
  "truncate\\s+table",
  "kubectl\\s+delete",
];

const DELETION_PATTERN = new RegExp(
  `\\b(?:${DELETION_SINGLE_WORDS.join("|")}|${DELETION_PHRASES.join("|")})\\b(?=\\s|$)`,
  "i",
);

// git branch -D (force-delete, including unmerged branches) is destructive;
// git branch -d (safe, merged-only delete) must NOT trigger. That distinction
// only holds by letter case, which the shared case-insensitive DELETION_PATTERN
// cannot express, so it is checked separately, case-sensitively.
const GIT_BRANCH_FORCE_DELETE = /\bgit\s+branch\s+-D\b(?=\s|$)/;

// git checkout -- <path> discards working-tree changes to <path>. It ends in
// the "--" separator (non-word chars), so the shared trailing \b(?=\s|$)
// assertion used by DELETION_PATTERN would never match; checked separately
// with a lookahead for the path that follows instead.
const GIT_CHECKOUT_DISCARD = /\bgit\s+checkout\s+--\s+\S/i;

// find's -delete action removes every matched file; the flag can sit anywhere
// in the segment, so it needs its own pattern rather than a phrase.
const FIND_DELETE = /\bfind\b[^|;&]*\s-delete\b/i;

// mv is only destructive when it can silently destroy something: -f/--force
// clobbers an existing destination without asking, and a destination outside
// the workspace (absolute path, ~, or ..) removes the file from the
// workspace's point of view. A plain rename inside the tree is not a deletion.
const MV_SEGMENT = /(?:^|[|;&]\s*)\s*(?:mv|move-item)\s+([^|;&]*)/gi;

function mvIsDestructive(command: string): boolean {
  for (const match of command.matchAll(MV_SEGMENT)) {
    const args = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.some((a) => a === "-f" || a === "--force" || /^-[a-z]*f[a-z]*$/i.test(a))) return true;
    const paths = args.filter((a) => !a.startsWith("-"));
    const dest = paths[paths.length - 1];
    if (dest && /^(\/|~|\.\.(\/|$)|[A-Za-z]:[\\/])/.test(dest)) return true;
  }
  return false;
}

/**
 * Returns the command string when it looks like a destructive/irreversible
 * action (file deletion, forced git history rewrite, infra teardown, or a
 * destructive SQL/kubectl statement), undefined otherwise. Matches after
 * shell separators (&&, ;, |) too, since those are non-word characters and so
 * already satisfy the leading \b. Exported for unit testing and used as
 * bashTool.deletionSubject.
 */
export function bashDeletionSubject(command: string): string | undefined {
  const flagged =
    DELETION_PATTERN.test(command) ||
    GIT_BRANCH_FORCE_DELETE.test(command) ||
    GIT_CHECKOUT_DISCARD.test(command) ||
    FIND_DELETE.test(command) ||
    mvIsDestructive(command);
  return flagged ? command : undefined;
}

// ── OVERDRIVE deletion scope ────────────────────────────────────────────────
// Classifies a deletion-flagged command as provably-in-workspace or unknown.
// Conservative by construction: git history rewrites, SQL/infra teardown,
// shell substitution, unparseable segments, bare/root wildcards, and any
// target that does not resolve strictly inside the workspace all yield
// "unknown" (which keeps the always-ask guard). Only plain rm/del/find/mv
// forms whose every target lands inside the workspace yield "workspace".

/** Substitution or expansion the static classifier cannot see through. */
const UNANALYZABLE = /[$`]|\$\(|<\(|>\(/;

/** The multi-word destructive phrases as one test, mirroring DELETION_PATTERN. */
const DELETION_PHRASE_PATTERN = new RegExp(`\\b(?:${DELETION_PHRASES.join("|")})\\b(?=\\s|$)`, "i");

/** File-deleting commands whose plain path arguments we can classify. */
const PATH_DELETERS = new Set(["rm", "rmdir", "rd", "del", "erase", "unlink", "rimraf", "shred", "trash", "remove-item"]);

/** Strip one layer of surrounding quotes. */
function unquote(token: string): string {
  const m = /^(["'])(.*)\1$/.exec(token);
  return m ? m[2]! : token;
}

/** True when `p` resolves strictly inside `root` (never the root itself). */
function insideWorkspace(p: string, base: string, root: string): boolean {
  const abs = pathResolve(isAbsolute(p) ? p : join(base, p));
  const normRoot = pathResolve(root);
  return abs !== normRoot && abs.startsWith(normRoot + pathSep);
}

/**
 * The deletion targets of one command, or undefined when any part of it is
 * not statically analyzable. Splits on shell separators; each segment either
 * contributes its paths or (if it is a deleter we cannot parse) poisons the
 * whole command to undefined. Non-deleting segments are ignored.
 */
export function bashDeletionTargets(command: string): string[] | undefined {
  if (UNANALYZABLE.test(command)) return undefined;
  // Any of the non-path destructive shapes (history rewrite, SQL, kubectl,
  // git clean/rm/reset, checkout --, branch -D) → not path-classifiable.
  if (
    GIT_BRANCH_FORCE_DELETE.test(command) ||
    GIT_CHECKOUT_DISCARD.test(command) ||
    DELETION_PHRASE_PATTERN.test(command)
  ) {
    return undefined;
  }
  const targets: string[] = [];
  for (const segment of command.split(/[|;&]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const head = tokens[0]!.toLowerCase();
    if (PATH_DELETERS.has(head)) {
      const paths = tokens.slice(1).filter((t) => !t.startsWith("-")).map(unquote);
      if (paths.length === 0) return undefined;
      targets.push(...paths);
    } else if (head === "find" && /\s-delete\b/i.test(segment)) {
      // The first non-flag argument after `find` is the search root.
      const dir = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!dir) return undefined;
      targets.push(unquote(dir));
    } else if ((head === "mv" || head === "move-item") && mvIsDestructive(segment)) {
      targets.push(...tokens.slice(1).filter((t) => !t.startsWith("-")).map(unquote));
    } else if (DELETION_PATTERN.test(segment) || FIND_DELETE.test(segment)) {
      // A destructive shape this parser does not model (e.g. `del` buried
      // mid-segment, xargs) — refuse to classify the whole command.
      return undefined;
    }
  }
  return targets.length > 0 ? targets : undefined;
}

// `.magentra` directories hold MAGENTRA's own state (settings, sessions,
// transcripts, worktrees). Deleting one is never routine autonomous cleanup,
// so any deletion that targets a folder NAMED .magentra — or that we cannot
// rule out targeting one — classifies as "protected": the guard then asks the
// user in every mode, beating the "allow deletions" setting, explicit allow
// rules, and OVERDRIVE's workspace scope-split.
const MAGENTRA_MENTION = /\.magentra\b/i;

/** True when the target IS a .magentra directory (or empties one via `/*`). */
function isMagentraStateDir(raw: string): boolean {
  let p = raw.replace(/[\\/]+$/, "");
  // `.magentra/*` or `.magentra/**` wipes the directory's entire contents —
  // treat it the same as deleting the directory itself.
  const wipe = /^(.*)[\\/]\*{1,2}$/.exec(p);
  if (wipe) p = wipe[1]!;
  const seg = p.split(/[\\/]/).pop() ?? "";
  return seg.toLowerCase() === ".magentra";
}

/** ToolDefinition.deletionScope for Bash — see bashDeletionTargets. */
export function bashDeletionScope(
  command: string,
  shellCwd: string,
  workspace: string,
): "workspace" | "unknown" | "protected" {
  const targets = bashDeletionTargets(command);
  // Unparseable command that mentions .magentra at all: we cannot prove the
  // state dir is safe, so protect it (a false positive only prompts once).
  if (!targets) return MAGENTRA_MENTION.test(command) ? "protected" : "unknown";
  if (targets.some(isMagentraStateDir)) return "protected";
  for (const raw of targets) {
    const globIdx = raw.search(/[*?[]/);
    const literal = globIdx === -1 ? raw : raw.slice(0, globIdx);
    if (globIdx !== -1) {
      // A glob whose literal tail could still expand to `.magentra`
      // (e.g. `rm -rf .magentr*`, `rm -rf tmp/.*`) is protected too.
      const lastSeg = literal.split(/[\\/]/).pop() ?? "";
      if (lastSeg.startsWith(".") && ".magentra".startsWith(lastSeg.toLowerCase())) {
        return "protected";
      }
    }
    if (raw.startsWith("~")) return "unknown";
    // A wildcard is judged by its literal prefix: `tmp/*` → `tmp/`, which must
    // itself be a real directory inside the workspace. A bare `*` (or one at
    // the workspace root) has prefix "" and fails the inside check.
    if (!literal || !insideWorkspace(literal.replace(/[\\/]+$/, "") || literal, shellCwd, workspace)) {
      return "unknown";
    }
  }
  return "workspace";
}

// Persistent working directory per session (directory changes survive across
// calls; env vars and shell functions intentionally do not). Each entry
// remembers the session cwd it was tracked under (`base`): when the session
// cwd itself moves — EnterWorktree/ExitWorktree call setCwd — the tracked
// shell cwd is stale in a DIFFERENT tree and must be discarded, otherwise
// Bash keeps executing outside the worktree while Write/Edit operate inside it.
const sessionCwd = new WeakMap<SessionServices, { base: string; tracked: string }>();

/** The effective shell cwd: the tracked `cd` state while the session cwd is
 *  unchanged, else the (freshly moved) session cwd itself. */
function effectiveCwd(session: SessionServices, sessionDir: string): string {
  const entry = sessionCwd.get(session);
  return entry !== undefined && entry.base === sessionDir ? entry.tracked : sessionDir;
}

const inputSchema = z.object({
  command: z.string().describe("The command to execute"),
  description: z
    .string()
    .describe(
      'Clear, concise description of what this command does in active voice, e.g. "List files in current directory", "Install package dependencies", "Discard all local changes and match remote main". Shown to the user in the approval prompt.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT)
    .optional()
    .describe(`Optional timeout in milliseconds (max ${MAX_TIMEOUT})`),
  run_in_background: z
    .boolean()
    .default(false)
    .describe("Set to true to run this command in the background; you are notified when it exits."),
});

export const bashTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Bash",
  description: `Executes a shell command and returns its combined stdout/stderr.

- The working directory persists across calls (a cd in one call carries to the next), but env vars and functions do not. Prefer absolute paths over cd.
- Do not use this for reading, searching, or editing files — Read/Grep/Glob/Edit are faster and safer than cat/grep/find/sed.
- timeout is in milliseconds: default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}. On timeout the whole process tree is killed.
- run_in_background: true detaches the command; you get a task id immediately, output streams to a file, and a task-notification arrives when it exits. Never run bare foreground "sleep" commands — background the wait instead.
- Never use interactive flags (-i) — there is no TTY.`,
  permissionClass: "execute",
  permissionSubject: (input) => input.command,
  describeInput: (input) => input.description,
  deletionSubject: (input) => bashDeletionSubject(input.command),
  deletionScope: (input, ctx) => bashDeletionScope(input.command, effectiveCwd(ctx.session, ctx.cwd), ctx.cwd),
  execute: async (input, ctx, signal) => {
    if (/^\s*sleep\s+[\d.]+\s*$/.test(input.command)) {
      return {
        content:
          "Foreground sleep is blocked. If you are waiting for something, run the wait in the background (run_in_background with an until-loop) so you keep working meanwhile.",
        isError: true,
      };
    }

    const cwd = effectiveCwd(ctx.session, ctx.cwd);

    if (input.run_in_background) {
      const info = ctx.session.background.launch({
        kind: "bash",
        description: input.description,
        start: (outputFile, onExit) => {
          const out = createWriteStream(outputFile);
          const child = spawnShell(input.command, cwd, false);
          child.stdout.pipe(out);
          child.stderr.pipe(out);
          child.on("close", (code) => {
            out.end();
            onExit(code);
          });
          return { stop: () => killTree(child.pid) };
        },
      });
      return {
        content: `Command running in background with task id: ${info.id}. Output streams to ${info.outputFile}; you will get a task-notification when it exits. Use Read on the output file to check interim output.`,
      };
    }

    return runForeground(input, cwd, ctx.cwd, ctx.session, signal, ctx.callId);
  },
  inputSchema,
};

/**
 * Throttled live-output streamer: buffers chunks and emits one
 * tool_output_delta per interval, so a chatty build log costs a few events per
 * second, not one per write. No-op without a call id (background/nested runs).
 */
function makeOutputStreamer(session: SessionServices, callId: string | undefined) {
  if (!callId) return { push: (_: string) => {}, stop: () => {} };
  let buffer = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const flush = () => {
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    session.emit({ type: "tool_output_delta", id: callId, text });
  };
  return {
    push: (chunk: string) => {
      // The pwd-tracking marker is plumbing, not command output.
      const markerIdx = chunk.indexOf(PWD_MARKER);
      buffer += markerIdx === -1 ? chunk : chunk.slice(0, markerIdx);
      if (!timer) {
        timer = setInterval(flush, 250);
        if (typeof timer.unref === "function") timer.unref();
      }
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      flush();
    },
  };
}

function runForeground(
  input: { command: string; timeout?: number },
  cwd: string,
  /** The session cwd this run is based on — stamped into the tracked entry so
   *  a later session-cwd move (worktree enter/exit) invalidates it. */
  baseCwd: string,
  session: SessionServices,
  signal: AbortSignal,
  callId?: string,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const child = spawnShell(input.command, cwd, true);
    let output = "";
    let done = false;
    const streamer = makeOutputStreamer(session, callId);

    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
      streamer.stop();
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({
        content: `Command timed out after ${timeout}ms and its process tree was killed.\n${clip(output)}`,
        isError: true,
      });
    }, timeout);

    const onAbort = () => {
      killTree(child.pid);
      finish({ content: `Command interrupted.\n${clip(output)}`, isError: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      streamer.push(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      streamer.push(text);
    });
    child.on("error", (err) => finish({ content: `Failed to start shell: ${err.message}`, isError: true }));
    child.on("close", (code) => {
      const markerIdx = output.lastIndexOf(PWD_MARKER);
      let visible = output;
      if (markerIdx !== -1) {
        const line = output.slice(markerIdx);
        const newCwd = line.slice(PWD_MARKER.length).split("\n")[0]?.trim();
        visible = output.slice(0, markerIdx).trimEnd();
        if (newCwd && existsSync(newCwd)) sessionCwd.set(session, { base: baseCwd, tracked: newCwd });
      }
      const text =
        clip(visible).trim() || (code !== 0 ? `(no output, exit code ${code})` : "(no output)");
      finish({ content: text, ...(code !== 0 ? { isError: true } : {}) });
    });
  });
}

let bashPath: string | undefined;

// "bash" on a Windows PATH can resolve to WSL's launcher, whose filesystem view
// (/mnt/c/...) node cannot consume — prefer Git Bash explicitly.
export function resolveBashPath(): string {
  if (bashPath) return bashPath;
  if (process.env.MAGENTRA_BASH && existsSync(process.env.MAGENTRA_BASH)) {
    return (bashPath = process.env.MAGENTRA_BASH);
  }
  if (process.platform === "win32") {
    for (const candidate of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
    ]) {
      if (existsSync(candidate)) return (bashPath = candidate);
    }
  }
  return (bashPath = "bash");
}

export function spawnShell(command: string, cwd: string, trackPwd: boolean) {
  // `pwd -W` prints a native Windows path under Git Bash/msys (which node's fs
  // and spawn can consume); it is unsupported elsewhere, so fall back to $PWD.
  const wrapped = trackPwd
    ? `${command}\n__magentra_ec=$?; printf '\\n${PWD_MARKER}%s\\n' "$(pwd -W 2>/dev/null || pwd)"; exit $__magentra_ec`
    : command;
  return spawn(resolveBashPath(), ["-c", wrapped], {
    cwd,
    ...(process.platform !== "win32" ? { detached: true } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

function clip(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  const half = limit / 2;
  return (
    text.slice(0, half) +
    `\n[truncated — ${text.length - limit} more chars omitted from the middle; redirect output to a file for the full text]\n` +
    text.slice(text.length - half)
  );
}
