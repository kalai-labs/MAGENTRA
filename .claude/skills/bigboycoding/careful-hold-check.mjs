#!/usr/bin/env node
// CAREFUL MODE hold invariants, asserted against the BUILT engine.
//
// `npm run build` proves these types line up. It proves nothing about whether
// the hold actually refuses anything — and the hold IS the feature: without it,
// CAREFUL MODE is a polite request that a model in OVERDRIVE is free to ignore
// while it edits the user's repository. engine/* has no unit suite, so this
// stands in for one.
//
//   npm run build && node .claude/skills/bigboycoding/careful-hold-check.mjs

import { PermissionEngine } from "../../../engine/core/dist/runtime/permissions.js";
import {
  SCOUT_TOOLS,
  carefulProposalSpec,
  carefulQuestionsSystem,
  carefulScoutSection,
  classifyCarefulAnswer,
  extractCandidatePaths,
  looksLikeProposal,
  parseCarefulVerdict,
  salvageQuestionObjects,
  CAREFUL_APPROVE_LABEL,
  CAREFUL_CANCEL_LABEL,
} from "../../../engine/core/dist/runtime/careful.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const tool = (name, permissionClass) => ({
  name,
  permissionClass,
  ...(permissionClass === "mutate" ? { isFileEdit: true } : {}),
});

/** A PermissionEngine whose approval callback throws — nothing in a scout phase
 *  may ever reach a user prompt, so a call that asks is itself a failure. */
function freshEngine(rules = { allow: [], deny: [] }) {
  return new PermissionEngine(rules, async () => {
    throw new Error("the hold must never ask the user — it refuses outright");
  });
}

const allow = async (engine, t, subject) =>
  (await engine.check(t, {}, subject, undefined)).allowed;

console.log("\nCAREFUL MODE — hold invariants\n");

// ── The hold refuses everything outside the scout allowlist ──────────────────
{
  const engine = freshEngine();
  engine.setCarefulHold(true);
  for (const name of ["Write", "Edit"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "mutate")), false);
  }
  for (const name of ["Bash", "Monitor", "Workflow", "EnterWorktree"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "execute")), false);
  }
  for (const name of ["WebFetch", "WebSearch"]) {
    check(`held: ${name} refused`, await allow(engine, tool(name, "network")), false);
  }
  // Class "read" is NOT the allowlist: these spawn children or record state.
  for (const name of ["Agent", "CrewRun", "TaskCreate", "AskUserQuestion"]) {
    check(`held: ${name} refused (not a scout tool)`, await allow(engine, tool(name, "read")), false);
  }
  for (const name of SCOUT_TOOLS) {
    check(`held: ${name} allowed`, await allow(engine, tool(name, "read")), true);
  }
}

