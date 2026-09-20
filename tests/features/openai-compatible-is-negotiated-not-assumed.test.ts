/**
 * `openai-compatible-is-negotiated-not-assumed`.
 *
 * "OpenAI-compatible" is a family resemblance, not a specification: every
 * server has its own opinion about the optional body fields — `stream_options`,
 * `max_tokens` vs `max_completion_tokens`, `num_ctx`, `chat_template_kwargs`,
 * `reasoning_effort`. Rather than a per-vendor table that would rot, the
 * provider learns from the endpoint's own 400: it drops or renames the field
 * the body names, re-sends once, and remembers for the life of the instance —
 * one extra request, once, instead of a dead turn. `tools` is not in that set,
 * because a silently tool-less agent looks like a broken model.
 *
 * This file is about the NEGOTIATION LOOP — which field is dropped, which is
 * renamed, what is NOT a field rejection, and that the lesson is remembered.
 * The effort ladder's own arithmetic (which level follows which) belongs to
 * `reasoning-effort-clamp`, which proves it on `EffortClamp` directly; item 5
 * here only drives the loop that feeds it, twice, over a socket.
 *
 * `net`, as the record declares. `OpenAICompatProvider` reaches the network
 * through the global `fetch` and takes no fetch parameter, so the only place
 * to read what it actually sent — and what it sent the SECOND time — is the
 * far end of a real socket. Every test here runs a real provider against a
 * real HTTP server on 127.0.0.1 that refuses a field the way a real endpoint
 * words it; `globalThis.fetch` is never touched. `maxRetries: 0` keeps the
 * backoff out of the way, though a deliberate 400 is not retryable anyway
 * (retry.ts retries 429/408/5xx only).
 *
 * One gap, recorded rather than papered over: the invariant also names
 * `num_ctx`, and no item of the approved checklist covers it — the field is
 * only sent when the provider is constructed with `numCtx`, which also arms
 * the native-Ollama probe, so proving it needs an item nobody has approved.
 */

import type { ReasoningEffort } from "@magentra/protocol";
import {
  OpenAICompatProvider,
  ProviderHttpError,
  type ProviderEvent,
  type ToolSchema,
  type WireEffort,
} from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest, type ReceivedRequest } from "../lib/netTest.ts";

const FEATURE = "openai-compatible-is-negotiated-not-assumed";

/** Verbatim from the record. */
const INVARIANT =
  "A 400 naming stream_options, max_tokens or num_ctx drops or renames that field and re-sends once, then remembers; tools is never dropped.";

