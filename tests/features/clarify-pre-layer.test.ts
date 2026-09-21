/**
 * `clarify-pre-layer` — the round that happens BEFORE the turn.
 *
 * WHY THIS KIND, AND WHY IT IS THE CLEAREST CASE FOR IT. The pre-layer is a
 * JUDGEMENT made by a model: given one incoming request, should the agent ask
 * shape-defining questions or just start? A scripted provider cannot be wrong
 * about that, so it cannot be right about it either — handing `FakeProvider` a
 * `{"clarify": true}` and watching the engine raise a card proves the engine
 * can read JSON. The feature is whether an open-ended request and a concrete
 * one are told apart, and only a real judge can be asked.
 *
 * WHAT IS ASSERTED. Never the wording of a question. The observables are:
 * whether a `question_request` was raised AT ALL, that it arrived BEFORE any
 * tool call (the whole point of a PRE-layer), and that the off switch is
 * obeyed. The third is deterministic regardless of the judge's opinion, which
 * is why it is the one that guards the setting.
 *
 * TWO CHECKLIST ITEMS ARE NOT HERE, AND ARE NOT FAKED. Items 3 and 4 need a
 * scripted `{clarify: false}` verdict and a scripted garbage reply, to prove
 * the fail-open path. A real judge cannot be ordered to emit malformed JSON,
 * and stubbing one here would be the scaffold this kind exists to avoid;
 * a-to-do.txt names both as blocked rather than dropping them quietly. What
 * CAN be proved about fail-open is proved: `clarify: false` disables the layer
 * entirely, and no request ever hangs waiting on it.
 */

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "clarify-pre-layer";

/** Verbatim from the record. */
const INVARIANT = "The clarify pre-layer runs before the turn when settings.clarify is on.";

abstract class ClarifyTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 --------------------------------------------------------- */

class AnOpenEndedRequestAsksBeforeWorking extends ClarifyTest {
  readonly id = "an-open-ended-request-raises-its-questions-before-any-tool-runs";
  readonly whyItExists =
    "if the pre-layer ran after the first tool round instead of before it, the agent would have already chosen a stack and written files by the time it asked what the user wanted — the questions would be theatre, and the work they were meant to shape would be waste";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // Answer the round so the turn can proceed; WHAT is answered is irrelevant
    // to this test, only that the round came first.
    this.answerQuestions((req) => Object.fromEntries(req.questions.map((_q, i) => [`q:${i}`, ["Other"]])));

    this.send({
      type: "user_message",
      text: "Build me a game.",
    });

    await this.waitForEvent(t.signal, "question_request", "the clarify round");

    // ORDER is the claim. Everything the engine emitted up to the card must
    // contain no tool call: the layer is a PRE-layer or it is nothing.
    const upToCard = this.events.slice(
      0,
      this.events.findIndex((e) => e.type === "question_request"),
    );
    t.assert.equal(
      upToCard.filter((e) => e.type === "tool_call_started").length,
      0,
      "no tool may run before the clarifying questions are asked",
    );
    t.assert.ok(
      upToCard.some((e) => e.type === "command_output" && e.text.includes("open-ended request")),
      "the engine must say why the turn paused, or a question card appears from nowhere",
    );

    this.send({ type: "interrupt" });
    await this.settle();
  }
}

/* ---- checklist 2 --------------------------------------------------------- */

class AConcreteRequestJustStarts extends ClarifyTest {
  readonly id = "a-concrete-request-is-never-clarified";
  readonly whyItExists =
    "a pre-layer that asked on every message would put a question card in front of 'read this file and tell me what it does' — friction on the common case is how a helpful feature becomes one users switch off, and it would cost an extra model round on every single turn";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // No handler: if a round opens, settle() fails and names it. That is the
    // assertion, made structurally rather than by counting after the fact.
    this.send({
      type: "user_message",
      text: "Use the Write tool to create a file named note.txt containing the single word HELLO. Then stop.",
    });
    await this.settle();

    t.assert.equal(
      this.eventsOfType("question_request").length,
      0,
      "a request naming its target and its content leaves nothing to clarify",
    );
    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn", "the turn ran rather than pausing");
  }
}

/* ---- checklist 6 --------------------------------------------------------- */

class TheOffSwitchIsObeyed extends ClarifyTest {
  readonly id = "clarify-false-disables-the-layer-for-a-request-that-would-have-triggered-it";
  readonly whyItExists =
    "the setting is the escape hatch for anyone who finds the round costly or wrong; a layer that consulted the judge anyway would still bill the extra call and still stall the turn, and the setting would be a lie the user could not detect";

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // A handler IS installed here, and the distinction it protects is the point
    // of this test. With the layer off, the model is still free to reach for
    // the AskUserQuestion TOOL on an open-ended request — that is its own
    // judgement inside the turn, not the pre-layer, and the first draft of this
    // test failed by treating the two as one thing. The setting governs the
    // pre-layer only, so the assertion has to name the pre-layer only.
    this.answerQuestions((req) => Object.fromEntries(req.questions.map((_q, i) => [`q:${i}`, ["Other"]])));

    // The SAME shape of request that raised a pre-layer round above, bounded so
    // the turn cannot run away: the judge never sees this message (it is switched
    // off), so the bound cannot affect the verdict being asserted — and without
    // it the model spent 106s of a 180s budget actually building the game.
    this.send({
      type: "user_message",
      text: "Build me a game. Reply with a one-sentence plan and nothing else. Do not create any files.",
    });
    await this.settle();

    t.assert.equal(
      this.eventsOfType("command_output").filter((e) => e.text.includes("open-ended request")).length,
      0,
      "with clarify off the pre-layer must not announce itself, because it must not have run",
    );

    // Anything that DID ask came from inside the turn, through the tool, after
    // the turn had started — never from a layer in front of it.
    const firstTurn = this.events.findIndex((e) => e.type === "turn_started");
    t.assert.ok(firstTurn >= 0, "the turn must have started rather than stalling in a layer that was switched off");
    for (const [i, event] of this.events.entries()) {
      if (event.type !== "question_request") continue;
      t.assert.ok(
        i > firstTurn,
        "a question raised BEFORE turn_started could only be the pre-layer, which this setting switched off",
      );
    }
  }
}

registerFeatureTests(new AnOpenEndedRequestAsksBeforeWorking(), new AConcreteRequestJustStarts(), new TheOffSwitchIsObeyed());
