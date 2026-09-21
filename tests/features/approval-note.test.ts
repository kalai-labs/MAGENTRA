/**
 * `approval-note` — the sentence the user types on the permission card.
 *
 * WHY THIS KIND. The note's whole purpose is to change what the model does
 * next: "yes, but use --dry-run first", "no, that is the wrong directory". A
 * scripted provider cannot be steered, so a fake can only prove the string was
 * copied into a message — and a string copied into a message nobody reads is
 * precisely the bug. The record declares `llm` alone, and this is why.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT THE MODEL'S OBEDIENCE. Whether a model
 * complies with "use --dry-run" is a judgement about that model on that day,
 * and a test that turned red because a model chose differently would be
 * reporting nothing about this repository. So the assertion is ARRIVAL: the
 * note must be in the conversation the model was called with, in the round
 * that carried the tool's result, worded so the model knows it came from the
 * user's approval. That is the engine's entire responsibility here, and the
 * transcript is where the engine writes it down.
 *
 * HOW THE CARD IS RAISED AT ALL. The default stance allows everything; two
 * target-shaped guards still ask, and a deletion is one of them. So each test
 * asks for a deletion — the one call shape guaranteed to produce a card
 * without depending on any setting the test would otherwise have to arrange.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "approval-note";

/** Verbatim from the record. */
const INVARIANT = "A note the user attaches while APPROVING must reach the model.";

abstract class ApprovalNoteTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
    writeFileSync(join(dir, "scratch.txt"), "delete me\n");
  }

  /**
   * The one call shape that always raises a card, whatever the stance.
   *
   * ANSWERS ANY FOLLOW-UP QUESTION THE MODEL ASKS, and that is not incidental.
   * A model that has just been refused with a reason may reasonably reach for
   * AskUserQuestion to find out what to do instead — on one full-suite run this
   * test's model asked "scratch.txt is the only copy of the input data, and you
   * declined the direct deletion. What should I do with it?", which is the
   * feature working, not failing. Without a handler the round hangs and
   * `settle()` reports a test that forgot one. What is answered is irrelevant;
   * these tests assert only that the note reached the conversation.
   */
  protected askForTheDeletion(): void {
    this.answerQuestions((req) => Object.fromEntries(req.questions.map((_q, i) => [`q:${i}`, ["Other"]])));
    this.send({
      type: "user_message",
      text: "Use the Bash tool to delete the file scratch.txt in the current directory, with the command: rm scratch.txt",
    });
  }
}

/* ---- the approval half — the record's invariant --------------------------- */

class ANoteOnAnApprovalReachesTheModel extends ApprovalNoteTest {
  readonly id = "a-note-attached-to-an-approval-is-put-into-the-conversation-with-that-rounds-results";
  readonly whyItExists =
    "the deny path already carried its note, so a note on APPROVAL that went nowhere looked like a working feature from the card's side — the user types a condition on their yes, watches the call run, and the model never learns the condition existed";

  /** Distinctive enough that its presence cannot be a coincidence of wording. */
  static readonly NOTE = "Approved, but afterwards create a file named AUDIT-7731.txt recording what you removed.";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.answerPermissions(() => ({ decision: "allow_once", message: ANoteOnAnApprovalReachesTheModel.NOTE }));
    this.askForTheDeletion();
    await this.settle();

    const card = this.eventsOfType("permission_request");
    t.assert.equal(card.length >= 1, true, "the deletion guard must have raised a card, or this test proves nothing");

    // The call really ran — an approval that did not approve would make the
    // note's arrival meaningless.
    t.assert.ok(!existsSync(join(this.workspace, "scratch.txt")), "the approved deletion must actually have happened");

    const transcript = this.transcriptRaw();
    t.assert.ok(
      transcript.includes(ANoteOnAnApprovalReachesTheModel.NOTE),
      "the note's text must be in the conversation the model was called with",
    );
    t.assert.ok(
      transcript.includes("attached a note"),
      "the note must arrive labelled as the user's, not pasted in bare where it reads as the harness talking",
    );
  }
}

/* ---- the denial half, which the same card carries ------------------------- */

class ANoteOnADenialBecomesTheRefusalReason extends ApprovalNoteTest {
  readonly id = "a-note-attached-to-a-denial-becomes-the-reason-the-model-reads";
  readonly whyItExists =
    "a refusal with no reason tells the model only that something was forbidden, so it retries the same call a different way; the note is how the user says why, and dropping it turns one declined call into a loop of them";

  static readonly NOTE = "No — that file is the only copy of the input data.";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.answerPermissions(() => ({ decision: "deny", message: ANoteOnADenialBecomesTheRefusalReason.NOTE }));
    this.askForTheDeletion();
    await this.settle();

    t.assert.ok(this.eventsOfType("permission_request").length >= 1, "the deletion guard must have raised a card");
    t.assert.ok(existsSync(join(this.workspace, "scratch.txt")), "a denied deletion must not have happened");

    const transcript = this.transcriptRaw();
    t.assert.ok(
      transcript.includes(ANoteOnADenialBecomesTheRefusalReason.NOTE),
      "the user's reason must reach the model, or it cannot adjust its approach",
    );
    t.assert.ok(
      transcript.includes("The user declined this destructive tool call"),
      "the refusal must say what kind of refusal it was, so the model does not read it as a tool error to retry",
    );
  }
}

/* ---- the control: no note, nothing invented ------------------------------- */

class AnApprovalWithoutANoteAddsNothing extends ApprovalNoteTest {
  readonly id = "an-approval-with-no-note-puts-no-note-message-into-the-conversation";
  readonly whyItExists =
    "the note rides with the round's results, so an empty or whitespace note that still produced a 'the user attached a note' message would put an instruction with no content in front of the model on every ordinary approval — and it is what proves the message above came from the note rather than from every approval";

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.answerPermissions(() => ({ decision: "allow_once" }));
    this.askForTheDeletion();
    await this.settle();

    t.assert.ok(this.eventsOfType("permission_request").length >= 1, "the deletion guard must have raised a card");
    t.assert.ok(!existsSync(join(this.workspace, "scratch.txt")), "the approved deletion must actually have happened");
    t.assert.ok(
      !this.transcriptRaw().includes("attached a note"),
      "a bare approval must add no note message, or the message means nothing when there is one",
    );
  }
}

registerFeatureTests(
  new ANoteOnAnApprovalReachesTheModel(),
  new ANoteOnADenialBecomesTheRefusalReason(),
  new AnApprovalWithoutANoteAddsNothing(),
);