/** One streamed chat completion, in the SSE the provider parses. */
function sseCompletion(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

/** One real tool, so `req.tools` is non-empty and `tools` is on the wire. */
const TOOLS: ToolSchema[] = [
  {
    name: "Read",
    description: "read a file",
    inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
];

/** The fields of the chat body this feature negotiates over. */
interface WireBody {
  model: string;
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream_options?: { include_usage: boolean };
  num_ctx?: number;
  reasoning_effort?: WireEffort;
  tools?: { type: string; function: { name: string } }[];
}

abstract class NegotiationTest extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** One turn through a real provider, drained to completion. */
  protected async turn(
    provider: OpenAICompatProvider,
    opts: { tools?: ToolSchema[]; effort?: ReasoningEffort; onNegotiated?: (note: string) => void } = {},
  ): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: opts.tools ?? [],
      maxTokens: 64,
      signal: new AbortController().signal,
      ...(opts.effort !== undefined ? { reasoningEffort: opts.effort } : {}),
      ...(opts.onNegotiated !== undefined ? { onNegotiated: opts.onNegotiated } : {}),
    })) {
      events.push(event);
    }
    return events;
  }

  /** The chat bodies the server received, in order. */
  protected bodies(requests: readonly ReceivedRequest[]): WireBody[] {
    return requests.filter((r) => r.url.endsWith("/chat/completions")).map((r) => JSON.parse(r.body) as WireBody);
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class ARejectedStreamOptionsIsDroppedOnceAndRemembered extends NegotiationTest {
  readonly id = "a-400-naming-stream-options-drops-it-re-sends-once-and-never-sends-it-again";
  readonly whyItExists =
    "an older vLLM build 400'd on the unknown stream_options field, and every single turn on that endpoint died with 'provider returned 400: Unrecognized request argument: stream_options' over a field whose only job is to report token usage";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as WireBody;
      if (body.stream_options !== undefined) {
        return { status: 400, json: { error: "Unrecognized request argument: stream_options" } };
      }
      return { status: 200, text: sseCompletion("done"), headers: SSE_HEADERS };
    });

    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const events = await this.turn(provider);

    const first = this.bodies(server.requests);
    t.assert.equal(first.length, 2, "exactly two requests: the refused one and the re-send");
    // The negative below is only worth something because the positive held.
    t.assert.deepEqual(first[0]?.stream_options, { include_usage: true }, "the first attempt really does ask for usage in the stream");
    t.assert.equal("stream_options" in (first[1] ?? {}), false, "the re-send drops the field the server named — not just empties it");
    t.assert.equal(first[1]?.model, "m", "and is otherwise the same request");

    // The turn completed rather than failing over an optional field.
    const end = events.find((e) => e.type === "message_end");
    t.assert.equal(end?.type === "message_end" ? end.stopReason : undefined, "end_turn", "the turn survives the negotiation");

    // Remembered for the life of the instance: a later turn costs one request.
    await this.turn(provider);
    const later = this.bodies(server.requests);
    t.assert.equal(later.length, 3, "the second turn costs one request, not two — the rejection was remembered");
    t.assert.equal("stream_options" in (later[2] ?? {}), false, "and it still goes out without the refused field");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ARejectedMaxTokensIsRenamedNotDropped extends NegotiationTest {
  readonly id = "a-400-naming-max-tokens-renames-it-to-max-completion-tokens-with-the-same-value";
  readonly whyItExists =
    "OpenAI's reasoning models reject `max_tokens` outright and want `max_completion_tokens`; dropping the field instead of renaming it would have left the output cap unset, so a runaway answer could bill the whole context window";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as WireBody;
      if (body.max_tokens !== undefined) {
        return {
          status: 400,
          json: {
            error: {
              message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
              type: "invalid_request_error",
              param: "max_tokens",
            },
          },
        };
      }
      return { status: 200, text: sseCompletion("done"), headers: SSE_HEADERS };
    });

    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    await this.turn(provider);

    const bodies = this.bodies(server.requests);
    t.assert.equal(bodies.length, 2, "exactly two requests: the refused one and the renamed re-send");
    t.assert.equal(bodies[0]?.max_tokens, 64, "the first attempt sends the standard name");
    t.assert.equal("max_completion_tokens" in (bodies[0] ?? {}), false, "and only that one");
    t.assert.equal(bodies[1]?.max_completion_tokens, 64, "the re-send carries the SAME cap under the name this model wants");
    t.assert.equal("max_tokens" in (bodies[1] ?? {}), false, "and the old name is gone, not sent alongside");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AContextOverflowNamingMaxTokensIsNotAFieldRejection extends NegotiationTest {
  readonly id = "a-400-saying-max-tokens-plus-prompt-exceed-the-context-throws-instead-of-renaming";
  readonly whyItExists =
    "that body names max_tokens without rejecting the field, so reading it as one renamed the field and re-sent the SAME oversized request — burning a second request to be refused again, and hiding the overflow the caller compacts on behind a field-negotiation story";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      return {
        status: 400,
        json: { error: { message: "max_tokens + prompt exceed the context length of this model", type: "invalid_request_error" } },
      };
    });

    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    await t.assert.rejects(
      () => this.turn(provider),
      (err: unknown) =>
        err instanceof ProviderHttpError && err.status === 400 && /exceed the context length/.test(err.message),
      "the overflow must surface as the HTTP error it is, with the server's own words",
    );

    const bodies = this.bodies(server.requests);
    t.assert.equal(bodies.length, 1, "one request, not a re-send: nothing was learned here");
    t.assert.equal(bodies[0]?.max_tokens, 64, "and max_tokens was never renamed away");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ToolsSurviveEveryResendAndAreNeverNegotiated extends NegotiationTest {
  readonly id = "tools-rides-every-re-send-and-a-400-naming-tools-fails-the-turn-instead-of-dropping-them";
  readonly whyItExists =
    "a re-send built without the tools array, or a `tools` entry in the negotiable set, would leave the agent silently tool-less — which reads as a lazy model that refuses to edit files, not as an unsupported endpoint";

  override async run(t: TestRun): Promise<void> {
    // A negotiation that really does re-send: the tools must ride both requests.
    const dropsStreamOptions = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as WireBody;
      if (body.stream_options !== undefined) {
        return { status: 400, json: { error: "Unrecognized request argument: stream_options" } };
      }
      return { status: 200, text: sseCompletion("done"), headers: SSE_HEADERS };
    });

    const negotiating = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${dropsStreamOptions.url}/v1`, maxRetries: 0 });
    await this.turn(negotiating, { tools: TOOLS });

    const bodies = this.bodies(dropsStreamOptions.requests);
    t.assert.equal(bodies.length, 2, "the rejection did cause a re-send, so there are two bodies to check");
    for (const [i, body] of bodies.entries()) {
      t.assert.deepEqual(
        body.tools?.map((tool) => tool.function.name),
        ["Read"],
        `request ${i + 1} carries the tools, whatever else the negotiation removed`,
      );
    }

    // And a server that blames `tools` is refused, not obeyed.
    const rejectsTools = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      return { status: 400, json: { error: "Unrecognized request argument: tools" } };
    });

    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${rejectsTools.url}/v1`, maxRetries: 0 });
    await t.assert.rejects(
      () => this.turn(provider, { tools: TOOLS }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 400 && /tools/.test(err.message),
      "a 400 over tools is the turn's failure, never a field to give up",
    );

    const refused = this.bodies(rejectsTools.requests);
    t.assert.equal(refused.length, 1, "one request: there is no tool-less retry to make");
    t.assert.deepEqual(refused[0]?.tools?.map((tool) => tool.function.name), ["Read"], "and that one request did carry them");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheEffortFieldIsNegotiatedByValueThenByPresence extends NegotiationTest {
  readonly id = "a-value-complaint-re-sends-down-the-ladder-while-an-unknown-field-drops-reasoning-effort-with-one-note";
  readonly whyItExists =
    "the same 400 means two different things — 'this model's ladder is shorter' and 'this model has no such field' — and treating the second as the first walked every rung down for nothing, then failed the turn anyway with the user never told the setting had been abandoned";

  override async run(t: TestRun): Promise<void> {
    // A model whose ladder stops at `high`: it complains about the VALUE.
    const shortLadder = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as WireBody;
      if (body.reasoning_effort !== undefined && body.reasoning_effort !== "high") {
        return {
          status: 400,
          json: { error: { message: "reasoning_effort must be one of low, medium, high", type: "invalid_request_error", param: "reasoning_effort" } },
        };
      }
      return { status: 200, text: sseCompletion("thought about it"), headers: SSE_HEADERS };
    });

    const laddered = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${shortLadder.url}/v1`, maxRetries: 0 });
    const clampNotes: string[] = [];
    await this.turn(laddered, { effort: "max", onNegotiated: (note) => clampNotes.push(note) });

    const climbed = this.bodies(shortLadder.requests);
    t.assert.equal(climbed.length, 3, "one request per rung tried, and no more");
    t.assert.deepEqual(
      climbed.map((body) => body.reasoning_effort),
      ["max", "xhigh", "high"],
      "each re-send steps down the ladder rather than repeating or guessing",
    );
    t.assert.equal(clampNotes.length, 1, "the user is told once, on the request that was accepted");
    t.assert.match(clampNotes[0] ?? "", /using "high"/, "and told the level that was actually sent");

    // A model that has no such field at all: it complains about the FIELD.
    const noSuchField = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as WireBody;
      if (body.reasoning_effort !== undefined) {
        return { status: 400, json: { error: "Unrecognized request argument: reasoning_effort" } };
      }
      return { status: 200, text: sseCompletion("plain"), headers: SSE_HEADERS };
    });

    const plain = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${noSuchField.url}/v1`, maxRetries: 0 });
    const dropNotes: string[] = [];
    await this.turn(plain, { effort: "max", onNegotiated: (note) => dropNotes.push(note) });

    const dropped = this.bodies(noSuchField.requests);
    t.assert.equal(dropped.length, 2, "an unknown field costs one retry, not one per rung");
    t.assert.equal(dropped[0]?.reasoning_effort, "max", "the first attempt asked for what the user chose");
    t.assert.equal("reasoning_effort" in (dropped[1] ?? {}), false, "the re-send drops the field entirely");
    t.assert.equal(dropNotes.length, 1, "exactly one note, on the accepted request");
    t.assert.match(dropNotes[0] ?? "", /does not accept a reasoning-effort setting/, "which says the model now runs at its default");
  }
}

registerFeatureTests(
  new ARejectedStreamOptionsIsDroppedOnceAndRemembered(),
  new ARejectedMaxTokensIsRenamedNotDropped(),
  new AContextOverflowNamingMaxTokensIsNotAFieldRejection(),
  new ToolsSurviveEveryResendAndAreNeverNegotiated(),
  new TheEffortFieldIsNegotiatedByValueThenByPresence(),
);
