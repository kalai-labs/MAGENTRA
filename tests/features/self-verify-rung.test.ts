/**
 * `self-verify-rung` — the hidden end-check OVERDRIVE runs before a turn stops.
 *
 * WHY THIS KIND. The rung exists because an autonomous run has no user
 * checkpoint: the model says "I think I'm done", and something has to ask it
 * whether that is true before the turn closes. A scripted provider answers that
 * question with whatever the script says, so the interesting half — that a real
 * model's "DONE" is believed and its anything-else is revealed and acted on —
 * is the half a fake cannot reach.
 *
 * WHERE THE PROOF LIVES. Not in the reply. The rung is a HIDDEN message: it is
 * injected into the conversation and its answer is buffered rather than
 * streamed, so by design nothing about it appears in what the user sees. The
 * transcript is where the engine writes it down, and that is what these tests
 * read. The user-visible side is asserted as an ABSENCE — the word DONE must
 * never reach the chat — which is the failure this feature would actually show.
 *
 * THE THREE TESTS ARE A TRIANGLE, deliberately. One turn that must fire the
 * rung, and two that must not (no OVERDRIVE; no tool calls). Without the
 * negatives, a rung that fired on every turn would pass the positive and be
 * wrong in the two places that cost a round trip for nothing.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "self-verify-rung";

/** Verbatim from the record. */
const INVARIANT =
  "The first clean end-attempt injects the self-check once per turn; a silent DONE ends the turn with one visible reply.";

/** The literal `finishing.ts` injects. Matching it is how the transcript is read. */
const SELF_CHECK = "Internal self-check";

abstract class SelfVerifyTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
    writeFileSync(join(dir, "data.txt"), "alpha\nbeta\ngamma\n");
  }

  /** How many times the rung was injected into this session's conversation. */
  protected selfCheckCount(): number {
    return this.transcriptRecords().filter((record) => JSON.stringify(record).includes(SELF_CHECK)).length;
  }
}

/* ---- checklist 2 --------------------------------------------------------- */

class TheRungFiresOnceAndDoneStaysHidden extends SelfVerifyTest {
  readonly id = "in-overdrive-a-turn-with-tool-calls-is-self-checked-once-and-never-shows-the-done";
  readonly whyItExists =
    "streaming the check's reply would put a bare 'DONE' in the chat after every autonomous turn, and firing the rung on every end-attempt instead of the first would multiply the round trips of the one mode that has no user to notice the cost";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "set_overdrive", enabled: true });
    this.send({
      type: "user_message",
      text: "Read the file data.txt in the current directory and tell me how many lines it has. Then stop.",
    });
    await this.settle();

    t.assert.ok(
      this.eventsOfType("tool_call_finished").length >= 1,
      "the rung only arms on a turn that made a tool call, so this turn must have made one",
    );
    t.assert.equal(
      this.selfCheckCount(),
      1,
      "the self-check must be injected exactly once per turn — not zero times, and not once per end-attempt",
    );

    // The user-visible side. The check's answer is buffered, so a DONE that
    // reached the chat means the buffering broke.
    const visible = this.visibleText();
    t.assert.ok(
      !/(^|\s)\**DONE\**\.?\s*$/m.test(visible.trim()),
      `the buffered DONE must never be shown to the user. Visible text ended: ${JSON.stringify(visible.trim().slice(-200))}`,
    );
    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn");
  }
}

/* ---- checklist 4, first half --------------------------------------------- */

class NoRungWithoutOverdrive extends SelfVerifyTest {
  readonly id = "with-overdrive-off-a-turn-with-tool-calls-is-never-self-checked";
  readonly whyItExists =
    "the rung is OVERDRIVE's substitute for a user checkpoint; firing it in the attended stance would bill an extra model call on every ordinary tool turn, for a verification the user sitting there is already doing";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // OVERDRIVE deliberately untouched — off is the default.
    this.send({
      type: "user_message",
      text: "Read the file data.txt in the current directory and tell me how many lines it has. Then stop.",
    });
    await this.settle();

    t.assert.ok(this.eventsOfType("tool_call_finished").length >= 1, "the turn must have made a tool call");
    t.assert.equal(this.selfCheckCount(), 0, "the attended stance must not inject the self-check");
    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn");
  }
}

/* ---- checklist 4, second half -------------------------------------------- */

class NoRungWithoutToolCalls extends SelfVerifyTest {
  readonly id = "in-overdrive-a-turn-that-called-no-tool-is-never-self-checked";
  readonly whyItExists =
    "a turn that only answered a question has nothing to verify — there is no work to have left half-done — so a rung that fired anyway would double the cost of every conversational message in autonomous mode";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "set_overdrive", enabled: true });
    this.send({ type: "user_message", text: "What is 2 + 2? Answer with the number only. Do not use any tool." });
    await this.settle();

    t.assert.equal(
      this.eventsOfType("tool_call_started").length,
      0,
      "this turn must make no tool call, or it is not testing the no-tool-call branch",
    );
    t.assert.equal(this.selfCheckCount(), 0, "with no tool calls there is nothing to self-check");
  }
}

registerFeatureTests(new TheRungFiresOnceAndDoneStaysHidden(), new NoRungWithoutOverdrive(), new NoRungWithoutToolCalls());
