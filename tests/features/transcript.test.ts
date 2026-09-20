/**
 * `transcript`.
 *
 * The transcript is an append-only JSONL file per session: one line per
 * message, permission decision, compaction and meta snapshot. `replay` rebuilds
 * the history by applying compaction records as views — and repairs pairing on
 * the way out, because a provider REJECTS a history in which an assistant
 * `tool_use` has no `tool_result` in the message immediately after it. A crash
 * or an interrupt mid-tool-batch would otherwise poison the session: `/resume`
 * replays the wound on every request, forever.
 *
 * `fs` + `pure`, and the record said `fs`. Checklist items 2 and 3 are
 * `repairToolPairing` as a function of its argument — no file, no env, no
 * process state, so `pure` is the honest kind and a temp directory would buy
 * nothing. Items 1 and 4 write a real JSONL file with the real `Transcript`
 * class and replay it; item 5 runs a real Engine on a scripted provider and
 * reads the file the real Session wrote. Re-declared 2026-09-20.
 *
 * ITEM 5 IS NOT THE SCRIPT THE CHECKLIST NAMES, AND THIS IS THE DEVIATION.
 * The checklist says: "Using a FakeProvider that emits a tool_use then errors".
 * The scripted provider cannot do that. `FakeTurn` (engine/providers/src/fake.ts)
 * has `error?: Error`, and it is thrown INSTEAD of streaming the turn — the
 * fixture has no way to emit a tool_use and then fail within one stream, so the
 * checklist's literal script is unscriptable. The code path the record's WHERE
 * names — session.ts's `catch` around the turn, computing
 * `syntheticToolResults(unansweredToolUseIds(last message))` before recording
 * anything — is reached for real by INTERRUPTING a turn while a tool batch is
 * running: `executeToolCalls` calls `signal.throwIfAborted()` before each
 * sequential call, so an interrupt during the first call throws out of the
 * batch with the assistant's `tool_use` blocks still unanswered, which is
 * exactly the wound the repair exists for. That is what this test does.
 *
 * The ERROR branch of that same catch (`stopReason = "error"`) is NOT covered
 * here, and not faked: a script whose next call is `{ error }` right after a
 * tool batch leaves nothing dangling, because the results were appended before
 * the model was asked again. No honest script reaches it, so it is reported
 * rather than staged.
 *
 * Nothing here asserts that the scripted provider returned what it was told to
 * return. Item 5's assertions are about the transcript FILE the real Session
 * wrote and about the history the real Session sent on the following turn.
 */

import { join } from "node:path";

import { Transcript, repairToolPairing, type TranscriptRecord } from "@magentra/core";
import type { CoreEvent } from "@magentra/protocol";
import type { ContentBlock, Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "transcript";

/** Verbatim from the record. */
const INVARIANT = "Every dangling tool_use gets a tool_result, or the provider rejects the next request and /resume replays the wound forever.";

/** The text `syntheticToolResults` puts in a result that never happened. */
const INTERRUPTED = "(interrupted — this tool call never completed)";

function text(body: string): ContentBlock {
  return { type: "text", text: body };
}

function toolUse(id: string, name = "Bash"): ContentBlock {
  return { type: "tool_use", id, name, input: { command: "ls" } };
}

function toolResult(id: string, body: string): ContentBlock {
  return { type: "tool_result", toolUseId: id, content: body };
}

/** Every unanswered tool_use id in a history, walking each message against the one after it. */
function danglingIn(messages: readonly Msg[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const answered = new Set(
      (messages[i + 1]?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.toolUseId),
    );
    for (const block of msg.content) {
      if (block.type === "tool_use" && !answered.has(block.id)) out.push(block.id);
    }
  }
  return out;
}

/* ---- checklist 2 and 3 — pure ----------------------------------------- */

abstract class PairingTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class APartialBatchIsCompletedInPlace extends PairingTest {
  readonly id = "a-half-answered-tool-batch-gains-the-missing-result-inside-the-same-user-message";
  readonly whyItExists =
    "the missing result was inserted as a NEW user message between the assistant and the real results, which leaves the assistant's tool_use still unanswered by the message right after it — the exact shape every provider rejects";

  override run(t: TestRun): void {
    const history: Msg[] = [
      { role: "user", content: [text("do both")] },
      { role: "assistant", content: [toolUse("A"), toolUse("B")] },
      { role: "user", content: [toolResult("B", "B is done")] },
    ];

    const repaired = repairToolPairing(history);

    t.assert.equal(repaired.length, 3, "no message was inserted — the results all sit in the one answering message");
    const answering = repaired[2]!;
    t.assert.equal(answering.role, "user");
    t.assert.deepEqual(
      answering.content.map((b) => (b.type === "tool_result" ? b.toolUseId : b.type)),
      ["A", "B"],
      "A's synthetic result joins B's real one, in call order",
    );
    const synthetic = answering.content[0]!;
    t.assert.equal(synthetic.type === "tool_result" && synthetic.content, INTERRUPTED);
    t.assert.equal(synthetic.type === "tool_result" && synthetic.isError, true, "a call that never completed is an error, not a blank success");
    t.assert.deepEqual(answering.content[1], toolResult("B", "B is done"), "B's real result is untouched");
    t.assert.deepEqual(danglingIn(repaired), [], "nothing is left unanswered");
  }
}

class AWellPairedHistoryIsReturnedUnchanged extends PairingTest {
  readonly id = "a-history-whose-tool-calls-are-all-answered-comes-back-identical";
  readonly whyItExists =
    "the repair appended a synthetic result to a history that was already sound, so every resumed session grew one bogus '(interrupted)' result per round and the model was told work had failed that had in fact succeeded";

  override run(t: TestRun): void {
    const history: Msg[] = [
      { role: "user", content: [text("go")] },
      { role: "assistant", content: [toolUse("A"), toolUse("B")] },
      { role: "user", content: [toolResult("A", "ok A"), toolResult("B", "ok B")] },
      { role: "assistant", content: [text("both done")] },
    ];
    const before = JSON.parse(JSON.stringify(history)) as Msg[];

    const repaired = repairToolPairing(history);

    t.assert.equal(repaired.length, before.length, "same length");
    t.assert.deepEqual(repaired, before, "same content, block for block");
    t.assert.deepEqual(history, before, "and the argument itself was not mutated");
  }
}

/* ---- checklist 1 and 4 — fs ------------------------------------------- */

abstract class ReplayTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real transcript file, written by the real `Transcript` class, record by record. */
  protected writeTranscript(sessionId: string, records: readonly Parameters<Transcript["append"]>[0][]): string {
    const stateDir = join(this.tempDir("magentra-transcript-"), ".magentra");
    const transcript = new Transcript(stateDir, sessionId);
    for (const record of records) transcript.append(record);
    return transcript.file;
  }
}

