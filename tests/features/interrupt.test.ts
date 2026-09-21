/**
 * `interrupt` — the hard stop, proved against a real model.
 *
 * WHY THIS KIND. The record declares `llm` alone and the checklist is written
 * against `FakeProvider`. What the stop button has to do is cut something that
 * is genuinely in flight: a provider stream mid-token, a tool round mid-call, a
 * question round nobody is going to answer. A scripted provider yields on
 * demand, so "the abort arrived while it was streaming" is arranged rather than
 * observed — and the one failure this feature exists to prevent (tokens still
 * burning after the user pressed stop) is exactly the one arranging it hides.
 *
 * WHAT MAKES THESE DETERMINISTIC. Not timing. Each test waits for a REAL
 * observable that proves the engine is mid-flight — the first `text_delta`, the
 * `question_request` — and only then interrupts. So the abort always lands on a
 * live turn, on a fast endpoint and a slow one alike.
 *
 * CHECKLIST ITEM 3 IS NOT HERE. It interrupts a parent while a foreground
 * SUBAGENT is mid-turn. Subagent behaviour is deliberately out of scope for
 * this pass — `subagent-spawn` and `tool-agent` carry it and are left for a
 * later version — so the item is named rather than half-proved here.
 */

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "interrupt";

/** Verbatim from the record. */
const INVARIANT = "An interrupt stops a running turn promptly, including pending question rounds.";

abstract class InterruptTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Every test here sends a concrete instruction; the pre-layer would only add a round trip. */
  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
  }
}

/* ---- checklist 1 + 2 ----------------------------------------------------- */

class ARunningTurnStopsAborted extends InterruptTest {
  readonly id = "an-interrupt-mid-stream-ends-the-turn-aborted-rather-than-rejecting";
  readonly whyItExists =
    "if interrupt rejected instead of resolving, the engine's turn promise would go unhandled and the next message would meet a session still marked busy — the stop button would work once and then wedge the workspace";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({
      type: "user_message",
      text: "Write a numbered list counting from 1 to 400. Put each number on its own line. Do not stop early and do not summarise.",
    });

    // Interrupt only once the model is demonstrably mid-stream, so the abort
    // lands on a live turn rather than before one or after one.
    await this.waitForEvent(t.signal, "text_delta", "the model to start streaming");
    this.send({ type: "interrupt" });
    await this.settle();

    const finished = this.eventsOfType("turn_finished");
    t.assert.equal(finished.length, 1, "an interrupted turn still emits exactly one turn_finished");
    t.assert.equal(
      finished[0]?.stopReason,
      "aborted",
      "the turn must end as aborted — an interrupt that reported end_turn would tell the frontend the work completed",
    );

    const stopped = this.eventsOfType("command_output").filter((e) => e.text.includes("⏹"));
    t.assert.equal(stopped[0]?.text, "⏹ stopped: turn.", "the stop must say what it stopped");

    // The session survives the abort: a stop that left `busy` set would refuse
    // the next message, which is the wedge this test is really guarding.
    this.send({ type: "user_message", text: "Reply with the single word ALIVE." });
    await this.settle();
    t.assert.equal(this.eventsOfType("turn_started").length, 2, "the session must accept a turn after being interrupted");
  }
}

/* ---- checklist 4 --------------------------------------------------------- */

class InterruptSettlesAPendingQuestionRound extends InterruptTest {
  readonly id = "an-interrupt-settles-a-question-round-that-is-still-waiting";
  readonly whyItExists =
    "a half-answered question round holds a promise nothing else resolves; before the engine settled it on interrupt, pressing stop on a turn showing a question card left the turn hanging forever with no way back to an idle session";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // Deliberately left open: this test's subject is the round that never gets
    // its cards filled in. See LlmTest.answerQuestions().
    this.answerQuestions(() => undefined);

    this.send({
      type: "user_message",
      text:
        "Use the AskUserQuestion tool to ask me exactly one question: whether I prefer the colour red or blue. " +
        "Offer those two options. Wait for my answer before doing anything else.",
    });

    await this.waitForEvent(t.signal, "question_request", "the model to open a question round");
    this.send({ type: "interrupt" });
    await this.settle();

    const finished = this.eventsOfType("turn_finished");
    t.assert.equal(finished.length, 1, "the turn must finish rather than wait on a card nobody will fill in");
    t.assert.equal(finished[0]?.stopReason, "aborted");
    t.assert.equal(
      this.eventsOfType("question_request").length,
      1,
      "the round must not be re-asked after the interrupt settled it",
    );
  }
}

/* ---- checklist 5 --------------------------------------------------------- */

class InterruptingAnIdleSessionIsHarmless extends InterruptTest {
  readonly id = "interrupting-an-idle-session-says-so-and-does-not-throw";
  readonly whyItExists =
    "a stop button that throws when nothing is running turns a harmless double-press into a fatal error frame, and one that stays silent leaves the user unsure whether the press registered at all";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "interrupt" });

    const note = await this.waitForEvent(t.signal, "command_output", "the idle-interrupt notice", (e) =>
      e.text.includes("⏹"),
    );
    t.assert.equal(note.text, "⏹ nothing was running.", "the notice must distinguish 'nothing to stop' from 'stopped'");
    t.assert.equal(this.eventsOfType("turn_started").length, 0, "no turn may be started by an interrupt");
    t.assert.equal(this.eventsOfType("error").length, 0, "an idle interrupt is not an error");
  }
}

registerFeatureTests(
  new ARunningTurnStopsAborted(),
  new InterruptSettlesAPendingQuestionRound(),
  new InterruptingAnIdleSessionIsHarmless(),
);
