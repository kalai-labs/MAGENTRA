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
import { definePrompt, promptText, renderPrompt } from "@magentra/protocol";

const GROUP = "4 · End-of-turn rungs";

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
const RUNTIME_EVIDENCE = definePrompt({
  id: "finishing.runtime-evidence",
  group: GROUP,
  label: "Runtime evidence rung",
  channel: "reminder",
  where:
    "Fires once at the end of a turn that edited source files but never ran a command. Injected as a user-role reminder, which costs at least one extra round trip — shorten or blank it to make turns finish faster.",
  placeholders: ["files", "visionNote", "doubleNote"],
  text: `<system-reminder>You changed code this turn ({{files}}) and did not run a single command, so nothing you wrote has been observed working. Handle that now, then finish.

Work down this list and stop as soon as the change is settled:
1. Fast gate first — the project's own build/typecheck/lint if it has one. It catches the cheap failures, but passing it is NOT evidence: it proves the code parses, not that it behaves.
2. Execute the path you changed, and the callers it reaches that your change could break.
3. If a one-liner will not reach it, write a throwaway harness — put it in the system temp directory, not in the repository — and DELETE it in this same turn. A harness DRIVES your real code; it does not replace the thing you are unsure about. The
moment you substitute a stand-in for the dependency, you stopped measuring reality and started measuring your own assumption.
4. Judge against something you can actually read: exit codes, stdout, a log line, a returned value, a file the code wrote. {{visionNote}}
5. Say in your wrap-up what you ran and what you observed. A failing run reported honestly is a good outcome; a silent one is not.

{{doubleNote}}
If this change genuinely cannot be executed on this machine — it needs a device, a credential or a service you do not have — then STOP HERE AND SAY SO. Name the closest thing you did run, name what stays unverified, and move on. That is a complete and correct answer to this reminder, and it is worth more than a green result you had to manufacture. Nothing here asks you to end with a passing check; it asks you to know, and to say, what you actually observed.

Where you cannot run a thing, you can still usually confirm its CONTRACT: import it and print its signature or docstring, check the type of what it returns, read the source you are calling. A function that needs a console still tells you what it gives back. That costs one command and is real evidence; guessing the contract and then encoding the guess into a stand-in is not.</system-reminder>`,
});

const VISION_ON = definePrompt({
  id: "finishing.vision-on",
  group: GROUP,
  label: "Vision clause — enabled",
  channel: "reminder",
  where:
    "Substituted into `{{visionNote}}` of the runtime-evidence rung when settings.vision is true AND a vision model is configured. Tells the agent a screenshot is real evidence it may go and get — through the describing model, not with its own eyes.",
  text: "You CAN get at images here: capture a screenshot of the running app and Read it. A separate vision model looks at it and hands you a written description — that description is the observation, so take it rather than reasoning about what the pixels probably do. Say it came from the description; never claim you looked at the screen yourself.",
});

const VISION_OFF = definePrompt({
  id: "finishing.vision-off",
  group: GROUP,
  label: "Vision clause — disabled",
  channel: "reminder",
  where:
    "Substituted into `{{visionNote}}` when settings.vision is false (the default). States the limit as a fact about this workspace, not as a claim about what the harness can do.",
  text: "Vision is off for this workspace, so you cannot read an image even if you produce one. Never claim you looked at a screenshot or a window. Verify a visual change through what the app WRITES instead — rendered text, DOM state, a log line, an exit code — or say plainly that the appearance stays unverified.",
});

/**
 * The circular-evidence clause, folded into the rung above rather than shipped
 * as a rung of its own.
 *
 * It answers a question the rest of the reminder cannot: the turn DID run
 * something, so "nothing was observed" is false — but what it observed was a
 * model of the dependency, authored by the same understanding that authored the
 * code. The two agree by construction. Only the argument survives the merge;
 * confirming a contract from the dependency and naming an honest gap are
 * already said once in the closing paragraphs, and saying them twice in one
 * reminder teaches the model to skim.
 */
