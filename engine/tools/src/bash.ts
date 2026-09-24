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

// ── Process-kill guard ──────────────────────────────────────────────────────
// A kill BY NAME stops every matching process on the machine — the user's own
// editors, servers and notebooks included — not only what this session
// started. In the 2026-09-23 field test the agent ran
// `taskkill //F //IM python.exe` in OVERDRIVE with no prompt, and used TaskStop
// on its own job four seconds later. Unlike the deletion classifier above,
// this one reads COMMAND POSITIONS rather than words anywhere: in OVERDRIVE a
// flagged call is refused instead of asked, so a commit message that mentions
// pkill must not cost the agent its commit.

/** One simple command: its words with quotes removed, and whether a pipe fed it. */
interface SimpleCommand {
  words: string[];
  piped: boolean;
}

/**
 * Splits a command line into simple commands on the unquoted shell operators
 * (`;` `&` `|` `&&` `||`, newlines) and on grouping (`(` `)` `$(` backticks,
 * and standalone `{` `}`). A substitution still runs inside double quotes, so
 * `$(` and backticks split there too. The `&` of a redirection (`2>&1`, `&>`)
 * is not a separator. Words keep their text with the quotes removed.
 */
function simpleCommands(command: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  /** Open contexts: double quote, `$(` substitution, backtick substitution. */
  const stack: ('"' | "$(" | "`")[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let piped = false;
  const endWord = (): void => {
    if (inWord && word !== "{" && word !== "}") words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (nextPiped = false): void => {
    endWord();
    if (words.length > 0) out.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  const top = (): string | undefined => stack[stack.length - 1];
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (c === "$" && next === "(") {
      endCommand();
      stack.push("$(");
      i++;
      continue;
    }
    if (c === "`") {
      endCommand();
      if (top() === "`") stack.pop();
      else stack.push("`");
      continue;
    }
    if (top() === '"') {
      // Inside double quotes a backslash escapes only $ ` " \ and a newline;
      // any other one is kept ("C:\Windows\...\taskkill.exe" names taskkill).
      if (c === '"') stack.pop();
      else if (c === "\\" && next !== undefined && '$`"\\\n'.includes(next)) word += command[++i];
      else word += c;
      inWord = true;
      continue;
    }
    // A comment runs to the end of its line; an apostrophe in it opens no quote.
    if (c === "#" && !inWord) {
      const eol = command.indexOf("\n", i);
      i = eol === -1 ? command.length : eol - 1;
      continue;
    }
    // A here-document's body is data, not commands: `cat <<'EOF'` … `EOF`.
    if (c === "<" && next === "<" && command[i + 2] !== "<") {
      const heredoc = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
      if (heredoc) {
        endWord();
        const bodyStart = command.indexOf("\n", i);
        if (bodyStart === -1) {
          i += heredoc[0].length - 1;
          continue;
        }
        const end = new RegExp(`\\n\\t*${heredoc[2]}[ \\t]*(?=\\n|\\)|$)`).exec(command.slice(bodyStart));
        // The rest of the line after the delimiter still runs (`<<EOF | sh`, `)`).
        const rest = command.slice(i + heredoc[0].length, bodyStart);
        const after = end ? command.slice(bodyStart + end.index + end[0].length) : "";
        // …unless a shell reads it (`bash <<EOF`, `cat <<EOF | sh`): then the body runs.
        const body = command.slice(bodyStart + 1, end ? bodyStart + end.index : command.length);
        const bodyRuns = /(^|[\s|/\\])((ba|z|da|k)?sh|pwsh|powershell|cmd)(\.exe)?(\s|$)/i.test(` ${words.join(" ")} ${rest} `);
        return [
          ...out,
          ...(words.length > 0 ? [{ words, piped }] : []),
          ...simpleCommands(rest),
          ...(bodyRuns ? simpleCommands(body) : []),
          ...simpleCommands(after),
        ];
      }
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      word += close === -1 ? command.slice(i + 1) : command.slice(i + 1, close);
      inWord = true;
      i = close === -1 ? command.length : close;
      continue;
    }
    if (c === '"') {
      stack.push('"');
      inWord = true;
      continue;
    }
    if (c === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === ")") {
      if (top() === "$(") stack.pop();
      endCommand();
      continue;
    }
    if (c === "(" || c === ";" || c === "\n" || c === "\r") {
      endCommand();
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endCommand();
        i++;
      } else {
        endCommand(true);
      }
      continue;
    }
    if (c === "&") {
      const prev = command[i - 1];
      if (prev === ">" || prev === "<" || next === ">") {
        word += c;
        inWord = true;
        continue;
      }
      endCommand();
      if (next === "&") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand();
  return out;
}

/** A program name as the guard compares it: no directory, no `.exe`, lower case. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** Prefixes that run the command after them: `sudo pkill …` is a pkill. */
const RUNNERS = new Set(["sudo", "doas", "nohup", "time", "exec", "command", "builtin", "nice", "timeout", "env", "stdbuf"]);
/** Shell keywords a command can follow: `then pkill …`, `do kill $pid`, `! pkill …`. */
const KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!"]);
/** xargs options that take a value, so the value is not mistaken for the program. */
const XARGS_VALUE_OPTIONS = new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-a", "-E"]);
/** Commands whose job is to find pids by NAME: a kill fed by one is a kill by name. */
const NAME_LOOKUPS = new Set(["pgrep", "pidof", "ps", "get-process", "gps", "tasklist"]);
/** Commands that stop processes, for the name-lookup rule. */
const KILLERS = new Set(["kill", "stop-process", "spps", "taskkill", "tskill"]);
/** powershell options that take a value, so the value is not read as the command. */
const POWERSHELL_VALUE_OPTIONS = /^-(executionpolicy|ep|windowstyle|w|version|v|outputformat|of|inputformat|if|configurationname|workingdirectory|wd|file|f)$/i;

interface ResolvedCommand {
  head: string;
  args: string[];
  piped: boolean;
  /** The command strings a shell wrapper (`bash -c`, `cmd /c`, `powershell -Command`) runs. */
  inner: string[];
}

/** The program a simple command really runs, past runners, env assignments and xargs. */
function resolveCommand(cmd: SimpleCommand): ResolvedCommand | undefined {
  const words = [...cmd.words];
  while (words.length > 0) {
    const first = words[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      words.shift();
      continue;
    }
    const name = programName(first);
    if (KEYWORDS.has(name)) {
      words.shift();
      continue;
    }
    // `command -v pkill` asks whether pkill exists; it runs nothing.
    if (name === "command" && (words[1] === "-v" || words[1] === "-V")) return undefined;
    if (RUNNERS.has(name)) {
      words.shift();
      // Their options (sudo -u bob, nice -n 5, timeout 10s) come before the program.
      while (words.length > 0 && (words[0]!.startsWith("-") || /^\d/.test(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) {
        const opt = words.shift()!;
        if ((opt === "-u" || opt === "-g" || opt === "-n") && words.length > 0) words.shift();
      }
      continue;
    }
    if (name === "xargs") {
      words.shift();
      while (words.length > 0 && words[0]!.startsWith("-")) {
        const opt = words.shift()!;
        if (XARGS_VALUE_OPTIONS.has(opt) && words.length > 0) words.shift();
      }
      continue;
    }
    break;
  }
  if (words.length === 0) return undefined;
  const head = programName(words[0]!);
  const args = words.slice(1);
  const inner: string[] = [];
  if (/^(ba|z|da|k)?sh$/.test(head)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (flag !== -1 && args[flag + 1] !== undefined) inner.push(args[flag + 1]!);
  } else if (head === "powershell" || head === "pwsh") {
    // `-Command` takes the rest of the line; without it, the first word that is
    // not an option (or an option's value) starts the command.
    let start = args.findIndex((a) => /^-c(ommand)?$/i.test(a)) + 1;
    if (start === 0) {
      start = args.length;
      for (let j = 0; j < args.length; j++) {
        if (!args[j]!.startsWith("-")) {
          start = j;
          break;
        }
        if (POWERSHELL_VALUE_OPTIONS.test(args[j]!)) j++;
      }
    }
    if (start < args.length) inner.push(args.slice(start).join(" "));
  } else if (head === "eval") {
    if (args.length > 0) inner.push(args.join(" "));
  } else if (head === "cmd") {
    const flag = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (flag !== -1 && flag + 1 < args.length) inner.push(args.slice(flag + 1).join(" "));
  }
  return { head, args, piped: cmd.piped, inner };
}

/** A PowerShell parameter written as any prefix of `full` (PowerShell accepts those). */
function isParam(arg: string, full: string, minLength = 1): boolean {
  if (!arg.startsWith("-")) return false;
  const given = arg.slice(1).replace(/:.*$/, "").toLowerCase();
  return given.length >= minLength && full.startsWith(given);
}

/** POSIX kill: true when a target is -1 — every process the user may signal. */
function killTargetsEveryProcess(args: string[]): boolean {
  let i = 0;
  const first = args[0];
  if (first === "-l" || first === "-L") return false;
  if (first === "-s" || first === "-n") i = 2;
  else if (first !== undefined && first !== "--" && first.startsWith("-") && args.length > 1) i = 1;
  if (args[i] === "--") i++;
  return args.slice(i).includes("-1");
}

/** True when one resolved command, on its own, stops processes by name or all of them. */
function killsByName(cmd: ResolvedCommand): boolean {
  const { head, args } = cmd;
  switch (head) {
    case "pkill":
    case "killall":
      return true;
    case "tskill": {
      const target = args.find((a) => !a.startsWith("/") && !a.startsWith("-"));
      return target === undefined || !/^\d+$/.test(target);
    }
    case "taskkill": {
      // `/IM`, `//IM` (Git Bash) and `-IM` are one option; so are the /PID forms.
      const options = args.filter((a) => /^(\/\/?|-)/.test(a)).map((a) => a.replace(/^(\/\/?|-)/, "").toLowerCase());
      return options.includes("im") || !options.includes("pid");
    }
    case "stop-process":
    case "spps": {
      if (cmd.piped) return true;
      if (args.some((a) => isParam(a, "name") || isParam(a, "processname", 2))) return true;
      const byId = args.some((a) => isParam(a, "id")) || args.some((a) => /^\d+(,\d+)*$/.test(a));
      return !byId;
    }
    case "kill":
      // PowerShell's `kill` is Stop-Process; POSIX kill has no -Name. Two
      // letters at least, so POSIX `kill -n 9 <pid>` stays a kill by pid.
      if (args.some((a) => isParam(a, "name", 2) || isParam(a, "processname", 2))) return true;
      return killTargetsEveryProcess(args);
    case "wmic": {
      const lower = args.map((a) => a.toLowerCase());
      const processClass = lower[0] === "process" || (lower[0] === "path" && lower[1] === "win32_process");
      return processClass && (lower.includes("delete") || (lower.includes("call") && lower.includes("terminate")));
    }
    default:
      return false;
  }
}

/**
 * Whether a kill's targets are all named outright — pids, `%job` specs, `$!` —
 * so no name lookup elsewhere in the line can be what feeds it. A kill with a
 * variable or no target at all (`xargs kill`, `kill $(…)`) could be fed one.
 */
function killsLiteralTargets(cmd: ResolvedCommand): boolean {
  const targets = cmd.args.filter((a) => !/^(\/\/?|-)/.test(a));
  return !cmd.piped && targets.length > 0 && targets.every((a) => /^(\d+(,\d+)*|%\S+|\$!)$/.test(a));
}

/** Every resolved command in `command`, including what shell wrappers run. */
function resolvedCommands(command: string, depth = 0): ResolvedCommand[] {
  const out: ResolvedCommand[] = [];
  for (const simple of simpleCommands(command)) {
    const cmd = resolveCommand(simple);
    if (!cmd) continue;
    out.push(cmd);
    if (depth < 3) for (const inner of cmd.inner) out.push(...resolvedCommands(inner, depth + 1));
  }
  return out;
}

/**
 * Returns the command string when it stops processes BY NAME or every process —
 * taskkill /IM (or without /PID), pkill, killall, tskill <name>, Stop-Process
 * -Name or fed by a pipe, POSIX kill -1, wmic process … delete, a Win32_Process
 * terminate, or any kill whose pids come from a name lookup (pgrep, pidof, ps,
 * Get-Process, tasklist) in the same command. Undefined for kills by pid or by
 * port, and for these words anywhere but a command position. Used as
 * bashTool.processKillSubject and monitorTool.processKillSubject.
 */
export function bashProcessKillSubject(command: string): string | undefined {
  const commands = resolvedCommands(command);
  if (commands.some(killsByName)) return command;
  const looksUpByName = commands.some((c) => NAME_LOOKUPS.has(c.head));
  if (looksUpByName && commands.some((c) => KILLERS.has(c.head) && !killsLiteralTargets(c))) return command;
  // PowerShell: (Get-Process python).Kill() and … | ForEach-Object { $_.Kill() }.
  if (looksUpByName && /\.kill\s*\(\s*\)/i.test(command)) return command;
  if (/win32_process/i.test(command) && /\bterminate\b|remove-(?:cim|wmi)/i.test(command)) return command;
  return undefined;
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
    .describe(`Optional timeout in milliseconds (max {{maxTimeout}})`),
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
- timeout is in milliseconds: default {{defaultTimeout}}, max {{maxTimeout}}. On timeout the whole process tree is killed.
- run_in_background: true detaches the command; you get a task id immediately, output streams to a file, and a task-notification arrives when it exits. Never run bare foreground "sleep" commands — background the wait instead.
- To stop a background command, use TaskStop with its task id. Never stop processes by name (taskkill /IM, pkill, killall, Stop-Process -Name): that stops every matching process on the machine, not only yours.
- To wait for a server you started in the background, keep the wait short and check its job between tries (TaskOutput with block: false shows whether it is still running): a loop that only polls the port keeps spinning after the server has died.
- Never use interactive flags (-i) — there is no TTY.
- Command output is shown to you, not reliably to the user. Restate anything that matters in your final message.

Git:
- Never commit, push, or create branches unless the user asked for it in this conversation. If it is unclear whether they want a commit, ask.
- To commit when asked: run git status, git diff, and git log (recent style) in parallel; draft a one-to-two-sentence message explaining why the change exists; stage the specific files by name (never git add -A or .); commit passing the message through
a heredoc so formatting survives; then verify with git status.
- Never use --force, --no-verify, --no-gpg-sign, git config changes, reset --hard, checkout ., clean -f, or branch -D unless the user explicitly requests that exact operation. Never force-push to main/master — warn instead.
- If a pre-commit hook fails, the commit did not happen: fix the issue, re-stage, and create a NEW commit. Never amend, since amending after a hook failure rewrites the previous commit and can destroy work.
- Do not commit files that look like secrets (.env, credentials); warn if asked to. Do not create empty commits.`,
  descriptionVars: { defaultTimeout: DEFAULT_TIMEOUT, maxTimeout: MAX_TIMEOUT },
  permissionClass: "execute",
  permissionSubject: (input) => input.command,
  describeInput: (input) => input.description,
  deletionSubject: (input) => bashDeletionSubject(input.command),
  deletionScope: (input, ctx) => bashDeletionScope(input.command, effectiveCwd(ctx.session, ctx.cwd), ctx.cwd),
  processKillSubject: (input) => bashProcessKillSubject(input.command),
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
    // Files the model has Read that were already stale before this command are
    // not this command's doing; only the ones it changes are named after it.
    const staleBefore = new Set(session.fileState.changedSinceRead());
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
      // A shell edit (sed -i, a formatter, a generator) leaves every Read of
      // those files stale, and the next Edit would be refused without saying
      // why the file moved. Name them here, once, where the change happened.
      const touched = session.fileState.changedSinceRead().filter((p) => !staleBefore.has(p));
      const note = touched.length > 0
        ? `\n\n[This command changed ${touched.length === 1 ? "a file" : `${touched.length} files`} you had Read: ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? ` and ${touched.length - 10} more` : ""}. Read ${touched.length === 1 ? "it" : "them"} again before you Edit.]`
        : "";
      finish({ content: text + note, ...(code !== 0 ? { isError: true } : {}) });
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
