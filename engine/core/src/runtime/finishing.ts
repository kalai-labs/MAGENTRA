// FINISHING RUNGS — the end-of-turn checks that stand between "the model stopped
// talking" and "the work is delivered".
//
// They live at the bottom of the same ladder in Session.runTurn, ahead of the
// self-verify rung, because a self-verify that answers DONE breaks the loop and
// nothing placed after it would ever run.
//
//   runtime evidence  → deterministic. The turn changed source files and never
//                       executed anything, so nothing about it has been OBSERVED
//                       working. Fires once, names the files, and asks for a real
//                       run. A reminder, never a block — the same shape as the
//                       Grounding Floor, for the same reason: the failure it
//                       catches looks like success. It has a second shape for the
//                       turn that DID run something, where what it ran was a
//                       stand-in it wrote itself.
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

/**
 * Text that marks a file as containing a test double the agent wrote itself.
 *
 * Chosen for PRECISION, not coverage. A miss costs nothing beyond today's
 * behaviour — the rung simply stays quiet — while a false positive spends a
 * round trip and teaches the model to skim past the reminder, which is worse
 * than never sending it. So this matches only text that is unambiguously
 * standing something in for something else: the mocking libraries by name, and
 * the naming convention a hand-rolled double announces itself with.
 */
const TEST_DOUBLE_MARKERS: readonly string[] = [
  "unittest.mock", "MagicMock", "AsyncMock", "mock.patch", "@patch(", "patch.object(",
  "monkeypatch.setattr", "monkeypatch.setitem",
  "jest.mock(", "jest.fn(", "vi.mock(", "vi.fn(", "sinon.stub(", "sinon.fake", "sinon.mock(",
  "class Fake", "class Mock", "class Stub", "class Dummy",
  "def fake_", "def mock_", "def stub_",
];

/** Whether written text stands something in for a real dependency. */
export function looksLikeTestDouble(text: string): boolean {
  return TEST_DOUBLE_MARKERS.some((marker) => text.includes(marker));
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
 *
 * The closing paragraph is load-bearing and must not be trimmed. A rung that
 * demands green, applied to a dependency this machine cannot execute, does not
 * produce evidence — it produces a stand-in written from the same assumption
 * that is about to be wrong, and a passing test on top of it. Naming "I could
 * not run this, here is what stays unverified" as a FULLY correct ending is what
 * keeps the rung from manufacturing the very failure it exists to catch.
 */
export function runtimeEvidenceText(files: string[]): string {
  return `<system-reminder>You changed code this turn (${fileList(files)}) and did not run a single command, so nothing you wrote has been observed working. Settle that now, then finish.

Work down this list and stop as soon as the change is settled:
1. Fast gate first — the project's own build/typecheck/lint if it has one. It catches the cheap failures, but passing it is NOT evidence: it proves the code parses, not that it behaves.
2. Execute the path you changed, and the callers it reaches that your change could break. Drive it however this project can be driven: its CLI, its entry point, a one-off \`node -e\` / \`python -c\`, an existing test that already covers this path, a request against a server you start and stop.
3. If a one-liner will not reach it, write a throwaway harness — put it in the system temp directory, not in the repository — and DELETE it in this same turn. A harness DRIVES your real code; it does not replace the thing you are unsure about. The moment you substitute a stand-in for the dependency, you stopped measuring reality and started measuring your own assumption.
4. Judge against something you can actually read: exit codes, stdout, a log line, a returned value, a file the code wrote. You have no eyes here — never claim you looked at a screenshot or a window.
5. Say in your wrap-up what you ran and what you saw. A failing run reported honestly is a good outcome; a silent one is not.

If this change genuinely cannot be executed on this machine — it needs a console, a display, a device, a credential or a service you do not have — then STOP HERE AND SAY SO. Name the closest thing you did run, name what stays unverified, and move on. That is a complete and correct answer to this reminder, and it is worth more than a green result you had to manufacture. Nothing here asks you to end with a passing check; it asks you to know, and to say, what you actually observed.

Where you cannot run a thing, you can still usually confirm its CONTRACT: import it and print its signature or docstring, check the type of what it returns, read the source you are calling. A function that needs a console still tells you what it gives back. That costs one command and is real evidence; guessing the contract and then encoding the guess into a stand-in is not.</system-reminder>`;
}

/**
 * The circular-evidence rung — the second shape of the same question, for the
 * turn that DID run something, where what it ran was a stand-in it wrote itself.
 *
 * This is the failure the first shape cannot see. A double is a model of the
 * dependency, authored by the same understanding that authored the code, so the
 * two agree by construction: the test passes, the assumption is never
 * challenged, and the program breaks the first time it meets the real thing. The
 * rung is a reminder, so it never blocks; what it asks for is either the real
 * contract or an honest statement of what remains unverified.
 */
export function circularEvidenceText(files: string[], doubleFiles: string[]): string {
  return `<system-reminder>You changed code this turn (${fileList(files)}) and the checking you ran leans on stand-ins you wrote yourself (${fileList(doubleFiles)}). Read that sentence again before you finish.

A mock, fake, stub or patch is a MODEL of the thing it replaces, and you are its author. It agrees with whatever you believed when you wrote it. So a passing check against your own stand-in tells you your code is self-consistent; it tells you nothing at all about the real dependency, and it will agree with you just as confidently when you are wrong.

Before this turn ends, for every real thing you replaced:
1. Say where its contract came from. If the answer is "I assumed it", that is the thing to fix, not the code.
2. Confirm it from the dependency itself — import it and print its signature or docstring, check the type of what a real call returns, or read the source you are calling. This usually costs one command and does not need the dependency to be fully usable: a function that needs a console, a device or a credential still tells you its return type, its exception type, its units, and whether it hands back bytes or text.
3. If the confirmed contract differs from what your stand-in does, your code is wrong and your check was agreeing with the bug. Fix both, and say so.

If the contract genuinely cannot be confirmed here, say that plainly and name exactly which behaviours remain unverified. An honest gap is a good outcome. A green check built on your own assumption is not a good outcome — it is the same unverified guess wearing the costume of proof.</system-reminder>`;
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
    ? `You changed code this turn (${fileList(changedCode)}). "Fully handled" includes SETTLED: either the change was observed doing what it was supposed to do — executed against the real thing, not merely compiled, re-read, reasoned about, or agreed with by a stand-in you wrote yourself — or you told the user plainly which parts you could not run and what stays unverified. Either of those is done. Reporting a verification you did not actually perform is not.`
    : "Judge only against the query itself — never invent verification rituals (builds, tests) it did not ask for.";
  return `<system-reminder>Internal self-check — this is NOT a new user message and the user is NOT waiting for another reply. Your entire output for this step must be either the single word DONE or continued work. Nothing else. Do not greet, do not re-answer, do not summarize, do not introduce yourself.

Decide silently: is every part of the user's original query already fully handled (a conversational message with nothing to do counts as handled), and did this turn leave nothing unnecessary behind (scratch files, duplicated helpers, abandoned attempts)?
- If YES → output exactly this literal ASCII word and nothing else, never translated or localized even when the conversation is in another language: DONE
- If NO → do the remaining work now (call tools / write the fix / clean up). Whatever you write in this case IS shown to the user; the DONE token never is.

${closing}</system-reminder>`;
}