class AFileEndingOnAToolBatchReplaysWithItsResults extends ReplayTest {
  readonly id = "a-transcript-that-stops-after-an-unanswered-tool-batch-replays-with-synthetic-results";
  readonly whyItExists =
    "a session killed mid-tool-batch replayed as an assistant tool_use with nothing after it, and /resume sent that history to the provider on every retry — a 400 the user could only escape by abandoning the session";

  override run(t: TestRun): void {
    const file = this.writeTranscript("crashed", [
      { kind: "system_prompt", text: "you are a tool" },
      { kind: "message", message: { role: "user", content: [text("read both files")] } },
      { kind: "message", message: { role: "assistant", content: [text("on it"), toolUse("call_1"), toolUse("call_2")] } },
    ]);

    const { messages } = Transcript.replay(file);

    t.assert.equal(messages.length, 3, "the two stored messages plus the repair");
    const last = messages[2]!;
    t.assert.equal(last.role, "user", "the repair is a user message, which is where tool results live");
    t.assert.equal(last.content.length, 2, "exactly two blocks — one per unanswered call, nothing else");
    t.assert.deepEqual(
      last.content.map((b) => (b.type === "tool_result" ? b.toolUseId : b.type)),
      ["call_1", "call_2"],
      "the ids match the calls that never completed",
    );
    for (const block of last.content) {
      t.assert.equal(block.type, "tool_result");
      t.assert.equal(block.type === "tool_result" && block.isError, true);
      t.assert.equal(block.type === "tool_result" && block.content, INTERRUPTED);
    }
    t.assert.deepEqual(danglingIn(messages), [], "the replayed history is one a provider will accept");
  }
}

class CompactionIsAViewAndMetaIsTheLatest extends ReplayTest {
  readonly id = "replay-applies-a-compaction-record-as-a-summary-plus-the-tail-and-keeps-the-latest-meta";
  readonly whyItExists =
    "replay read the raw message lines and ignored the compaction record, so a resumed session re-sent every message compaction had already paid to remove, and the window overflowed on the first turn back";

  override run(t: TestRun): void {
    const five: Msg[] = [
      { role: "user", content: [text("one")] },
      { role: "assistant", content: [text("two")] },
      { role: "user", content: [text("three")] },
      { role: "assistant", content: [text("four")] },
      { role: "user", content: [text("five")] },
    ];
    const file = this.writeTranscript("compacted", [
      { kind: "meta", data: { model: "old-model", stats: { turns: 1 } } },
      ...five.map((message) => ({ kind: "message" as const, message })),
      { kind: "compaction", replacedCount: 3, summary: "S" },
      { kind: "meta", data: { model: "new-model", stats: { turns: 5 } } },
    ]);

    const { messages, meta } = Transcript.replay(file);

    t.assert.equal(messages.length, 3, "the summary plus the two messages compaction did not replace");
    t.assert.deepEqual(messages[0], { role: "user", content: [text("S")] }, "the summary enters as a user message");
    t.assert.deepEqual(messages[1], five[3], "followed by the tail, in order");
    t.assert.deepEqual(messages[2], five[4]);
    t.assert.deepEqual(meta, { model: "new-model", stats: { turns: 5 } }, "the latest meta record wins over the earlier one");
  }
}

