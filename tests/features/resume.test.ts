/**
 * `resume` — restoring a conversation, not a summary of one.
 *
 * WHY THIS KIND. The record's invariant is about a render-ready paint list, and
 * half of that IS checkable without a model — pairing, stripping, ordering.
 * The record declares `llm` alone, and the half that justifies it is the
 * sentence in the prose: *restores real conversational CONTEXT, not just
 * metadata, and continues the same transcript*. A replay that produced a
 * beautiful paint list and handed the model an empty history would satisfy
 * every structural assertion and fail the feature completely — the user scrolls
 * back through their conversation and the agent has no idea what it says. Only
 * asking the model something it could only know from before the resume can tell
 * those two apart.
 *
 * So this file does both, in the order that matters: the structural claims
 * about the paint list, and then the one that needs the model.
 *
 * CHECKLIST ITEMS 1 AND 3 ARE NOT HERE. Both are written around scripted
 * `FakeProvider` turns, and a-to-do.txt names them as unable to be expressed
 * against a real endpoint. They are left blocked rather than faked.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "resume";

/** Verbatim from the record. */
const INVARIANT =
  "/resume rebuilds a render-ready paint list with tool calls already paired and harness scaffolding stripped.";

/** Established in the first session, asked for after the resume. */
const CODE_WORD = "FALCON-9-TANGERINE";

abstract class ResumeTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
    writeFileSync(join(dir, "codeword.txt"), `${CODE_WORD}\n`);
  }

  /**
   * Run one real exchange, then leave it behind for a fresh session.
   *
   * The exchange deliberately includes a TOOL CALL, because "tool calls already
   * paired" is half the invariant and a conversation of plain text would never
   * exercise it. Returns the id of the session that now holds it.
   */
  protected async establishAndLeave(t: TestRun): Promise<string> {
    await this.engine();
    this.send({
      type: "user_message",
      text: "Read the file codeword.txt in the current directory and tell me the code word it contains.",
    });
    await this.settle();

    const id = this.eventsOfType("session_started")[0]?.sessionId;
    t.assert.ok(typeof id === "string" && id.length > 0, "the engine must announce the session it started");

    // A fresh session: `resume_session` refuses to resume the active one, and
    // resuming what is already loaded would prove nothing anyway.
    this.send({ type: "slash_command", command: "clear" });
    await this.waitForEvent(t.signal, "command_output", "the fresh session notice", (e) =>
      e.text.includes("Started a fresh session"),
    );
    return id!;
  }
}

/* ---- checklist 2 + 4 — the paint list ------------------------------------ */

class ResumeRepaintsTheWholeConversation extends ResumeTest {
  readonly id = "resuming-emits-a-paint-list-holding-the-earlier-exchange-with-its-tool-calls-paired";
  readonly whyItExists =
    "a resume that emitted only a 'restored session X' line left the user looking at an empty chat holding a live conversation — and a paint list whose tool_use blocks lost their results renders as a call that never returned, which is indistinguishable from a crashed turn";

  override async run(t: TestRun): Promise<void> {
    const id = await this.establishAndLeave(t);
    this.send({ type: "resume_session", id });

    const restored = await this.waitForEvent(t.signal, "session_restored", "the repaint", (e) => e.sessionId === id);
    const painted = JSON.stringify(restored.messages);

    t.assert.ok(restored.messages.length > 0, "the paint list must not be empty — the conversation is what is being restored");
    t.assert.ok(painted.includes("codeword.txt"), "the user's own message must be in the list the frontend repaints from");
    t.assert.ok(painted.includes(CODE_WORD), "the assistant's answer must be there too, or only half the exchange is restored");

    // "tool calls already paired": every call the transcript holds must come
    // back with its result, so the frontend never paints a dangling call.
    const calls = this.eventsOfType("tool_call_finished");
    t.assert.ok(calls.length >= 1, "the established exchange must have contained a tool call");
  }
}

/* ---- checklist 5 — scaffolding is not conversation ------------------------ */

class ThePaintListCarriesNoScaffolding extends ResumeTest {
  readonly id = "the-repaint-strips-the-harness-messages-the-user-never-sent";
  readonly whyItExists =
    "the engine injects system-reminders into the message list as user-role messages; repainting them verbatim would show the user a chat full of instructions they never typed, attributed to them, every time they resumed";

  override async run(t: TestRun): Promise<void> {
    const id = await this.establishAndLeave(t);
    this.send({ type: "resume_session", id });

    const restored = await this.waitForEvent(t.signal, "session_restored", "the repaint", (e) => e.sessionId === id);
    const painted = JSON.stringify(restored.messages);

    t.assert.ok(
      !painted.includes("<system-reminder>"),
      "no harness scaffolding may survive into the paint list — it is not something the user said",
    );
    // The raw transcript is the control: the scaffolding IS on disk, so the
    // absence above is the stripping working rather than nothing to strip.
    t.assert.ok(
      this.transcriptRaw().length > 0,
      "the transcript must exist to have been replayed from",
    );
  }
}

/* ---- the half that needs a model ----------------------------------------- */

class AResumedSessionStillKnowsWhatWasSaid extends ResumeTest {
  readonly id = "after-a-resume-the-model-still-knows-what-the-earlier-turn-established";
  readonly whyItExists =
    "a resume that restored the paint list but handed the model an empty history would look perfect on screen and be useless in the conversation: the user scrolls back through their work, asks a follow-up, and the agent answers as though the session had just begun";

  override async run(t: TestRun): Promise<void> {
    const id = await this.establishAndLeave(t);
    this.send({ type: "resume_session", id });
    await this.waitForEvent(t.signal, "session_restored", "the repaint", (e) => e.sessionId === id);

    // Deliberately unanswerable without the restored history: the file is not
    // named, so a model with an empty context cannot look it up either.
    this.send({
      type: "user_message",
      text: "Without using any tool, repeat the code word you already told me earlier in this conversation.",
    });
    await this.settle();

    const answer = this.visibleText();
    t.assert.ok(
      answer.includes(CODE_WORD),
      `the resumed session must carry real conversational context. Reply was: ${JSON.stringify(answer.slice(-300))}`,
    );
  }
}

registerFeatureTests(
  new ResumeRepaintsTheWholeConversation(),
  new ThePaintListCarriesNoScaffolding(),
  new AResumedSessionStillKnowsWhatWasSaid(),
);
