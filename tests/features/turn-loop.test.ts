/**
 * `turn-loop` — the core agent loop, proved against a real model.
 *
 * WHY THIS KIND. The record declares `llm` and nothing else, and the product
 * owner's note on it is explicit: *no mockup or scaffold test for this*. The
 * reason holds up. The checklist as written is phrased against `FakeProvider`
 * ("with a FakeProvider scripted [{thinking, text, toolCalls}]"), and a green
 * run of that proves the engine can replay a script — not that a model's reply
 * drives tool calls, nor that a tool's result reaches the next round in a shape
 * the model can act on. Those two are the whole feature.
 *
 * HOW A REAL-MODEL TEST IS MADE DETERMINISTIC. Never by asserting what the
 * model said. Each test gives the model an unambiguous task and asserts the
 * ENGINE's observable reaction to it: the events it emitted, the files the
 * tools actually wrote, the pairing of ids. The one place a reply is read is
 * checklist 2, and there the assertion is a nonce that exists nowhere but in a
 * file on disk — the model cannot produce it without the tool result having
 * been appended before it was called again, which is precisely the claim.
 *
 * CHECKLIST ITEM 5 IS NOT HERE, AND IS NOT FAKED. Its second half needs
 * `FakeTurn.error` — a provider that throws INSTEAD of streaming, so the turn
 * ends with stopReason 'error'. There is no way to ask a real endpoint for
 * that, and scripting one here would be the scaffold this kind exists to avoid.
 * It is named in a-to-do.txt as blocked rather than quietly dropped. The first
 * half (an unknown tool name yields an isError tool_result and the loop
 * continues) is reachable only by putting a bad call in the model's mouth,
 * which is the same problem.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "turn-loop";

/** Verbatim from the record. */
const INVARIANT = "A user message drives streamed thinking/text, tool calls, and one turn end.";

abstract class TurnLoopTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 --------------------------------------------------------- */

class OneMessageDrivesOneTurn extends TurnLoopTest {
  readonly id = "one-message-runs-a-real-tool-and-ends-the-turn-exactly-once";
  readonly whyItExists =
    "if the loop emitted turn_finished per model call instead of per turn, or never emitted it after a tool round, the frontend would re-enable input mid-turn or never re-enable it at all — and a turn that ended without the tool having run would look identical in the transcript";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({
      type: "user_message",
      text:
        "Use the Write tool to create a file named proof.txt in the current directory. " +
        "Its entire contents must be the single word READY. Create no other file. Then stop.",
    });
    await this.settle();

    const started = this.eventsOfType("turn_started");
    const finished = this.eventsOfType("turn_finished");
    t.assert.equal(started.length, 1, "exactly one turn_started for one user message");
    t.assert.equal(finished.length, 1, "exactly one turn_finished for one user message");
    t.assert.equal(finished[0]?.turnId, started[0]?.turnId, "the finish must name the turn that started");
    t.assert.equal(finished[0]?.stopReason, "end_turn", "a task the model completed ends cleanly, not aborted or errored");

    // The loop ran the model at least twice: once to decide on the call, once
    // after its result. Billed output is the honest witness that it did.
    t.assert.ok((finished[0]?.usage.outputTokens ?? 0) > 0, "turn_finished must carry the tokens the turn actually billed");

    const writes = this.eventsOfType("tool_call_finished").filter((e) => e.tool === "Write");
    t.assert.ok(writes.length >= 1, `the turn must have run the Write tool; tools seen: ${this.eventsOfType("tool_call_finished").map((e) => e.tool).join(", ") || "none"}`);
    t.assert.equal(writes[0]?.isError, false, "the Write must have succeeded");

    // The file is the part no event can fake: the tool really executed.
    const written = readFileSync(join(this.workspace, "proof.txt"), "utf8");
    t.assert.equal(written.trim(), "READY", "the tool call must have actually written the file the model was asked for");
  }
}

/* ---- checklist 2 --------------------------------------------------------- */

class AToolResultReachesTheNextRound extends TurnLoopTest {
  readonly id = "a-tool-result-is-appended-before-the-model-is-called-again";
  readonly whyItExists =
    "if the tool result were appended after the next provider call instead of before it, or paired to the wrong toolUseId, the model would answer the round blind — every read-then-act turn would silently act on nothing, which no event count would reveal";

  /** Exists nowhere but this file. The model can only say it by having read it. */
  static readonly NONCE = "QX7-DELTA-4412-ZK";

  protected override seedWorkspace(dir: string): void {
    writeFileSync(join(dir, "token.txt"), `${AToolResultReachesTheNextRound.NONCE}\n`);
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({
      type: "user_message",
      text: "Read the file token.txt in the current directory and reply with the exact token it contains and nothing else.",
    });
    await this.settle();

    const reads = this.eventsOfType("tool_call_finished").filter((e) => e.tool === "Read");
    t.assert.ok(reads.length >= 1, "the model must have used Read to get the token");

    // THE assertion. The nonce is in no prompt and in no system message; it is
    // in a file. Its presence in the reply is proof that the tool's result was
    // in the conversation by the time the model was called again.
    t.assert.ok(
      this.visibleText().includes(AToolResultReachesTheNextRound.NONCE),
      `the reply must contain the token only the tool result could have supplied. Reply was: ${JSON.stringify(this.visibleText().slice(0, 300))}`,
    );
    t.assert.equal(this.eventsOfType("turn_finished")[0]?.stopReason, "end_turn");
  }
}

/* ---- checklist 3 --------------------------------------------------------- */

class OneTurnAtATime extends TurnLoopTest {
  readonly id = "a-second-message-while-a-turn-runs-is-refused-not-interleaved";
  readonly whyItExists =
    "two turns sharing one session would interleave their tool calls and their transcript writes; the engine refuses the second rather than queueing it, and a regression to queueing would look fine until two turns' messages arrived in one history";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    // `startExclusive` sets `busy` synchronously, so the second frame is
    // guaranteed to meet a busy engine — this race is decided, not hoped for.
    this.send({ type: "user_message", text: "Count from 1 to 20, one number per line." });
    this.send({ type: "user_message", text: "Ignore that and say hello." });

    const refusal = await this.waitForEvent(t.signal, "command_output", "the busy refusal", (e) =>
      e.text.includes("busy"),
    );
    t.assert.match(
      refusal.text,
      /wait for the current turn to finish before sending another message/,
      "the refusal must name what was refused, so the frontend can say so",
    );

    await this.settle();
    t.assert.equal(this.eventsOfType("turn_started").length, 1, "the second message must not have started a turn of its own");
    t.assert.equal(this.eventsOfType("turn_finished").length, 1, "one turn started, one turn finished");
  }
}

registerFeatureTests(new OneMessageDrivesOneTurn(), new AToolResultReachesTheNextRound(), new OneTurnAtATime());
