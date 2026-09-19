/**
 * `usage-normalization`.
 *
 * `Usage` splits one response's billed tokens into four DISJOINT classes:
 * fresh input, output, cache read, cache write. OpenAI-compatible servers
 * report it the other way round — `prompt_tokens` is the whole prompt and
 * `cached_tokens` is a subset of it — so the adapter subtracts. Passing
 * prompt_tokens straight through counts every cached token twice: the context
 * meter over-reads, and cached tokens are billed at the full input rate on top
 * of the cache rate.
 *
 * `pure` + `net`, and the record said `pure`. Items 3 and 5 are the protocol's
 * algebra, functions of a `Usage`. Items 1, 2 and 4 are the adapter, and
 * `OpenAICompatProvider` reaches the network with the global `fetch` and takes
 * no fetch parameter — the chunk it normalizes is one a real server sent, so
 * the server is a real one on 127.0.0.1 answering the SSE this test writes.
 * Re-declared 2026-09-19.
 */

import { addUsage, emptyUsage, inputTokensOf, type Usage } from "@magentra/protocol";
import { OpenAICompatProvider, type ProviderEvent } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest, type LocalServer } from "../lib/netTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "usage-normalization";

/** Verbatim from the record. */
const INVARIANT =
  "Input, output, cacheRead and cacheWrite are disjoint and additive, and the OpenAI-compatible adapter subtracts cached_tokens from prompt_tokens.";

/** An SSE body whose final chunk carries `usage`. `terminated` decides whether the last line gets its newline. */
function sseWithUsage(usage: Record<string, unknown>, terminated = true): string {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}`,
  ];
  return terminated ? `${lines.join("\n")}\n\ndata: [DONE]\n\n` : lines.join("\n");
}

abstract class UsageNetTest extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A server that answers every chat request with `body`, and the usage the adapter reported for one call. */
  protected async usageReportedFor(body: string): Promise<{ usage: Usage; server: LocalServer }> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      return { status: 200, text: body, headers: { "content-type": "text/event-stream" } };
    });
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 32,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    const end = events.find((e) => e.type === "message_end");
    if (end === undefined || end.type !== "message_end") throw new Error("the stream never ended");
    return { usage: end.usage, server };
  }
}

/* ---- checklist 1 — net ----------------------------------------------- */

class CachedTokensAreSubtracted extends UsageNetTest {
  readonly id = "the-adapter-subtracts-cached-tokens-from-prompt-tokens";
  readonly whyItExists =
    "prompt_tokens passed straight through counted every cached token twice, so the context meter read 1800 for a 1000-token prompt and the session was priced as if nothing had been cached";

  override async run(t: TestRun): Promise<void> {
    const { usage } = await this.usageReportedFor(
      sseWithUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }),
    );
    t.assert.deepEqual(usage, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
  }
}

/* ---- checklist 2 — net ----------------------------------------------- */

class NoDetailsMeansNoCacheAndNeverNegative extends UsageNetTest {
  readonly id = "without-cache-details-input-is-the-whole-prompt-and-an-oversized-cache-clamps-to-zero";
  readonly whyItExists =
    "a server that reports cached_tokens larger than prompt_tokens (a gateway rounding both) produced a negative fresh-input count that the meter rendered and the cost estimate subtracted";

  override async run(t: TestRun): Promise<void> {
    const plain = await this.usageReportedFor(sseWithUsage({ prompt_tokens: 640, completion_tokens: 7 }));
    t.assert.deepEqual(plain.usage, { inputTokens: 640, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }, "no details → the whole prompt is fresh input");

    const oversized = await this.usageReportedFor(
      sseWithUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 } }),
    );
    t.assert.equal(oversized.usage.inputTokens, 0, "fresh input clamps at zero rather than going negative");
    t.assert.equal(oversized.usage.cacheReadTokens, 150, "the cache figure is reported as the server gave it");
  }
}

/* ---- checklist 3 — pure ---------------------------------------------- */

class TheClassesAreAdditive extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "inputtokensof-a-normalized-record-equals-the-servers-prompt-tokens";
  readonly whyItExists =
    "the context meter must show the whole prompt, and reading inputTokens alone reported a near-empty window whenever caching served most of it";

  override run(t: TestRun): void {
    const normalized: Usage = { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 };
    t.assert.equal(inputTokensOf(normalized), 1000, "fresh + cache read + cache write is the server's prompt_tokens");
    t.assert.equal(inputTokensOf({ inputTokens: 5, outputTokens: 99, cacheReadTokens: 0, cacheWriteTokens: 7 }), 12, "output is NOT part of the context");
    t.assert.equal(inputTokensOf(emptyUsage()), 0);
  }
}

/* ---- checklist 4 — net ----------------------------------------------- */

class AnUnterminatedUsageChunkStillCounts extends UsageNetTest {
  readonly id = "a-usage-chunk-with-no-trailing-newline-is-still-the-reported-usage";
  readonly whyItExists =
    "a server that closed the stream right after its last line left the usage chunk in the decoder's buffer, and the turn was booked as zero tokens";

  override async run(t: TestRun): Promise<void> {
    const { usage } = await this.usageReportedFor(
      sseWithUsage({ prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } }, false),
    );
    t.assert.notDeepEqual(usage, emptyUsage(), "the final chunk must not be dropped for lacking a newline");
    t.assert.deepEqual(usage, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 });
  }
}

/* ---- checklist 5 — pure ---------------------------------------------- */

class AddUsageNeverMixesClasses extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "addusage-onto-empty-is-the-identity-and-sums-each-class-separately";
  readonly whyItExists =
    "collapsing the classes into one total loses the price — a cache read is about a tenth of an input token — so a sum that mixed them misbilled every cached session";

  override run(t: TestRun): void {
    const u: Usage = { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 30 };
    t.assert.deepEqual(addUsage(emptyUsage(), u), u, "adding onto zero is the identity, field by field");

    const total = addUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, u);
    t.assert.deepEqual(total, { inputTokens: 201, outputTokens: 52, cacheReadTokens: 803, cacheWriteTokens: 34 }, "each class sums with its own kind only");

    // In place, and the sum is what comes back — the contract every ledger relies on.
    const target = emptyUsage();
    const returned = addUsage(target, u);
    t.assert.equal(returned, target, "addUsage accumulates into its target and returns it");
    t.assert.deepEqual(emptyUsage(), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, "emptyUsage is all four classes at zero");
  }
}

registerFeatureTests(
  new CachedTokensAreSubtracted(),
  new NoDetailsMeansNoCacheAndNeverNegative(),
  new TheClassesAreAdditive(),
  new AnUnterminatedUsageChunkStillCounts(),
  new AddUsageNeverMixesClasses(),
);
