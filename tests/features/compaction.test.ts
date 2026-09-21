/**
 * `compaction` — summarizing the oldest span when the window fills.
 *
 * WHY THIS KIND, AND IT IS THE STRONGEST CASE IN THE SET. Compaction throws
 * conversation away and keeps a summary of it. Whether the mechanism fires,
 * replaces the right span and resets the counter is structural — but whether
 * the session can still DO ITS WORK afterwards depends entirely on what a real
 * summarizer chose to keep, and that is the only question anyone actually cares
 * about. A scripted summarizer returns the string the script holds, so a green
 * test against one proves the engine can substitute a string it was handed. The
 * feature is whether the agent still knows what it needed to know.
 *
 * HOW THE THRESHOLD IS REACHED WITHOUT A MILLION TOKENS. `set_compact_limit`
 * is a real frontend frame that can only LOWER the engine's own limit. So the
 * test lowers it to a few thousand tokens and the ordinary conversation crosses
 * it — the same code path a long session takes, reached in two turns instead of
 * two hundred.
 *
 * CHECKLIST ITEMS 1, 2 AND 6 ARE NOT HERE. They need a scripted summarizer and
 * a forced usage figure, to pin the summarizer's own sizing and the exact span
 * boundary. a-to-do.txt names them as unable to be expressed against a real
 * endpoint; they are left blocked rather than faked.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { LlmTest } from "../lib/llmTest.ts";

const FEATURE = "compaction";

/** Verbatim from the record. */
const INVARIANT = "Crossing the threshold summarizes the oldest span, replaces it, and resets the context.";

/** Established in the span that gets compacted away, asked for after. */
const CODE_WORD = "MARIGOLD-8821";

