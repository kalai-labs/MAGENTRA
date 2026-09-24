/**
 * `honest-gap-outranks-a-manufactured-green`.
 *
 * Every finishing-rung text names "I could not run this here, and here is what
 * stays unverified" as a COMPLETE and correct ending, and points at confirming
 * the contract where the behaviour itself cannot be reached. That is not
 * politeness. A rung that demanded a green result, applied to a dependency this
 * machine cannot execute, does not produce evidence: it makes standing the
 * dependency in the cheapest way to satisfy the rung, and the agent then watches
 * its own assumption agree with itself. The manufactured green is the exact
 * failure the floor exists to catch.
 *
 * `pure` + `fs`, and the record said `pure`. Re-declared 2026-09-20.
 *
 * WHY NOT ALL PURE. The checklist calls `runtimeEvidenceText()` and
 * `selfVerifyText()`. Neither is reachable: `runtime/finishing.ts` is not
 * re-exported by `engine/core/src/index.ts`, and `@magentra/core` ships one
 * `"."` export, so the module is private to the package. Items 1–4 are claims
 * about the WORDS, and the words are observable through `promptCatalog()` in
 * `@magentra/protocol` — `definePrompt` registers each of the seven finishing
 * prompts when the engine module loads, and `defaultText` is the committed
 * text, unaffected by any override file this machine holds. Item 5 is a claim
 * about a TURN, so it runs a real Engine on a scripted provider.
 *
 * ITEM 4 IS A NEGATIVE, AND THE LIST IS THE TEST. "Does not demand success"
 * cannot be asserted in general, so it is asserted as a list of the phrasings
 * that would demand it, checked against every one of the seven texts — the
 * whole family, not just the two the checklist names, because the clause that
 * would reintroduce the demand is as likely to land in the stand-in clause or a
 * vision clause as in the rung itself.
 *
 * Nothing here asserts that the scripted provider returned what it was told to
 * return: item 5's assertions are about the events the real Engine emitted and
 * the history the real Session built.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptCatalog, type PromptEntry } from "@magentra/protocol";
import type { CoreEvent } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "honest-gap-outranks-a-manufactured-green";

/** Verbatim from the record. */
const INVARIANT =
  "Naming what could not be run and what stays unverified is a FULLY correct ending — the rung must never manufacture a green.";

/** Every text the finishing rungs can put in front of the model. */
const FINISHING_PROMPTS = [
  "finishing.runtime-evidence",
  "finishing.vision-on",
  "finishing.vision-off",
  "finishing.double-clause",
  "finishing.self-verify",
  "finishing.self-verify.closing-code",
  "finishing.self-verify.closing-plain",
] as const;

/**
 * Wordings that would turn a reminder into a demand for a passing result. Each
 * one is a way of saying "come back green", and any of them is enough to make
 * mocking the dependency the cheapest way out.
 */
const DEMANDS_A_PASS = [
  "must pass",
  "until the tests pass",
  "until it passes",
  "make it pass",
  "make sure it passes",
  "ensure it passes",
  "all tests pass",
  "should pass",
  "get it green",
  "until it is green",
] as const;

/** The sentence only the runtime-evidence rung says. */
const EVIDENCE_MARKER = "did not run a single command";

function shippedPrompt(id: string): PromptEntry {
  const entry = promptCatalog().find((p) => p.id === id);
  if (entry === undefined) {
    throw new Error(`no prompt "${id}" is registered — the engine's finishing module did not load`);
  }
  return entry;
}

