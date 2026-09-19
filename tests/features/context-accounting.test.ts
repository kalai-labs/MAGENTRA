/**
 * `context-accounting`.
 *
 * `contextTokens` is B(t): how full the model's window is RIGHT NOW — the
 * whole INPUT of the most recent conversational request, fresh plus
 * cache-write plus cache-read. It is a snapshot, not a running total, and the
 * reply is not part of it. Summing usage over rounds, or adding output, gives
 * a "context" figure with no relation to the window: compaction fires at the
 * wrong moment and the meter counts toward a limit the conversation has
 * already passed. And because a subagent is a DIFFERENT conversation sharing
 * the same ledger, its small prompt must never overwrite the root's window.
 *
 * `pure` + `fs`, and the record said `pure`. Items 1–4 are `inputTokensOf`
 * and `SessionStats`, both functions of the usage records they are fed, and
 * both reachable by import — they stay `pure`. Item 5 says "in a Session tree
 * driven by a FakeProvider": a subagent only exists when the real `Session`
 * spawns one through the real `Agent` tool, which needs a real Engine on a
 * real workspace, so that one item is `fs` (`lib/scriptedEngine.ts`, the
 * repo's own scripted provider as the only double). Re-declared 2026-09-20.
 *
 * HOW ITEM 5 IS OBSERVED. `Session` is not exported in a shape a test can
 * drive directly, and a child's `turn_finished` is swallowed by
 * `emitFromChild`, so the root's window is read where the frontend reads it:
 * the `context_update` frames emitted WHILE the child runs (a child reports
 * `stats.contextTokens`, i.e. the root's figure, deliberately — see
 * `Session.streamAssistantTurn`), and the `turn_finished` that closes the
 * turn. The same frame's `usage` is the cumulative T_turn, which DOES include
 * the child's tokens — that is what makes the assertion sharp: the subagent
 * really ran and really billed, and the window still did not move to it.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SessionStats } from "@magentra/core";
import { inputTokensOf, type CoreEvent, type Usage } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "context-accounting";

/** Verbatim from the record. */
const INVARIANT =
  "contextTokens is the last request's whole INPUT, point-in-time: it never accumulates and never includes output.";

/** A full four-class usage record, spelled out so no field is defaulted by accident. */
function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): Usage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

abstract class AccountingTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheWindowIsTheWholeInputAndOnlyTheInput extends AccountingTest {
  readonly id = "inputtokensof-adds-the-three-input-classes-and-excludes-output";
  readonly whyItExists =
    "reading inputTokens alone reported a near-empty window on a nearly-full conversation, because with prompt caching most of the prompt arrives as cacheRead; adding outputTokens made the opposite error and pushed the figure past the real window";

