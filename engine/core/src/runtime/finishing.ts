// FINISHING RUNGS — the two end-of-turn checks that stand between "the model
// stopped talking" and "the work is delivered".
//
// Both live at the bottom of the same ladder in Session.runTurn, ahead of the
// self-verify rung, because a self-verify that answers DONE breaks the loop and
// nothing placed after it would ever run.
//
//   runtime evidence  → deterministic. The turn changed source files and never
//                       executed anything, so nothing about it has been OBSERVED
//                       working. Fires once, names the files, and asks for a real
//                       run. A reminder, never a block — the same shape as the
//                       Grounding Floor, for the same reason: the failure it
//                       catches looks like success.
//   readability       → optional, off by default, user-thrown. One quick pass
//                       over the diff for cleanliness and for anything the user
//                       still has to be told. Fires at most once per turn: it is
//                       a tidy-up, not a second implementation phase.
//
// Everything here is prose and pure functions. It deliberately imports nothing
// from the session or the permission engine, so it can be checked in isolation.

import { extname } from "node:path";

/**
 * File suffixes whose contents are executable behaviour, so a change to one can
 * be proven by running it. Deliberately generous — the rung it feeds only ever
 * reminds, and a reminder on a file that turns out to be unrunnable costs one
 * honest sentence, while a miss costs an unverified change.
 *
 * Documentation, configuration and data files are absent on purpose: editing a
 * README or a lockfile is not a behaviour change, and demanding a test run for
 * one is exactly the ceremony the prompts tell the agent to skip.
 */
const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".m", ".mm", ".swift",
  ".php", ".lua", ".dart", ".ex", ".exs", ".erl", ".hs", ".clj",
  ".sh", ".bash", ".zsh", ".ps1", ".sql",
  ".vue", ".svelte", ".html", ".css", ".scss",
]);

/** The subset of `paths` whose suffix marks them as runnable source. */
export function codeFilesAmong(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (CODE_FILE_EXTENSIONS.has(extname(path).toLowerCase())) out.push(path);
  }
  return out;
}

/** How many changed files a rung names before it starts counting instead. A
 *  reminder that lists forty paths teaches nothing and costs the context it
 *  takes; the point is to name the work, not to reprint the diff. */
const MAX_NAMED_FILES = 8;

function fileList(files: string[]): string {
  if (files.length <= MAX_NAMED_FILES) return files.join(", ");
  return `${files.slice(0, MAX_NAMED_FILES).join(", ")} and ${files.length - MAX_NAMED_FILES} more`;
}

/**
 * The runtime-evidence rung. Sent when source files changed this turn and no
 * command was ever run, which means the change has been reasoned about but
 * never observed.
 *
 * It asks for behaviour, not ritual: run the path that changed and the callers
 * it reaches, watch something real (exit code, stdout, a log line, a returned
 * value), and throw the scaffolding away afterwards. It explicitly does NOT ask
 * for a new permanent test — growing a suite on every edit is its own kind of
 * mess, and the user asked for proof, not for files.
 */
export function runtimeEvidenceText(files: string[]): string {
  return `<system-reminder>You changed code this turn (${fileList(files)}) and did not run a single command, so nothing you wrote has been observed working. Prove it now, then finish.

Work down this list and stop as soon as the change is proven:
1. Fast gate first — the project's own build/typecheck/lint if it has one. It catches the cheap failures, but passing it is NOT evidence: it proves the code parses, not that it behaves.
2. Execute the path you changed, and the callers it reaches that your change could break. Drive it however this project can be driven: its CLI, its entry point, a one-off \`node -e\` / \`python -c\`, an existing test that already covers this path, a request against a server you start and stop.
3. If a one-liner will not reach it, write a throwaway harness — put it in the system temp directory, not in the repository — and DELETE it in this same turn. Do not add a permanent test unless the project already has a suite this change belongs in.
4. Judge against something you can actually read: exit codes, stdout, a log line, a returned value, a file the code wrote. You have no eyes here — never claim you looked at a screenshot or a window.
5. Say in your wrap-up what you ran and what you saw. A failing run reported honestly is a good outcome; a silent one is not.

If this change genuinely cannot be executed on this machine — it needs a display, a device, a credential or a service you do not have — say so in one line, name the closest thing you DID run, and move on. That is an honest answer. Claiming verification you did not perform is not.</system-reminder>`;
}

/**
 * The readability rung, sent only when the user has armed the feature. One pass,
 * two questions, and a hard instruction to keep it small: the whole value of the
 * feature is that it costs a single round trip at the very end, so a pass that
 * turns into a refactor has defeated it.
 */
export function readabilityPassText(files: string[]): string {
  return `<system-reminder>Readability pass — one quick read over what you changed (${fileList(files)}) before the turn ends. This is a tidy-up, not a new phase of work: no refactors, no new features, no fresh investigation, and no second pass after this one.

Ask two questions:
1. Is this code clean enough to hand over? Names that say what they hold, no leftover debug output or commented-out attempts, no dead code or unused imports your change orphaned, nothing duplicating something that already existed, and the same idiom as the code around it.
2. Is anything still owed to the user? An assumption you made for them, scope you deliberately left out, a limitation you know about, or a manual step they must take themselves (a migration, an install, an env var, a restart).

Fix what is a small fix, right now. Anything bigger than that is NOT for this pass — put it in your wrap-up as an open item instead. If the code is already clean and nothing is owed, change nothing and simply finish; saying so in one clause is enough.</system-reminder>`;
}

/**
 * The end-of-turn self check. Judges the turn against the user's own query —
 * completeness and economy — and answers with the DONE sentinel or with the work
 * that was still missing.
 *
 * `changedCode` sharpens it rather than adding a rung of its own. The generic
 * text has to warn the model off inventing rituals, because on a conversational
 * turn a build is pure waste; but on a turn that rewrote source files the
 * opposite failure is the likely one, so the closing clause flips to demand the
 * evidence instead of warning against it.
 */
export function selfVerifyText(changedCode: string[]): string {
  const closing = changedCode.length > 0
    ? `You changed code this turn (${fileList(changedCode)}). "Fully handled" includes PROVEN: the change must have been observed doing what it was supposed to do — executed, not merely compiled, re-read, or reasoned about. If you have not seen it run, that is remaining work: run it now. Never report verification you did not perform.`
    : "Judge only against the query itself — never invent verification rituals (builds, tests) it did not ask for.";
  return `<system-reminder>Internal self-check — this is NOT a new user message and the user is NOT waiting for another reply. Your entire output for this step must be either the single word DONE or continued work. Nothing else. Do not greet, do not re-answer, do not summarize, do not introduce yourself.

Decide silently: is every part of the user's original query already fully handled (a conversational message with nothing to do counts as handled), and did this turn leave nothing unnecessary behind (scratch files, duplicated helpers, abandoned attempts)?
- If YES → output exactly this literal ASCII word and nothing else, never translated or localized even when the conversation is in another language: DONE
- If NO → do the remaining work now (call tools / write the fix / clean up). Whatever you write in this case IS shown to the user; the DONE token never is.

${closing}</system-reminder>`;
}