function userTexts(messages: readonly Msg[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")));
}

/* ---- checklist 1–4 — pure, the shipped text --------------------------- */

abstract class ShippedTextTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class TheReminderNamesTheGapAsACompleteAnswer extends ShippedTextTest {
  readonly id = "the-runtime-evidence-rung-says-in-its-own-words-that-an-unrunnable-change-may-be-reported-and-left";
  readonly whyItExists =
    "the closing paragraph was trimmed as filler, and the reminder then read as 'go and produce a result' — so a change needing a device this machine does not have came back as a mock of the device and a passing check against it";

  override run(t: TestRun): void {
    const text = shippedPrompt("finishing.runtime-evidence").defaultText;

    t.assert.match(text, /STOP HERE AND SAY SO/, "the way out is stated in the imperative the rest of the rung uses");
    t.assert.match(text, /it needs a device, a credential or a service you do not have/, "and it names the case it is for");
    t.assert.match(text, /Name the closest thing you did run, name what stays unverified/);
    t.assert.match(text, /That is a complete and correct answer to this reminder/, "complete: the rung does not come back for more");
    t.assert.match(text, /Nothing here asks you to end with a passing check/, "said outright, so it cannot be read as understatement");
    t.assert.match(
      text,
      /worth more than a green result you had to manufacture/,
      "the ranking the record's invariant is about, in the text itself",
    );
  }
}

class WhereBehaviourIsUnreachableTheContractIsTheEvidence extends ShippedTextTest {
  readonly id = "the-rung-points-at-the-contract-as-real-evidence-when-the-behaviour-cannot-be-executed";
  readonly whyItExists =
    "the reminder offered only two endings — run it or say you could not — so the cheap middle route stayed invisible and the agent guessed the signature of the thing it could not call, then encoded the guess into a stand-in and checked it";

  override run(t: TestRun): void {
    const text = shippedPrompt("finishing.runtime-evidence").defaultText;

    t.assert.match(text, /you can still usually confirm its CONTRACT/);
    t.assert.match(text, /print its signature or docstring/, "the cheapest real observation is spelled out");
    t.assert.match(text, /check the type of what it returns, read the source you are calling/);
    t.assert.match(
      text,
      /guessing the contract and then encoding the guess into a stand-in is not/,
      "and the failure mode it replaces is named, so the two are not confusable",
    );

    // The stand-in clause is the second half of the same argument: it is the
    // text a turn gets when it DID run something and what it ran was its own
    // double, and it has to offer the same honest route.
    const double = shippedPrompt("finishing.double-clause").defaultText;
    t.assert.match(double, /say where each replaced contract came from/);
    t.assert.match(double, /if the answer is "I assumed it", that is the thing to fix, not the code/);
    t.assert.match(double, /your check was agreeing with the bug/, "a green against your own stand-in is named as the failure, not the finish");
  }
}

class TheSelfCheckAcceptsTheStatedGap extends ShippedTextTest {
  readonly id = "the-self-verify-closing-counts-a-plainly-stated-gap-as-done";
  readonly whyItExists =
    "the closing accepted only 'observed doing what it was supposed to do', so the one answer left to a turn that could not run its change was to claim a verification it had not performed — the rung produced the lie it was added to prevent";

  override run(t: TestRun): void {
    const code = shippedPrompt("finishing.self-verify.closing-code").defaultText;

    t.assert.match(
      code,
      /you told the user plainly which parts you could not run and what stays unverified/,
      "the second of the two endings the closing accepts",
    );
    t.assert.match(code, /Either of those is done\./, "and they are ranked equal — 'either', not 'failing that'");
    t.assert.match(
      code,
      /Reporting a verification you did not actually perform is not\./,
      "with the one ending that is NOT done named, so the gap is the cheaper honest route",
    );
  }
}

class NoFinishingTextDemandsAPass extends ShippedTextTest {
  readonly id = "not-one-of-the-seven-finishing-texts-asks-the-model-to-come-back-green";
  readonly whyItExists =
    "a sharpening pass added 'and make sure it passes' to the rung, which made standing the dependency in the cheapest way to satisfy it — the reminder that exists to catch a false success started asking for one";

  override run(t: TestRun): void {
    const seen: string[] = [];
    for (const id of FINISHING_PROMPTS) {
      const text = shippedPrompt(id).defaultText.toLowerCase();
      seen.push(id);
      for (const demand of DEMANDS_A_PASS) {
        t.assert.equal(text.includes(demand), false, `${id} must not say "${demand}" — that is a demand for a green result`);
      }
    }
    t.assert.deepEqual(seen, [...FINISHING_PROMPTS], "every finishing text was scanned, not just the two the checklist names");

    // Texts added to the finishing rungs later (the browser reminder, the
    // self-check's symptom and hedge clauses) are held to the same rule: the
    // scan covers every registered finishing.* prompt, not only the seven named.
    const later = promptCatalog().filter((p) => p.id.startsWith("finishing.") && !(FINISHING_PROMPTS as readonly string[]).includes(p.id));
    t.assert.ok(later.length >= 3, `the later finishing texts are registered too (${later.map((p) => p.id).join(", ")})`);
    for (const entry of later) {
      const text = entry.defaultText.toLowerCase();
      for (const demand of DEMANDS_A_PASS) {
        t.assert.equal(text.includes(demand), false, `${entry.id} must not say "${demand}" — that is a demand for a green result`);
      }
    }

    // The rung DOES talk about passing — twice, and both times to deny that a
    // pass is proof. That is the distinction the list above cannot express.
    const evidence = shippedPrompt("finishing.runtime-evidence").defaultText;
    t.assert.match(evidence, /passing it is NOT evidence/, "the fast gate's pass is denied as proof");
    const double = shippedPrompt("finishing.double-clause").defaultText;
    t.assert.match(double, /A passing check against your own stand-in proves your code is self-consistent and nothing more/);
  }
}

/* ---- checklist 5 — fs, through a real Engine -------------------------- */

class AnHonestGapEndsTheTurn extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-reply-that-states-what-could-not-be-run-ends-the-turn-with-no-second-reminder";
  readonly whyItExists =
    "the rung treated the honest answer as a non-answer: it fired again on the next attempt to end the turn, so a change that genuinely could not be executed here looped the same reminder at a full round trip each time until the model invented a result to escape it";

  /** A real Engine boots and runs one turn of three rounds. */
  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    const dir = this.#workspace;
    this.#workspace = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = mkdtempSync(join(tmpdir(), "magentra-honest-gap-"));
    this.#workspace = workspace;
    const target = join(workspace, "src", "device.ts");

    /** What the model answers the rung with: the ending the texts call complete. */
    const HONEST =
      "I cannot run this here — it talks to a serial device this machine does not have. " +
      "I confirmed the exported signature instead; the behaviour against real hardware stays unverified.";

    const engine = await startScriptedEngine({
      workspace,
      turns: [
        {
          toolCalls: [
            { id: "w1", name: "Write", input: { file_path: target, content: "export function open(port: string): boolean {\n  return port.length > 0;\n}\n" } },
          ],
        },
        { text: "the driver is written", stopReason: "end_turn" },
        { text: HONEST, stopReason: "end_turn" },
      ],
    });
    this.#engine = engine;

    const turn = await engine.runTurn("write the serial driver");

    // The rung fired: this turn is the one the feature is about.
    const reminders = userTexts(engine.provider.requests[2]?.messages ?? []).filter((x) => x.includes(EVIDENCE_MARKER));
    t.assert.equal(reminders.length, 1, "the evidence rung fired once, so the honest reply is an answer TO it");

    // And the honest answer was accepted, in every sense the engine has.
    t.assert.deepEqual([...turn.errors], [], "nothing failed — in particular the script was never asked for a fourth turn");
    t.assert.equal(turn.stopReason, "end_turn", "the turn ended where the model ended it; the rung reminds, it does not block");
    t.assert.equal(engine.provider.requests.length, 3, "three model calls — the honest reply bought no further round");
    t.assert.equal(
      turn.events.some((e) => e.type === "permission_request"),
      false,
      "nothing was put to the user: the gap is not an escalation",
    );

    // The user actually receives the honest sentence — it is the turn's reply,
    // not something swallowed as rung bookkeeping.
    const streamed = turn.events
      .filter((e): e is Extract<CoreEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    t.assert.equal(streamed.includes("stays unverified"), true, "the statement of what could not be run reaches the user");

    const history = engine.provider.requests[2]?.messages ?? [];
    const assistants = history.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1];
    const lastText = (last?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    t.assert.equal(lastText.includes("stays unverified"), true, "and it is what the conversation ends on");
    t.assert.equal(
      userTexts(history).filter((x) => x.includes(EVIDENCE_MARKER)).length,
      1,
      "still exactly one reminder after the turn finished — the gap was not answered with the same demand again",
    );
  }
}

registerFeatureTests(
  new TheReminderNamesTheGapAsACompleteAnswer(),
  new WhereBehaviourIsUnreachableTheContractIsTheEvidence(),
  new TheSelfCheckAcceptsTheStatedGap(),
  new NoFinishingTextDemandsAPass(),
  new AnHonestGapEndsTheTurn(),
);