/** Enough prose to push an ordinary exchange past a lowered limit. */
const FILLER = Array.from(
  { length: 240 },
  (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog while the slow green turtle watches from the riverbank.`,
).join("\n");

abstract class CompactionTest extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
    writeFileSync(join(dir, "notes.txt"), `${FILLER}\n\nThe project code word is ${CODE_WORD}.\n`);
  }

  /**
   * Lower the ceiling, fill the window, and then give the history enough
   * MESSAGES for there to be an oldest span at all.
   *
   * BOTH HALVES ARE NECESSARY, and the first draft of this test had only the
   * first. Auto-compaction keeps the most recent six messages and summarizes
   * what is in front of them, so `splitIdx = messages.length - 6` and a
   * two-turn conversation has `splitIdx <= 0` — nothing to compact, returns
   * false, silently. Measured: the window was at 18,226 tokens against a 4,000
   * limit, `contextWarn` was true, and nothing compacted, because a full
   * window is only half the condition.
   *
   * One read turn is 4 messages; each short turn adds 2. The third short turn
   * pushes the count past 6 and the head becomes non-empty.
   */
  protected async fillTheWindow(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "set_compact_limit", limit: 4000 });
    this.send({
      type: "user_message",
      text: "Read the whole file notes.txt in the current directory and tell me the project code word it contains.",
    });
    await this.settle();
    t.assert.ok(this.eventsOfType("tool_call_finished").length >= 1, "the file must actually have been read into the context");

    for (const question of ["What is 2 + 2? Answer with the number only.", "What is 3 + 3? Answer with the number only."]) {
      this.send({ type: "user_message", text: question });
      await this.settle();
    }
  }

  /** The auto-compaction notices this session emitted. */
  protected compactionNotices(): string[] {
    return this.eventsOfType("command_output")
      .map((e) => e.text)
      .filter((text) => text.includes("Auto-compacted"));
  }
}

/* ---- checklist 3 — it fires, and says so ---------------------------------- */

class CrossingTheLimitCompacts extends CompactionTest {
  readonly id = "crossing-the-lowered-limit-replaces-the-oldest-span-with-a-summary-and-says-so";
  readonly whyItExists =
    "a compaction that ran silently looks to the user exactly like an agent that quietly forgot the conversation, and one that never ran at all ends the session in a provider error about context length — the notice and the transcript record are the only two places either failure is visible";

  override async run(t: TestRun): Promise<void> {
    await this.fillTheWindow(t);
    this.send({ type: "user_message", text: "What is 4 + 4? Answer with the number only." });
    await this.settle();

    const notice = this.compactionNotices();
    t.assert.ok(
      notice.length >= 1,
      `compaction must announce itself; notices seen: ${this.eventsOfType("command_output").map((e) => e.text).join(" | ").slice(0, 400)}`,
    );
    t.assert.match(
      notice[0]!,
      /auto-compact limit/,
      "the notice must name WHY it happened — a user who lowered the limit needs to know that is what they are seeing",
    );

    // AT LEAST once, not exactly once, and the difference is honest rather
    // than lax: the limit here is deliberately far below any real one, so the
    // rebuilt window can re-cross it immediately and compact again. Pinning
    // "once" would be pinning an artefact of the test's own setup.
    const compactions = this.transcriptRecords().filter((r) => r["kind"] === "compaction");
    t.assert.ok(compactions.length >= 1, "the transcript must record the compaction");
    t.assert.ok(
      typeof compactions[0]?.["replacedCount"] === "number" && (compactions[0]["replacedCount"] as number) > 0,
      "the record must say how many messages the summary replaced, or nothing can audit what was thrown away",
    );
    t.assert.ok(
      String(compactions[0]?.["summary"] ?? "").length > 0,
      "the replacement must carry an actual summary — an empty one is history deleted, not compacted",
    );
  }
}

/* ---- checklist 4 — the reset, and the history it leaves behind ------------ */

class TheCompactedHistoryStaysUsable extends CompactionTest {
  readonly id = "compaction-re-estimates-the-window-and-leaves-a-history-the-provider-still-accepts";
  readonly whyItExists =
    "the tail must never open with a tool_result whose tool_use was summarized away — every provider rejects that history, so the session is bricked from the next message on; and a reset that reported ~0 would disarm the compaction safety until a response re-measured, letting the window overflow for real";

  override async run(t: TestRun): Promise<void> {
    await this.fillTheWindow(t);
    this.send({ type: "user_message", text: "What is 4 + 4? Answer with the number only." });
    await this.settle();
    t.assert.ok(this.compactionNotices().length >= 1, "this test is only meaningful on a turn that actually compacted");

    // THE RESET IS AN ESTIMATE, NOT A COMPARISON, and the first draft of this
    // test assumed otherwise. It compared the post-compaction figure against
    // the pre-compaction one and failed twice — "was 18328, is 18422", then
    // "it was 18340, the reset reported 22088". Both were the test's error.
    // `stats.contextTokens` before compaction is what the PROVIDER reported as
    // its last input; the figure after is `estimateContextNow()`, the engine's
    // own local estimate of the rebuilt window. They are different instruments,
    // so "smaller than" is not a claim the engine makes or could keep. What it
    // does promise, in the code and in its comment, is that the reset is a
    // fresh estimate and explicitly NOT zero.
    const noticeAt = this.events.findIndex((e) => e.type === "command_output" && e.text.includes("Auto-compacted"));
    t.assert.ok(noticeAt > 0, "the compaction must have announced itself");
    // A reverse scan rather than `findLastIndex`: the tests' tsconfig targets a
    // lib older than es2023, and widening it for one call would change every
    // test in the suite.
    let resetAt = -1;
    for (let i = noticeAt - 1; i >= 0; i--) {
      if (this.events[i]!.type === "context_update") {
        resetAt = i;
        break;
      }
    }
    t.assert.ok(resetAt >= 0, "compaction must push a fresh context figure of its own — the meter has no turn_finished to wait for");
    const reset = (this.events[resetAt] as Extract<CoreEvent, { type: "context_update" }>).contextTokens;
    t.assert.ok(
      reset > 0,
      "the reset must be a fresh estimate of the compacted window, never zero — a ~0 reading would disarm compaction until the next response re-measured",
    );

    // THE HISTORY ITSELF. If the summary had swallowed a tool_use and left its
    // tool_result opening the tail, the provider would reject the very next
    // request. A turn that completes cleanly after compaction is the only proof
    // available from outside that the span was cut on a safe boundary.
    const before = this.eventsOfType("turn_finished").length;
    this.send({ type: "user_message", text: "Reply with the single word STILLHERE and nothing else." });
    await this.settle();

    const after = this.eventsOfType("turn_finished");
    t.assert.equal(after.length, before + 1, "the session must still accept a turn after its history was rewritten");
    t.assert.equal(
      after.at(-1)?.stopReason,
      "end_turn",
      "the post-compaction turn must end cleanly — a rejected history surfaces here as an error stopReason",
    );
    t.assert.equal(
      this.eventsOfType("error").length,
      0,
      "no provider error may follow compaction; one here means the tail was cut through a tool pair",
    );
  }
}

/* ---- checklist 5 — the half only a real summarizer can answer -------------- */

class TheSummaryKeepsWhatTheSessionNeeded extends CompactionTest {
  readonly id = "after-compaction-the-session-still-knows-what-the-compacted-span-established";
  readonly whyItExists =
    "compaction that fires, records and resets perfectly is still a bug if the summary dropped the thing the work depended on: the agent carries on confidently with a hole where the requirement was, and neither the notice nor the transcript record shows anything wrong";

  override async run(t: TestRun): Promise<void> {
    await this.fillTheWindow(t);
    this.send({ type: "user_message", text: "What is 4 + 4? Answer with the number only." });
    await this.settle();
    t.assert.ok(this.compactionNotices().length >= 1, "this test is only meaningful on a session that actually compacted");

    // The file is not named, so a model whose summary lost the code word cannot
    // recover it by reading — which is the point.
    this.send({
      type: "user_message",
      text: "Without using any tool, what is the project code word I asked you about earlier?",
    });
    await this.settle();

    t.assert.ok(
      this.visibleText().includes(CODE_WORD),
      `the summary must have kept what the session needed. Reply was: ${JSON.stringify(this.visibleText().slice(-300))}`,
    );
  }
}

registerFeatureTests(new CrossingTheLimitCompacts(), new TheCompactedHistoryStaysUsable(), new TheSummaryKeepsWhatTheSessionNeeded());
