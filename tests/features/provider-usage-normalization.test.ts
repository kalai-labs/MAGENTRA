/**
 * `provider-usage-normalization`.
 *
 * `Usage` is four DISJOINT classes — fresh input, output, cache read, cache
 * write — and the two wire formats disagree about which. OpenAI-compatible
 * endpoints report `prompt_tokens` as the WHOLE prompt with
 * `prompt_tokens_details.cached_tokens` a SUBSET of it, so the adapter
 * subtracts; Anthropic reports `input_tokens`, `cache_read_input_tokens` and
 * `cache_creation_input_tokens` already disjoint, so they map straight
 * through. Subtracting where nothing overlaps, or failing to subtract where it
 * does, is the same bug twice: the window reads inflated and cached tokens are
 * billed at the full input rate on top of the cache rate.
 *
 * `net`, and the record said `pure`. Re-declared 2026-09-20, and to `net`
 * ALONE: not one of the five items is a function of its inputs, because
 * neither adapter exposes the normalization as anything a test can call.
 * `OpenAICompatProvider.stream` reaches the network with the global `fetch`
 * and takes no fetch parameter; `AnthropicProvider` streams through the
 * `@anthropic-ai/sdk` client it builds in its own constructor. The chunk each
 * one normalizes only exists because a server sent it, so the server is a
 * real one on 127.0.0.1 answering the exact SSE the two real providers speak
 * — the OpenAI `data:`-only stream, and Anthropic's `event:`-tagged one
 * (`message_start` … `message_delta` … `message_stop`), reached at
 * `POST /v1/messages` by the SDK itself. No shape is invented: every field
 * name below is one the adapter reads by name.
 *
 * ONE OBSERVATION ABOUT `message_start`. `AnthropicProvider` yields the SAME
 * `usage` object it later mutates in `message_delta`, so an event kept in an
 * array shows the final output count rather than the zero it carried when it
 * was emitted. The consumer that matters reads it synchronously
 * (`Session.streamAssistantTurn` calls `stats.observeContext(event.usage)` in
 * the `message_start` arm), so this test snapshots inside the loop, which is
 * what that consumer sees, and says so.
 */

import { inputTokensOf, type Usage } from "@magentra/protocol";
import { AnthropicProvider, OpenAICompatProvider, type Provider, type ProviderEvent } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest } from "../lib/netTest.ts";

const FEATURE = "provider-usage-normalization";

/** Verbatim from the record. */
const INVARIANT =
  "OpenAI-compatible prompt_tokens minus cached_tokens yields disjoint classes; Anthropic already reports them disjoint.";

/** The OpenAI-compatible wire: bare `data:` frames, usage on the final chunk, then `[DONE]`. */
function openAiStream(usage: Record<string, unknown>): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

/** The Anthropic wire: every frame carries an `event:` name beside its `data:`. */
function anthropicStream(events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** One Anthropic turn: a text block, with `usage` on `message_start` and `messageDelta` on the delta. */
function anthropicTurn(usage: Record<string, unknown>, messageDelta?: Record<string, unknown>): string {
  return anthropicStream([
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: messageDelta ?? { output_tokens: 0 } },
    { type: "message_stop" },
  ]);
}

/** What one streamed turn reported: every event, plus the `message_start` usage AS EMITTED (see the header). */
interface Streamed {
  readonly events: readonly ProviderEvent[];
  readonly startUsage: Usage | undefined;
  readonly endUsage: Usage;
  readonly urls: readonly string[];
}

abstract class NormalizationTest extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Drain a provider's stream, snapshotting `message_start` in the tick it arrives. */
  protected async drain(provider: Provider, urls: readonly string[]): Promise<Streamed> {
    const events: ProviderEvent[] = [];
    let startUsage: Usage | undefined;
    for await (const event of provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 64,
      signal: new AbortController().signal,
    })) {
      if (event.type === "message_start") startUsage = { ...event.usage };
      events.push(event);
    }
    const end = events.find((e) => e.type === "message_end");
    if (end === undefined || end.type !== "message_end") throw new Error("the stream never reported message_end");
    return { events, startUsage, endUsage: end.usage, urls };
  }

  /** An OpenAI-compatible endpoint answering `body` to every chat completion. */
  protected async openAi(body: string): Promise<Streamed> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "not this endpoint" };
      return { status: 200, text: body, headers: { "content-type": "text/event-stream" } };
    });
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const streamed = await this.drain(provider, []);
    return { ...streamed, urls: server.requests.map((r) => r.url) };
  }

  /** An Anthropic endpoint answering `body`; the SDK finds `/v1/messages` on it itself. */
  protected async anthropic(body: string): Promise<Streamed> {
    const server = await this.serve(() => ({ status: 200, text: body, headers: { "content-type": "text/event-stream" } }));
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: server.url, maxRetries: 0 });
    const streamed = await this.drain(provider, []);
    return { ...streamed, urls: server.requests.map((r) => r.url) };
  }
}