// ── The hold outranks every grant that would otherwise open the tool ─────────
{
  const engine = freshEngine({ allow: ["Bash", "Write(*)", "Edit(src/a.ts)"], deny: [] });
  engine.setCarefulHold(true);
  check("held: a bare allow rule does not open Bash", await allow(engine, tool("Bash", "execute"), "ls"), false);
  check("held: a wildcard allow rule does not open Write", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  check(
    "held: an exact allow rule does not open Edit",
    await allow(engine, tool("Edit", "mutate"), "src/a.ts"),
    false,
  );
  engine.addSessionAllow("Bash", "*");
  check("held: a session allow does not open Bash", await allow(engine, tool("Bash", "execute"), "ls"), false);
}

// ── OVERDRIVE does not lift the hold. This is the whole point of the mode. ───
{
  const engine = freshEngine();
  engine.setOverdrive(true);
  engine.setCarefulHold(true);
  check("held + OVERDRIVE: Write still refused", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  check("held + OVERDRIVE: Bash still refused", await allow(engine, tool("Bash", "execute"), "rm -rf /"), false);
  check("held + OVERDRIVE: Read still allowed", await allow(engine, tool("Read", "read"), "x.ts"), true);
}

// ── Lifting restores ordinary behaviour ─────────────────────────────────────
{
  const engine = freshEngine();
  engine.setOverdrive(true);
  engine.setCarefulHold(true);
  check("held: Write refused", await allow(engine, tool("Write", "mutate"), "x.ts"), false);
  engine.setCarefulHold(false);
  check("lifted: Write allowed again", await allow(engine, tool("Write", "mutate"), "x.ts"), true);
  check("lifted: Bash allowed again", await allow(engine, tool("Bash", "execute"), "ls"), true);
  check("lifted: isCarefulHeld() false", engine.isCarefulHeld(), false);
}

// ── A user's own deny rule still outranks the hold (it refuses either way) ───
{
  const engine = freshEngine({ allow: [], deny: ["Read(secret.txt)"] });
  engine.setCarefulHold(true);
  check("held: a deny rule still refuses a scout tool", await allow(engine, tool("Read", "read"), "secret.txt"), false);
}

// ── Unheld engines are untouched by any of this ─────────────────────────────
{
  const engine = freshEngine();
  check("unheld: Write allowed", await allow(engine, tool("Write", "mutate"), "x.ts"), true);
  check("unheld: Bash allowed", await allow(engine, tool("Bash", "execute"), "ls"), true);
  check("unheld: isCarefulHeld() false by default", engine.isCarefulHeld(), false);
}

// ── Approval answers classify correctly ─────────────────────────────────────
console.log("");
check("approve label → approve", classifyCarefulAnswer(CAREFUL_APPROVE_LABEL).kind, "approve");
check("cancel label → cancel", classifyCarefulAnswer(CAREFUL_CANCEL_LABEL).kind, "cancel");
check("free text → revise", classifyCarefulAnswer("use a hook instead").kind, "revise");
check("free text carries through", classifyCarefulAnswer("use a hook instead").text, "use a hook instead");
// An unanswered gate must never read as approval.
check("undefined → cancel", classifyCarefulAnswer(undefined).kind, "cancel");
check("empty string → cancel", classifyCarefulAnswer("   ").kind, "cancel");

// ── Predictor verdicts fail open (false), never closed ──────────────────────
console.log("");
check("verdict true", parseCarefulVerdict('{"careful": true}'), true);
check("verdict true with prose around it", parseCarefulVerdict('Sure!\n{"careful": true}\n'), true);
check("verdict false", parseCarefulVerdict('{"careful": false}'), false);
check("malformed json → false", parseCarefulVerdict("{careful: yes"), false);
check("empty → false", parseCarefulVerdict(""), false);
check("non-object json → false", parseCarefulVerdict("[1,2,3]"), false);
check("wrong type → false", parseCarefulVerdict('{"careful": "true"}'), false);

// ── Path claims are extracted from a proposal, noise is not ─────────────────
// Every path a proposal names is a claim about the user's repository, and the
// engine checks each one exists before the user ever sees it. A MISSED path
// lets a hallucinated file through; a FALSE one sends the model correcting
// prose that was already right. Both directions are asserted here.
console.log("");
{
  const paths = (text) => extractCandidatePaths(text).join(",");

  check("full path claimed", paths("touches `engine/core/src/runtime/careful.ts` today"), "engine/core/src/runtime/careful.ts");
  check("bare filename claimed", paths("in `careful.ts`"), "careful.ts");
  check("file:line reduces to the file", paths("see `session.ts:1482`"), "session.ts");
  check("leading ./ normalized away", paths("`./app/main.js`"), "app/main.js");
  check("backslashes normalized", paths("`app\\renderer\\state.js`"), "app/renderer/state.js");
  check("repeats collapse", paths("`a/b.ts` then `a/b.ts`"), "a/b.ts");
  check("directory path claimed", paths("`engine/core/src/`"), "engine/core/src/");

  // Noise that must NOT be reported as a missing file.
  check("bare symbol is not a path", paths("call `GraphQuery` first"), "");
  check("command is not a path", paths("run `npm run build`"), "");
  check("flag is not a path", paths("pass `--force`"), "");
  check("version is not a path", paths("bumped to `0.9.0`"), "");
  check("url is not a path", paths("`https://example.com/x.ts`"), "");
  check("prose outside backticks is ignored", paths("I will edit engine/core/src/x.ts"), "");
  check("empty text yields nothing", paths(""), "");
}

// ── A truncated question round still asks something ─────────────────────────
// The failure that let "I want to improve existing game" reach the scout with
// nothing asked. The model answered correctly and at length; the reply hit the
// token limit, ended mid-string, failed strict JSON parsing, and the whole round
// was read as "ask nothing" — silently, with no banner and no trace. Asking
// three of five questions beats asking none, so the complete objects survive.
console.log("");
{
  const OPT = '{"label":"A","description":"d"},{"label":"B","description":"d"}';
  const q = (name) => `{"question":"${name}?","header":"H","options":[${OPT}],"multiSelect":false}`;
  const names = (raw) => salvageQuestionObjects(raw).map((o) => o.question).join(",");

  check(
    "truncated mid-object: the completed questions survive",
    names(`{"questions": [${q("one")},${q("two")},{"question":"three?","opt`),
    "one?,two?",
  );
  check(
    "truncated with no complete question yields nothing",
    names('{"questions": [{"question":"only'),
    "",
  );
  check("a complete reply salvages identically", names(`{"questions":[${q("one")}]}`), "one?");
  check("the wrapper object is not mistaken for a question", salvageQuestionObjects('{"questions":[]}').length, 0);
  check("option objects are not mistaken for questions", salvageQuestionObjects(`{"x":[${OPT}]}`).length, 0);
  // A brace inside the question's own prose must not close the object early.
  check(
    "a brace inside a string does not end the object",
    names(`{"questions":[{"question":"use {} here?","header":"H","options":[${OPT}]}`),
    "use {} here?",
  );
  check("prose before the JSON is skipped", names(`Sure! {"questions":[${q("one")}`), "one?");
  check("empty input yields nothing", salvageQuestionObjects("").length, 0);
  check("no JSON at all yields nothing", salvageQuestionObjects("I have no questions.").length, 0);
  // Salvage is only for the truncation signature. A `questions` array that
  // parsed is the model's answer, empty or not — the caller must not let a
  // question object quoted in the surrounding prose override a deliberate
  // "nothing to ask".
  check(
    "a closed empty array is an answer, and salvage is not consulted for it",
    salvageQuestionObjects('{"questions": []}').length,
    0,
  );
}

// ── A text-only scout response is recognized as the proposal ────────────────
// The scout carries the proposal format in its own system prompt, so it writes
// the proposal directly instead of being asked for it two round trips later.
// This test is what decides which of the two happened, and it has to work in
// every language, because the headings are written in the user's.
console.log("");
{
  const five = (h) => h.map((t) => `# ${t}\n\ntext\n`).join("\n");
  check(
    "five English headings → proposal",
    looksLikeProposal(five(["Objective", "Solution", "Consequences", "Dependencies", "Unclear"])),
    true,
  );
  check(
    "five Turkish headings → proposal",
    looksLikeProposal(five(["Amac nedir?", "Ne oneriyorum?", "Sonuclar", "Bagimliliklar", "Belirsizler"])),
    true,
  );
  check("four headings still count", looksLikeProposal(five(["a", "b", "c", "d"])), true);
  check("three headings do not", looksLikeProposal(five(["a", "b", "c"])), false);
  check("scout deliberation is not a proposal", looksLikeProposal("I have read game.py. I will propose obstacles."), false);
  check("empty text is not a proposal", looksLikeProposal(""), false);
  check("a markdown list is not a proposal", looksLikeProposal("- one\n- two\n- three\n- four\n- five"), false);
  check("H2s are not H1s", looksLikeProposal(five(["a", "b", "c", "d"]).replace(/^# /gm, "## ")), false);
  check("a hashtag in prose is not a heading", looksLikeProposal("see #1 #2 #3 #4 #5 in the log"), false);
}

// ── The language of the proposal is anchored to the user's own words ────────
// A Turkish repository and an English-speaking user produced a proposal with
// English headings over a Turkish body, and an English phrase copied verbatim
// out of the instructions. The rule is only reliable when the request itself is
// quoted into the prompt — "write in the user's language" alone loses to the
// language the model has just spent a phase reading.
console.log("");
{
  const request = "I want to improve existing game";
  const spec = carefulProposalSpec(request);
  check("the proposal spec quotes the request verbatim", spec.includes(request), true);
  check("the questions layer quotes it too", carefulQuestionsSystem(request).includes(request), true);
  check("the scout section carries the proposal spec", carefulScoutSection(request).includes(spec), true);
  check("the scout section quotes the request", carefulScoutSection(request).includes(request), true);
  // The old spec offered a literal English answer for the dependencies section,
  // and a model writing Turkish pasted it through unchanged.
  check("no English model answer is offered for copying", spec.includes("None — this uses what is already here."), false);
  // Whitespace is normalized so a multi-line request stays one quotable line.
  check(
    "a multi-line request is flattened into the quote",
    carefulProposalSpec("improve\n\n  the game").includes("«improve the game»"),
    true,
  );
  check("a long request is truncated, not dropped", carefulProposalSpec("x".repeat(500)).includes("x".repeat(300)), true);
}

console.log(`\n${failures === 0 ? "all invariants hold" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