  override run(t: TestRun): void {
    t.assert.equal(
      inputTokensOf({ inputTokens: 100, cacheWriteTokens: 20, cacheReadTokens: 300, outputTokens: 999 }),
      420,
      "100 + 20 + 300; the 999 generated tokens are not in the window",
    );
    // Each class on its own, so a dropped term cannot hide behind the others.
    t.assert.equal(inputTokensOf(usage(100, 999)), 100, "fresh input alone");
    t.assert.equal(inputTokensOf(usage(0, 999, 300)), 300, "a fully cached prompt still fills the window");
    t.assert.equal(inputTokensOf(usage(0, 999, 0, 20)), 20, "cache WRITE occupies the window too — it is prompt that was sent");
    t.assert.equal(inputTokensOf(usage(0, 0)), 0);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ItReplacesRatherThanAccumulates extends AccountingTest {
  readonly id = "a-second-response-replaces-the-context-figure-instead-of-adding-to-it";
  readonly whyItExists =
    "a ten-round turn re-sends a similar prompt ten times, and a ledger that summed them reported a window ten times its real size — the meter hit the limit while the conversation was comfortably small, and compaction fired on every turn";

  override run(t: TestRun): void {
    const stats = new SessionStats(0);
    t.assert.equal(stats.contextTokens, 0, "nothing measured yet");

    const first = usage(1000, 40, 200, 50);
    stats.recordResponse("m", first, 100);
    t.assert.equal(stats.contextTokens, inputTokensOf(first), "the first response's whole input");
    t.assert.equal(stats.contextTokens, 1250);

    const second = usage(1400, 60, 100, 0);
    stats.recordResponse("m", second, 100);
    t.assert.equal(stats.contextTokens, inputTokensOf(second), "the LAST request's input, not the sum");
    t.assert.equal(stats.contextTokens, 1500);
    t.assert.notEqual(stats.contextTokens, inputTokensOf(first) + inputTokensOf(second), "1250 + 1500 is not a window size");

    // And it follows the window DOWN, which is what compaction depends on.
    const third = usage(300, 10);
    stats.recordResponse("m", third, 100);
    t.assert.equal(stats.contextTokens, 300, "a smaller prompt means a smaller window, not a larger total");

    // Usage, by contrast, is exactly the running total — the two quantities
    // live side by side and must not be confused for one another.
    t.assert.deepEqual(stats.totalUsage(), usage(2700, 110, 300, 50), "usage accumulates; context does not");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ZeroMeansNotMeasured extends AccountingTest {
  readonly id = "an-all-zero-usage-leaves-the-last-known-context-in-place";
  readonly whyItExists =
    "some endpoints omit usage on very large prompts, which arrives as all zeros; adopting it collapsed the window to 0, so the next turn believed the context was empty, never compacted, and overflowed the provider";

  override run(t: TestRun): void {
    const stats = new SessionStats(0);
    stats.observeContext(usage(900, 5, 100));
    t.assert.equal(stats.contextTokens, 1000);

    stats.observeContext(usage(0, 0, 0, 0));
    t.assert.equal(stats.contextTokens, 1000, "zero means 'not measured', never 'the context emptied'");

    // Output-only usage is the same case: nothing about the INPUT was reported.
    stats.observeContext(usage(0, 4321));
    t.assert.equal(stats.contextTokens, 1000, "a usage record with output but no input measures no window at all");

    // A real measurement still lands, in either direction.
    stats.observeContext(usage(1, 0));
    t.assert.equal(stats.contextTokens, 1, "and one measured token is a measurement");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnAuxiliaryPromptSpendsButDoesNotMeasure extends AccountingTest {
  readonly id = "a-non-conversational-call-banks-its-usage-without-touching-the-context-figure";
  readonly whyItExists =
    "auto-naming and the compaction summarizer send a tiny private prompt that never sits in the window; letting them measure it made the meter report a few hundred tokens for a nearly-full conversation, and the summarizer's own call reset the figure it had just been run to fix";

  override run(t: TestRun): void {
    const stats = new SessionStats(0);
    stats.recordResponse("coder", usage(5000, 100, 1000), 400);
    t.assert.equal(stats.contextTokens, 6000, "the conversation's window");

    const aux = usage(80, 12);
    stats.recordResponse("summarizer", aux, 90, false);
    t.assert.equal(stats.contextTokens, 6000, "the auxiliary prompt did not become the window");
    t.assert.deepEqual(stats.byModel.get("summarizer"), aux, "but it IS real spend, banked under its own model");
    t.assert.deepEqual(stats.byModel.get("coder"), usage(5000, 100, 1000), "and the conversation's model is untouched by it");
    t.assert.equal(stats.apiMs, 490, "its API time counts too");

    // A LARGER auxiliary prompt must not move the figure either — the rule is
    // the flag, not the size.
    stats.recordResponse("summarizer", usage(99_000, 1), 10, false);
    t.assert.equal(stats.contextTokens, 6000, "still the conversation's window, not the summarizer's");
    t.assert.equal(stats.totalUsage().inputTokens, 5000 + 80 + 99_000, "every call is in the ledger");
  }
}

/* ---- checklist 5 — fs ------------------------------------------------ */

class ASubagentsWindowNeverOverwritesTheRoots extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-subagents-response-banks-its-usage-without-moving-the-root-sessions-context";
  readonly whyItExists =
    "a subagent starts a fresh conversation with a tiny prompt, and it shares the orchestrator's ledger; when its response measured the shared context figure, the meter dropped to a few dozen tokens mid-turn and the root's nearly-full window was reported as almost empty";

  override readonly timeoutMs: number = 90_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-context-");
    mkdirSync(join(workspace, ".magentra"), { recursive: true });

    // Three model calls, in the order the tree makes them: the root asks for a
    // subagent, the subagent answers, the root finishes. The root's two calls
    // measure a large window; the subagent's measures a tiny one.
    const engine = await startScriptedEngine({
      workspace,
      turns: [
        {
          text: "delegating",
          toolCalls: [{ name: "Agent", input: { description: "probe the tree", prompt: "Report what you find.", subagent_type: "explore" } }],
          usage: { inputTokens: 4000, outputTokens: 12 },
        },
        { text: "the subagent's report", usage: { inputTokens: 50, outputTokens: 4 } },
        { text: "done", usage: { inputTokens: 7000, outputTokens: 9 } },
      ],
    });
    this.#engine = engine;

    const outcome = await engine.runTurn("delegate something");
    t.assert.deepEqual(outcome.errors, [], "the turn must not have died on a short script");
    t.assert.equal(outcome.stopReason, "end_turn");
    t.assert.equal(engine.provider.requests.length, 3, "exactly three model calls: root, child, root");

    // The subagent really ran.
    const spawned = outcome.events.findIndex((e) => e.type === "agent_spawned");
    const finished = outcome.events.findIndex((e) => e.type === "agent_finished");
    t.assert.notEqual(spawned, -1, "the Agent tool spawned a real child Session");
    t.assert.ok(finished > spawned, "and it finished");
    const report = outcome.toolResults.find((e) => e.tool === "Agent");
    t.assert.equal(report?.isError ?? true, false, `the Agent tool must have succeeded: ${report?.resultPreview ?? "no Agent call finished"}`);

    // While it ran, every window figure pushed to the frontend was the ROOT's
    // last measurement — never the child's 50.
    const duringChild = outcome.events
      .slice(spawned, finished)
      .filter((e): e is Extract<CoreEvent, { type: "context_update" }> => e.type === "context_update");
    t.assert.ok(duringChild.length > 0, "the child's own stream reports the window, so there must be at least one frame");
    for (const update of duringChild) {
      t.assert.equal(update.contextTokens, 4000, "a subagent reports the ROOT's window, not its own prompt");
    }

    // And when the turn closes, the figure is the root's LAST request — not the
    // child's, and not any sum.
    const end = outcome.events.find((e): e is Extract<CoreEvent, { type: "turn_finished" }> => e.type === "turn_finished");
    t.assert.notEqual(end, undefined);
    t.assert.equal(end!.contextTokens, 7000, "the root's last request's whole input");

    // The sharp part: the child's tokens ARE in the turn's cumulative usage, so
    // the ledger did see them — the window simply does not follow them.
    t.assert.equal(end!.usage.inputTokens, 4000 + 50 + 7000, "T_turn includes every call the tree made, the subagent's included");
    t.assert.equal(end!.usage.outputTokens, 12 + 4 + 9, "and its output is part of the turn's deliberation total");
    t.assert.notEqual(end!.contextTokens, end!.usage.inputTokens, "the window is not the turn's billed input");
    t.assert.notEqual(end!.contextTokens, 50, "and it is certainly not the subagent's prompt");
  }
}

registerFeatureTests(
  new TheWindowIsTheWholeInputAndOnlyTheInput(),
  new ItReplacesRatherThanAccumulates(),
  new ZeroMeansNotMeasured(),
  new AnAuxiliaryPromptSpendsButDoesNotMeasure(),
  new ASubagentsWindowNeverOverwritesTheRoots(),
);