/* ---- checklist 1 — net ----------------------------------------------- */

class TheOpenAiAdapterSubtractsTheCachedSubset extends NormalizationTest {
  readonly id = "prompt-tokens-minus-cached-tokens-is-the-fresh-input-and-the-four-classes-still-sum-to-the-prompt";
  readonly whyItExists =
    "prompt_tokens passed through unchanged counted every cached token twice: a 1,000-token prompt read as 1,800 on the meter, and the 800 cached tokens were billed at the full input rate on top of the cache rate";

  override async run(t: TestRun): Promise<void> {
    const streamed = await this.openAi(
      openAiStream({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }),
    );
    t.assert.deepEqual(streamed.urls, ["/v1/chat/completions"], "the real adapter reached the real endpoint");
    t.assert.deepEqual(
      streamed.endUsage,
      { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 },
      "1000 − 800 fresh, 800 cache read, and an OpenAI-compatible endpoint reports no cache WRITE class at all",
    );
    // The point of subtracting: the classes are disjoint, so they add back up
    // to the whole prompt the server billed. Double-counting would give 1800.
    t.assert.equal(inputTokensOf(streamed.endUsage), 1000, "the three input classes sum to the server's prompt_tokens exactly");
    t.assert.equal(streamed.startUsage, undefined, "an OpenAI-compatible stream reports usage only at the end, so there is no message_start");
  }
}

/* ---- checklist 2 — net ----------------------------------------------- */

class WithoutDetailsTheWholePromptIsFresh extends NormalizationTest {
  readonly id = "an-openai-chunk-with-no-prompt-tokens-details-is-all-fresh-input-and-no-cache-read";
  readonly whyItExists =
    "an endpoint that does not report caching at all (most local servers) has no prompt_tokens_details, and a subtraction against a missing field produced NaN — which then poisoned every total it was added into";

  override async run(t: TestRun): Promise<void> {
    const streamed = await this.openAi(openAiStream({ prompt_tokens: 100, completion_tokens: 7 }));
    t.assert.deepEqual(
      streamed.endUsage,
      { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "no details means nothing was cached: the whole prompt is fresh input",
    );
    t.assert.equal(inputTokensOf(streamed.endUsage), 100, "and the window is still the whole prompt");

    // The same when the field is present but empty, which some gateways send.
    const empty = await this.openAi(openAiStream({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: {} }));
    t.assert.deepEqual(empty.endUsage, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }
}

/* ---- checklist 3 — net ----------------------------------------------- */

class AnOversizedCacheCountClampsAtZero extends NormalizationTest {
  readonly id = "cached-tokens-larger-than-prompt-tokens-clamps-the-fresh-input-to-zero-never-negative";
  readonly whyItExists =
    "a gateway that rounds the two figures independently reported more cached tokens than prompt tokens, and the subtraction produced a negative fresh-input count that the meter rendered and the cost estimate subtracted from the bill";

  override async run(t: TestRun): Promise<void> {
    const streamed = await this.openAi(
      openAiStream({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 } }),
    );
    t.assert.equal(streamed.endUsage.inputTokens, 0, "fresh input is clamped at zero, not −50");
    t.assert.equal(streamed.endUsage.cacheReadTokens, 150, "the cache figure is reported as the server stated it, not silently trimmed");
    t.assert.deepEqual(streamed.endUsage, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 150, cacheWriteTokens: 0 });
    t.assert.equal(inputTokensOf(streamed.endUsage), 150, "so the window reads as the larger of the two, and never as a negative number");
  }
}

/* ---- checklist 4 — net ----------------------------------------------- */

