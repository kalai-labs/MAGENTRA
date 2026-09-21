/**
 * `mid-run-steering-both-stances` — typing while the agent is working.
 *
 * WHY THIS KIND. The feature is defined by a RACE: the frontend saw a busy
 * turn and sent `steer_message`, and by the time the engine reads it the turn
 * may or may not still be running. Both outcomes are correct and they are
 * different — join the turn, or become the next one. A scripted provider ends
 * its turn when the script says so, which makes the race an arrangement rather
 * than a race, and the stance that is hardest to reach (the turn genuinely
 * still streaming) is the one the arrangement fakes best.
 *
 * WHAT IS ASSERTED. The stance actually taken, from observables that cannot be
 * both: how many turns started, whether the engine announced steering, and
 * whether the text arrived in the conversation wrapped as a mid-run addition
 * or as an ordinary user message. The transcript is what distinguishes those
 * last two, because neither is an event.
 *
 * THE INVARIANT'S OTHER TWO CLAUSES — re-arming self-verify and refunding
 * pivots — are NOT asserted here, and not faked. Both require steering to land
 * in a specific window inside the turn (after the first end-attempt; after a
 * pivot has been spent), and a real endpoint gives no way to hold the turn at
 * that point. Reaching for one would mean scripting the provider, which is the
 * scaffold this kind exists to avoid. `self-verify-rung` proves the rung fires
 * once per turn; that steering re-arms it is named here as unproven rather
 * than quietly counted.
 */

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "mid-run-steering-both-stances";

/** Verbatim from the record. */
const INVARIANT =
  "steer_message joins a running turn at its next message boundary, re-arms self-verify and refunds pivots; when idle it becomes a normal user turn.";

/** Distinctive, so its presence in the transcript is never a coincidence. */
const STEER_TEXT = "Also mention the word PERIWINKLE-42 somewhere in your answer.";

abstract class SteeringTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
  }
}

/* ---- stance one: the turn is still running -------------------------------- */

class SteeringJoinsTheRunningTurn extends SteeringTest {
  readonly id = "text-sent-while-a-turn-runs-joins-that-turn-instead-of-starting-a-second";
  readonly whyItExists =
    "if steering started a turn of its own it would meet the busy guard and be refused outright — the user's correction would vanish with a '⏳ busy' notice while the agent carried on doing the thing they were trying to stop";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({
      type: "user_message",
      text: "Write a numbered list counting from 1 to 200, one number per line. Do not stop early.",
    });

    // Steer only once the turn is demonstrably live, so this test really is
    // exercising the running-turn stance and not racing into the idle one.
    await this.waitForEvent(t.signal, "text_delta", "the turn to be streaming");
    this.send({ type: "steer_message", text: STEER_TEXT });

    const notice = await this.waitForEvent(t.signal, "command_output", "the steering notice", (e) =>
      e.text.includes("steering"),
    );
    t.assert.match(notice.text, /joins the running turn/, "the engine must tell the user their text was taken as steering");

    await this.settle();

    t.assert.equal(
      this.eventsOfType("turn_started").length,
      1,
      "steering must join the turn already running, never open a second one",
    );

    const transcript = this.transcriptRaw();
    t.assert.ok(transcript.includes(STEER_TEXT), "the steering text must reach the conversation");
    t.assert.ok(
      transcript.includes("The user adds, mid-run"),
      "it must arrive labelled as a mid-run addition — dropped in bare it reads as the user having started a new request",
    );
  }
}

/* ---- stance two: the turn already ended ----------------------------------- */

class SteeringAnIdleSessionIsAnOrdinaryTurn extends SteeringTest {
  readonly id = "text-sent-when-the-turn-has-already-ended-becomes-a-normal-user-turn";
  readonly whyItExists =
    "the frontend decides to steer from a busy flag it read a moment earlier, so this stance is reached on every turn that finishes during the user's keystroke; a steer that required a running turn would silently discard those messages and the user would watch their sentence disappear";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // Nothing is running: the engine must treat this exactly as a user message.
    this.send({ type: "steer_message", text: "Reply with the single word ALIVE and nothing else." });

    // WAIT FOR THE TURN, do not settle straight into the assertion. The steer
    // path describes any images before deciding busy-or-idle, so `send()`
    // returns with the decision still pending and `idle()` can resolve on an
    // engine that has not started the turn yet. The first draft of this test
    // asserted 33ms after the send and read zero turns — a race in the test,
    // not a dropped message.
    await this.waitForEvent(t.signal, "turn_started", "the steering text to become a turn of its own");
    await this.settle();

    t.assert.equal(
      this.eventsOfType("turn_started").length,
      1,
      "with no turn to join, steering must start one rather than being dropped",
    );
    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn");
    t.assert.equal(
      this.eventsOfType("command_output").filter((e) => e.text.includes("steering")).length,
      0,
      "nothing was steered, so nothing may claim it was — the notice is how the user tells the two stances apart",
    );
    t.assert.ok(
      !this.transcriptRaw().includes("The user adds, mid-run"),
      "an ordinary user turn must not be wrapped as a mid-run addition",
    );
  }
}

registerFeatureTests(new SteeringJoinsTheRunningTurn(), new SteeringAnIdleSessionIsAnOrdinaryTurn());
