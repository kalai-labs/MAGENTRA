/**
 * `reasoning-is-shown-inside-the-output`.
 *
 * Field test 2026-09-23, finding U-10 — the owner's question: "In Claude Code
 * thinking does not increase the output token count; in MAGENTRA it does.
 * Which is correct?" MAGENTRA is: Anthropic and OpenAI both bill reasoning as
 * output. What was missing was the split — one number, "200k out", of which
 * about two thirds was reasoning.
 *
 * `pure` + `net` + `fs` + `ui` + `llm`, as the record declares:
 *   - `pure`: the algebra (`addUsage`, `reasoningPart`).
 *   - `net`: the OpenAI-compatible adapter reading a real server's SSE.
 *   - `fs`: the real engine's estimate when a provider says nothing, and `/session`.
 *   - `ui`: the desktop strip and inspector, fed through the real IPC channel.
 *   - `llm`: whether the configured provider reports the count at all.
 */

import { join } from "node:path";

import { addUsage, emptyUsage, reasoningPart, type CoreEvent, type Usage } from "@magentra/protocol";
import { OpenAICompatProvider, type ProviderEvent } from "@magentra/providers";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { LlmTest } from "../lib/llmTest.ts";
import { NetTest } from "../lib/netTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "reasoning-is-shown-inside-the-output";

/** Verbatim from the record. */
const INVARIANT =
  "The output total keeps its reasoning, and every place that shows the total shows how much of it was reasoning — exact when the provider reports it, estimated when it does not.";

/* ---- checklist 1 — pure ------------------------------------------------ */

class TheAlgebraCarriesThePart extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-reasoning-part-adds-up-keeps-its-estimated-mark-and-prints-only-when-there-is-one";
  readonly whyItExists =
    "a reasoning figure summed outside the output, or invented as 0 for a provider that never reported one, would make the total lie in one direction or the other";

  override run(t: TestRun): void {
    const total = emptyUsage();
    addUsage(total, { inputTokens: 1, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 60 });
    addUsage(total, { inputTokens: 1, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 20, reasoningEstimated: true });
    t.assert.equal(total.outputTokens, 150, "the output total is unchanged by the split");
    t.assert.equal(total.reasoningTokens, 80, "the parts add up");
    t.assert.equal(total.reasoningEstimated, true, "one estimated part makes the sum an estimate");

    const plain = emptyUsage();
    addUsage(plain, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 });
    t.assert.deepEqual(Object.keys(plain).sort(), ["cacheReadTokens", "cacheWriteTokens", "inputTokens", "outputTokens"], "a total that never had reasoning keeps exactly four classes");

    t.assert.equal(reasoningPart({ reasoningTokens: 135_000 }), "reasoning 135k");
    t.assert.equal(reasoningPart({ reasoningTokens: 135_000, reasoningEstimated: true }), "reasoning ~135k");
    t.assert.equal(reasoningPart({}), "", "no figure is invented");
  }
}

/* ---- checklist 2 — net ------------------------------------------------- */