class TheAnthropicClassesPassStraightThrough extends NormalizationTest {
  readonly id = "anthropics-three-input-classes-are-already-disjoint-and-are-not-subtracted";
  readonly whyItExists =
    "applying the OpenAI-compatible subtraction to Anthropic, whose input_tokens already EXCLUDES the cached ones, drove fresh input to zero on every cached turn — the mirror-image bug, and just as invisible because the total still looked plausible";

  override async run(t: TestRun): Promise<void> {
    const streamed = await this.anthropic(
      anthropicTurn({ input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 }),
    );
    t.assert.deepEqual(streamed.urls, ["/v1/messages"], "the real SDK reached the real endpoint");

    const start = streamed.startUsage;
    t.assert.notEqual(start, undefined, "Anthropic reports the whole input context up front, so message_start must carry it");
    t.assert.equal(start?.inputTokens, 120, "input_tokens maps straight through — nothing is subtracted from it");
    t.assert.equal(start?.cacheReadTokens, 900, "cache_read_input_tokens is its own class");
    t.assert.equal(start?.cacheWriteTokens, 30, "cache_creation_input_tokens is the cache WRITE class, which OpenAI-compatible endpoints never report");
    t.assert.equal(start?.outputTokens, 0, "and no output has been generated when message_start arrives");
    t.assert.equal(inputTokensOf(start!), 1050, "the window is 120 + 900 + 30 — the whole prompt, counted once");

    // The event kept in the array shares its `usage` object with message_end,
    // so it is read for the three INPUT classes — the ones this item is about,
    // and the ones the delta never touches — while the output count above comes
    // from the snapshot taken in the tick the event was emitted.
    const kept = streamed.events.find((e) => e.type === "message_start");
    t.assert.equal(kept?.type === "message_start" ? inputTokensOf(kept.usage) : -1, 1050, "and nothing later in the stream moves the input classes");
    t.diagnostic(
      "message_start yields the same usage object message_delta later mutates, so a consumer that stores the event and reads outputTokens afterwards sees the final count; Session.streamAssistantTurn reads it synchronously in the message_start arm, which is what the snapshot above reproduces",
    );
  }
}

/* ---- checklist 5 — net ----------------------------------------------- */

class TheOutputCountArrivesLastAndMovesNothingElse extends NormalizationTest {
  readonly id = "an-anthropic-message-delta-sets-only-the-output-class-and-leaves-the-three-input-classes-alone";
  readonly whyItExists =
    "message_delta reports output_tokens as a running total, and ADDING it instead of assigning it double-counted the reply; a handler that rebuilt the whole usage record there also wiped the cache classes message_start had already reported";

  override async run(t: TestRun): Promise<void> {
    const streamed = await this.anthropic(
      anthropicTurn(
        { input_tokens: 120, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 },
        { output_tokens: 77 },
      ),
    );
    t.assert.deepEqual(
      streamed.endUsage,
      { inputTokens: 120, outputTokens: 77, cacheReadTokens: 900, cacheWriteTokens: 30 },
      "the delta's output_tokens is the final count, and the three input classes are exactly what message_start reported",
    );
    t.assert.equal(inputTokensOf(streamed.endUsage), 1050, "generated output is NOT part of the window: it is still 1050, not 1127");

    const end = streamed.events.find((e) => e.type === "message_end");
    t.assert.equal(end?.type === "message_end" ? end.stopReason : undefined, "end_turn", "the turn ended normally");

    // A missing cache pair on the same wire is zero, not undefined — an absent
    // class must never leak `NaN` into the ledger it is added to.
    const uncached = await this.anthropic(anthropicTurn({ input_tokens: 42, output_tokens: 0 }, { output_tokens: 9 }));
    t.assert.deepEqual(uncached.endUsage, { inputTokens: 42, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 });
    t.assert.equal(inputTokensOf(uncached.endUsage), 42);
  }
}

registerFeatureTests(
  new TheOpenAiAdapterSubtractsTheCachedSubset(),
  new WithoutDetailsTheWholePromptIsFresh(),
  new AnOversizedCacheCountClampsAtZero(),
  new TheAnthropicClassesPassStraightThrough(),
  new TheOutputCountArrivesLastAndMovesNothingElse(),
);
