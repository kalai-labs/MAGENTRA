import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
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
  // mv removes content from where it was: it clobbers any existing destination
  // and, moved outside the workspace, is a deletion in everything but name.
  "mv",
  "move-item",
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
    GIT_CHECKOUT_DISCARD.test(command);
  return flagged ? command : undefined;
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

    return runForeground(input, cwd, ctx.cwd, ctx.session, signal);
  },
  inputSchema,
};

function runForeground(
  input: { command: string; timeout?: number },
  cwd: string,
  /** The session cwd this run is based on — stamped into the tracked entry so
   *  a later session-cwd move (worktree enter/exit) invalidates it. */
  baseCwd: string,
  session: SessionServices,
  signal: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const child = spawnShell(input.command, cwd, true);
    let output = "";
    let done = false;

    const finish = (result: ToolResult) => {
      if (done) return;
      done = true;
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

    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
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
    `\n[... output truncated (${text.length} chars total) ...]\n` +
    text.slice(text.length - half)
  );
}