class TheAdapterReadsTheCount extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-openai-adapter-reads-reasoning-tokens-clamps-them-and-adds-nothing-when-absent";
  readonly whyItExists =
    "the adapter read cached_tokens and ignored completion_tokens_details, so a provider that did report its reasoning was shown as one undivided output number";

  async #usageFor(usage: Record<string, unknown>): Promise<Usage> {
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}`,
    ].join("\n") + "\n\ndata: [DONE]\n\n";
    const server = await this.serve((request) =>
      request.url.endsWith("/chat/completions") ? { status: 200, text: body, headers: { "content-type": "text/event-stream" } } : { status: 404, text: "no" },
    );
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({ model: "m", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], maxTokens: 32, signal: new AbortController().signal })) {
      events.push(event);
    }
    const end = events.find((e) => e.type === "message_end");
    if (end === undefined || end.type !== "message_end") throw new Error("the stream never ended");
    return end.usage;
  }

  override async run(t: TestRun): Promise<void> {
    const reported = await this.#usageFor({ prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 } });
    t.assert.equal(reported.outputTokens, 300, "the output total is the provider's completion_tokens");
    t.assert.equal(reported.reasoningTokens, 200, "and its reasoning part is read");
    t.assert.equal(reported.reasoningEstimated, undefined, "a reported count is not an estimate");

    const odd = await this.#usageFor({ prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 80 } });
    t.assert.equal(odd.reasoningTokens, 50, "a part is never larger than its whole");

    const none = await this.#usageFor({ prompt_tokens: 100, completion_tokens: 50 });
    t.assert.equal("reasoningTokens" in none, false, "a provider that reports nothing gets no invented key");
  }
}

/* ---- checklist 3 — fs -------------------------------------------------- */

class TheEngineEstimatesWhatIsNotReported extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "an-unreported-reasoning-part-is-counted-from-the-stream-and-marked-and-a-reported-one-is-kept";
  readonly whyItExists =
    "most OpenAI-compatible gateways send no reasoning count, so without the engine's own split the owner's 135k of reasoning would stay invisible on exactly the provider the field run used";
  override readonly timeoutMs: number = 60_000;

  #engines: ScriptedEngine[] = [];

  override async tearDown(): Promise<void> {
    for (const engine of this.#engines) await engine.close();
  }

  async #turn(usage: Partial<Usage>): Promise<{ finished: Extract<CoreEvent, { type: "turn_finished" }>; live: number[]; report: string }> {
    const engine = await startScriptedEngine({
      workspace: this.tempDir("magentra-reasoning-"),
      turns: [{ thinking: "r".repeat(7_000), text: "done", usage: { outputTokens: 2_500, ...usage } }],
    });
    this.#engines.push(engine);
    const turn = await engine.runTurn("think, then answer");
    if (turn.errors.length > 0) throw new Error(turn.errors.join(" | "));
    const finished = turn.events.find((e): e is Extract<CoreEvent, { type: "turn_finished" }> => e.type === "turn_finished");
    if (!finished) throw new Error("the turn never finished");
    const live = turn.events
      .filter((e): e is Extract<CoreEvent, { type: "context_update" }> => e.type === "context_update")
      .map((e) => e.reasoningTokens ?? 0);
    engine.send({ type: "slash_command", command: "session" });
    const report = await engine.waitFor((e): e is Extract<CoreEvent, { type: "session_report" }> => e.type === "session_report");
    return { finished, live, report: report.text };
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const estimated = await this.#turn({});
    t.assert.equal(estimated.finished.usage.outputTokens, 2_500, "the output total is the provider's");
    t.assert.equal(estimated.finished.usage.reasoningTokens, 2_000, "7,000 streamed reasoning characters count as 2,000 tokens");
    t.assert.equal(estimated.finished.usage.reasoningEstimated, true, "and are marked estimated");
    t.assert.match(estimated.report, /output \(reasoning ~2\.0k\)/, `/session shows the part, marked: ${estimated.report}`);
    t.assert.ok(estimated.live.some((n) => n > 0), "the live counter carried a reasoning part while it streamed");

    const reported = await this.#turn({ reasoningTokens: 1_800 });
    t.assert.equal(reported.finished.usage.reasoningTokens, 1_800, "a count the provider reported is kept exactly");
    t.assert.equal(reported.finished.usage.reasoningEstimated, undefined, "and not marked");
    t.assert.match(reported.report, /output \(reasoning 1\.8k\)/);
  }
}

/* ---- checklist 4 — ui -------------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class TheDesktopShowsThePart extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-desktop-strip-shows-the-estimated-part-and-the-inspector-the-reported-one";
  readonly whyItExists =
    "the strip read '↑ 200k out' for a turn that was two thirds reasoning, and the owner could not tell whether MAGENTRA or Claude Code was counting wrong";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-reasoning-ui-home-");
    const workspace = this.makeTempDir("magentra-reasoning-ui-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor<string>(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the tab id");

    const send = (frames: Record<string, unknown>[]) =>
      app.evaluateInMain(`for (const f of ${JSON.stringify(frames.map((f) => ({ ...f, tabId })))}) win.webContents.send("engine:event", f); return true;`);

    await send([{ type: "turn_started", turnId: "t_1" }, { type: "context_update", contextTokens: 5_000, outputTokens: 12_000, reasoningTokens: 8_100 }]);
    const strip = await this.waitFor<string>(app, `(() => { const el = document.getElementById("nowTokens"); return el && el.textContent.includes("reasoning") ? el.textContent : null; })()`, "the strip's reasoning part");
    t.assert.equal(strip, "↑ 12k out · ~8.1k reasoning", "the live part is shown inside the output, marked as an estimate");

    await send([{ type: "turn_finished", turnId: "t_1", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 135_000 }, contextTokens: 5_000 }]);
    const usage = await this.waitFor<string>(app, `(() => { const el = document.getElementById("inspectorUsage"); return el && el.textContent.includes("135k") ? el.textContent : null; })()`, "the inspector's usage");
    t.assert.match(usage, /200k out · 135k reasoning/, "the reported figure is shown exactly, without the estimate mark");
  }
}

/* ---- checklist 5 — llm ------------------------------------------------- */

class TheProviderTellsOrNot extends LlmTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "on-the-configured-provider-a-turns-reasoning-stays-inside-its-output";
  readonly whyItExists =
    "whether a provider reports its reasoning is a fact about that provider that no scripted test can know, and it decides whether the part the user sees is exact or estimated";

  protected override seedWorkspace(dir: string): void {
    this.patchSettings(dir, { clarify: false });
  }

  override async run(t: TestRun): Promise<void> {
    await this.engine();
    this.send({ type: "user_message", text: "What is 17 times 23? Think it through, then answer with the number only." });
    const finished = await this.waitForEvent(t.signal, "turn_finished", "the turn to finish");
    await this.settle();
    const usage = finished.usage;
    t.diagnostic(
      usage.reasoningTokens === undefined
        ? "this provider streamed no reasoning (or none was counted)"
        : `reasoning ${usage.reasoningTokens} of ${usage.outputTokens} output tokens — ${usage.reasoningEstimated ? "ESTIMATED: the provider does not report the count" : "REPORTED by the provider"}`,
    );
    t.assert.ok(usage.outputTokens > 0, "the turn produced output");
    if (usage.reasoningTokens !== undefined) {
      t.assert.ok(usage.reasoningTokens <= usage.outputTokens, "the reasoning part is inside the output total, never beside it");
    }
  }
}

registerFeatureTests(
  new TheAlgebraCarriesThePart(),
  new TheAdapterReadsTheCount(),
  new TheEngineEstimatesWhatIsNotReported(),
  new TheDesktopShowsThePart(),
  new TheProviderTellsOrNot(),
);