const DOUBLE_CLAUSE = definePrompt({
  id: "finishing.double-clause",
  group: GROUP,
  label: "Stand-in clause",
  channel: "reminder",
  where:
    "Substituted into `{{doubleNote}}` of the runtime-evidence rung when the turn's checking leaned on mocks, fakes or stubs the agent wrote itself. Empty otherwise, so a turn with real evidence never pays for it.",
  placeholders: ["doubleFiles"],
  text: `
The checking you ran leans on stand-ins you wrote yourself ({{doubleFiles}}). Read that again. A mock, fake, stub or patch is a MODEL of the thing it replaces, and you are its author — it agrees with whatever you believed when you wrote it. A passing check against your own stand-in proves your code is self-consistent and nothing more; it will agree with you just as confidently when you are wrong. So: say where each replaced contract came from, and if the answer is "I assumed it", that is the thing to fix, not the code. If the real contract differs from what your stand-in does, your code is wrong and your check was agreeing with the bug — fix both, and say so.
`,
});

export function runtimeEvidenceText(files: string[], vision: boolean, doubleFiles: string[] = []): string {
  return renderPrompt(RUNTIME_EVIDENCE, {
    files: fileList(files),
    visionNote: promptText(vision ? VISION_ON : VISION_OFF),
    doubleNote: doubleFiles.length === 0
      ? ""
      : renderPrompt(DOUBLE_CLAUSE, { doubleFiles: fileList(doubleFiles) }),
  });
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
const SELF_VERIFY = definePrompt({
  id: "finishing.self-verify",
  group: GROUP,
  label: "Self-verify rung",
  channel: "reminder",
  where:
    "Fires at the end of an OVERDRIVE turn that made at least one tool call — never in normal mode, never on a turn with no tool calls, and at most once per turn. The agent answers DONE (never shown to the user) or keeps working, so it costs one extra inference round on the turns it does fire, and nothing on the rest. `{{closing}}` is one of the two clauses below it. Empty this prompt to switch the round off.",
  placeholders: ["closing"],
  text: `<system-reminder>Internal self-check — this is NOT a new user message and the user is NOT waiting for another reply. Your entire output for this step must be either the single word DONE or continued work. Nothing else. Do not greet, do not re-answer, do not summarize, do not introduce yourself.

Decide silently: is every part of the user's original query already fully handled (a conversational message with nothing to do counts as handled), and did this turn leave nothing unnecessary behind (scratch files, duplicated helpers, abandoned attempts)?
- If YES → output exactly this literal ASCII word and nothing else, never translated or localized even when the conversation is in another language: DONE
- If NO → do the remaining work now (call tools / write the fix / clean up). Whatever you write in this case IS shown to the user; the DONE token never is.

{{closing}}</system-reminder>`,
});

const SELF_VERIFY_CLOSING_CODE = definePrompt({
  id: "finishing.self-verify.closing-code",
  group: GROUP,
  label: "Self-verify closing — code changed",
  channel: "reminder",
  where: "Substituted into `{{closing}}` of the self-verify rung when the turn edited source files.",
  placeholders: ["files"],
  text: `You changed code this turn ({{files}}). "Fully handled" includes SETTLED: either the change was observed doing what it was supposed to do — executed against the real thing, not merely compiled, re-read, reasoned about, or agreed with by a stand-in you wrote yourself — or you told the user plainly which parts you could not run and what stays unverified. Either of those is done. Reporting a verification you did not actually perform is not.`,
});

const SELF_VERIFY_CLOSING_PLAIN = definePrompt({
  id: "finishing.self-verify.closing-plain",
  group: GROUP,
  label: "Self-verify closing — no code changed",
  channel: "reminder",
  where: "Substituted into `{{closing}}` of the self-verify rung on a turn that changed no source files.",
  text: "Judge only against the query itself — never invent verification rituals (builds, tests) it did not ask for.",
});

/**
 * The rung's text, or undefined when it has been switched off.
 *
 * Emptying the prompt has to cancel the whole round, not send a blank message:
 * the caller pays a full inference round either way, and that round is the cost
 * the operator was trying to remove.
 */
export function selfVerifyText(changedCode: string[]): string | undefined {
  const closing = changedCode.length > 0
    ? renderPrompt(SELF_VERIFY_CLOSING_CODE, { files: fileList(changedCode) })
    : promptText(SELF_VERIFY_CLOSING_PLAIN);
  const text = renderPrompt(SELF_VERIFY, { closing });
  return text.trim() === "" ? undefined : text;
}