/* ---- checklist 5 — fs, through a real Engine -------------------------- */

class AnInterruptedToolBatchIsRepairedOnDisk extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "an-interrupted-tool-batch-lands-in-the-transcript-already-paired";
  readonly whyItExists =
    "the stop button left the assistant's tool_use blocks unanswered in the transcript, so the very next turn of the SAME live session sent the provider a history it rejects — the wound the record's invariant is about, reproduced without even resuming";

  /** A real Engine boots, runs two turns and is closed; well under the fixture's own 45s turn timeout. */
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-transcript-live-");
    // A tool that blocks on the frontend, so the interrupt has something real
    // to land in the middle of. AskUserQuestion is `permissionClass: "interact"`
    // — not parallel-safe, so the batch runs sequentially — and it waits on
    // `session.askUser`, which the engine's `interrupt` settles. A Bash sleeper
    // reaches the same code path, and is not used: its child process holds the
    // temp workspace's directory handle on Windows past the end of the test,
    // and the kind's teardown removes that directory with no retries.
    const ask = {
      questions: [
        {
          question: "Which way?",
          header: "Route",
          options: [
            { label: "Left", description: "go left" },
            { label: "Right", description: "go right" },
          ],
        },
      ],
    };

    const engine = await startScriptedEngine({
      workspace,
      permissions: "allow_once",
      turns: [
        // One assistant turn, two sequential calls. The interrupt lands while
        // the first is waiting; `executeToolCalls` throws on the second's
        // `signal.throwIfAborted()`, with both tool_use blocks unanswered.
        { toolCalls: [{ id: "call_a", name: "AskUserQuestion", input: ask }, { id: "call_b", name: "AskUserQuestion", input: ask }] },
        { text: "understood" },
      ],
    });
    this.#engine = engine;

    const started = await engine.waitFor((e): e is Extract<CoreEvent, { type: "session_started" }> => e.type === "session_started");
    engine.send({ type: "user_message", text: "ask me twice" });
    await engine.waitFor((e) => e.type === "question_request");
    engine.send({ type: "interrupt" });
    const finished = await engine.waitFor((e): e is Extract<CoreEvent, { type: "turn_finished" }> => e.type === "turn_finished");
    t.assert.equal(finished.stopReason, "aborted", "the turn ended because the user stopped it");

    const file = join(workspace, ".magentra", "sessions", `${started.sessionId}.jsonl`);
    const records = Transcript.read(file);
    const messages = records.filter((r): r is Extract<TranscriptRecord, { kind: "message" }> => r.kind === "message");
    const batchIndex = messages.findIndex((r) => r.message.role === "assistant" && r.message.content.some((b) => b.type === "tool_use"));
    t.assert.notEqual(batchIndex, -1, "the assistant's tool batch was recorded");

    const calls = messages[batchIndex]!.message.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    t.assert.deepEqual(calls, ["call_a", "call_b"], "both calls are in the history");

    const answering = messages[batchIndex + 1];
    t.assert.notEqual(answering, undefined, "the interrupted turn recorded an answering message");
    t.assert.equal(answering!.message.role, "user");
    const results = answering!.message.content.filter((b) => b.type === "tool_result");
    t.assert.deepEqual(results.map((b) => b.toolUseId), ["call_a", "call_b"], "every call got a result");
    for (const block of results) {
      t.assert.equal(block.content, INTERRUPTED);
      t.assert.equal(block.isError, true);
    }
    t.assert.deepEqual(danglingIn(messages.map((r) => r.message)), [], "nothing on disk is left dangling");

    // The claim the invariant actually makes: the NEXT request is one a
    // provider accepts.
    await engine.engine.idle();
    const second = await engine.runTurn("ok");
    t.assert.deepEqual([...second.errors], [], "the second turn ran without an error frame");
    t.assert.equal(engine.provider.requests.length, 2, "exactly two model calls — the batch, and the turn after the interrupt");
    t.assert.deepEqual(danglingIn(engine.provider.requests[1]!.messages), [], "the history the provider was sent has no unanswered tool_use");
  }
}

registerFeatureTests(
  new AFileEndingOnAToolBatchReplaysWithItsResults(),
  new APartialBatchIsCompletedInPlace(),
  new AWellPairedHistoryIsReturnedUnchanged(),
  new CompactionIsAViewAndMetaIsTheLatest(),
  new AnInterruptedToolBatchIsRepairedOnDisk(),
);
