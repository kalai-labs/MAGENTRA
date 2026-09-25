/**
 * `reasoning-goes-back-to-the-model`.
 *
 * Field run 2026-09-24/25 (MiMo-V2.6-Pro) and the GLM-5.3 run before it: the
 * owner's main complaint — "all the work is done silently in reasoning, then
 * the other steps take 0s". The model planned the whole job in one reasoning
 * block (71k characters, 13 minutes, before its first tool call) and then fired
 * its calls in bursts. The OpenAI-compatible transport sent every earlier
 * assistant message back WITHOUT its reasoning, so a model trained to think
 * between tool calls started every call blind. MiMo's API documents the field
 * as required on a tool-call message; GLM-5's Preserved Thinking and Fireworks'
 * interleaved thinking read the same field.
 *
 * `net`, as the record declares. `OpenAICompatProvider` reaches the network
 * through the global `fetch`, so the only place to read what it sent is the far
 * end of a real socket: every test here runs the real provider against a real
 * HTTP server on 127.0.0.1. Item 3 runs the real Engine and Session on it too —
 * nothing in that test is a double.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Msg } from "@magentra/providers";
import { OpenAICompatProvider, ProviderHttpError, type ProviderEvent } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest, type ReceivedRequest } from "../lib/netTest.ts";
import { startEngineOn, type EngineDriver } from "../lib/scriptedEngine.ts";

const FEATURE = "reasoning-goes-back-to-the-model";

/** Verbatim from the record. */
const INVARIANT =
  "Each earlier assistant message's reasoning goes back to an OpenAI-compatible endpoint as reasoning_content on every later request, until that endpoint rejects the field.";

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sse(chunks: readonly unknown[]): string {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
}

/** A plain streamed answer that ends the call. */
function sseText(text: string): string {
  return sse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]);
}

interface WireMessage {
  role: string;
  content: unknown;
  reasoning_content?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

function chatBodies(requests: readonly ReceivedRequest[]): { messages: WireMessage[] }[] {
  return requests.filter((r) => r.url.endsWith("/chat/completions")).map((r) => JSON.parse(r.body) as { messages: WireMessage[] });
}

const PLAN = "The user wants the notes file. Read notes.md first, then summarise it — nothing else is needed.";

/** A conversation as the Session keeps it: a reasoned tool call, its result, then a reply with no reasoning. */
const HISTORY: Msg[] = [
  { role: "user", content: [{ type: "text", text: "what is in notes.md?" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: PLAN },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "notes.md" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "buy milk", isError: false }] },
  { role: "assistant", content: [{ type: "text", text: "It says: buy milk." }] },
  { role: "user", content: [{ type: "text", text: "thanks" }] },
];

abstract class ReasoningTest extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async drain(provider: OpenAICompatProvider, messages: Msg[] = HISTORY): Promise<ProviderEvent[]> {
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "m",
      system: "s",
      messages,
      tools: [],
      maxTokens: 64,
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    return events;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheReasoningRidesOnItsMessage extends ReasoningTest {
  readonly id = "an-assistant-messages-reasoning-goes-back-as-reasoning-content";
  readonly whyItExists =
    "the transport sent each earlier assistant message back without its reasoning, so a model that thinks between tool calls started every call blind — and planned a whole game in one 13-minute reasoning block before it acted";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve(() => ({ status: 200, text: sseText("ok"), headers: SSE_HEADERS }));
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    await this.drain(provider);

    const [body] = chatBodies(server.requests);
    const assistants = (body?.messages ?? []).filter((m) => m.role === "assistant");
    t.assert.equal(assistants.length, 2, "both assistant messages went out");
    const [reasoned, plain] = assistants;
    t.assert.equal(reasoned?.reasoning_content, PLAN, "the reasoned message carries its reasoning, verbatim");
    t.assert.equal(reasoned?.content, "Reading it.", "beside its text");
    t.assert.equal(reasoned?.tool_calls?.[0]?.function.name, "Read", "and its tool call");
    t.assert.equal("reasoning_content" in (plain ?? {}), false, "a message with no reasoning carries no such field — not an empty one");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ARefusedFieldIsDroppedOnceAndRemembered extends ReasoningTest {
  readonly id = "an-endpoint-that-refuses-reasoning-content-gets-the-request-without-it";
  readonly whyItExists =
    "a strict OpenAI-compatible server that 400s on an unknown message field would otherwise kill every turn after the first tool call, over a field that only helps";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) => {
      const body = JSON.parse(request.body) as { messages: WireMessage[] };
      if (body.messages.some((m) => m.reasoning_content !== undefined)) {
        // The way a pydantic-validated server (vLLM, SGLang gateways) words it.
        return {
          status: 400,
          json: { detail: [{ type: "extra_forbidden", loc: ["body", "messages", 1, "reasoning_content"], msg: "Extra inputs are not permitted" }] },
        };
      }
      return { status: 200, text: sseText("done"), headers: SSE_HEADERS };
    });
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const events = await this.drain(provider);

    const first = chatBodies(server.requests);
    t.assert.equal(first.length, 2, "the refused request and one re-send");
    t.assert.equal(first[0]?.messages.find((m) => m.role === "assistant")?.reasoning_content, PLAN, "the first attempt did send the reasoning");
    t.assert.equal(first[1]?.messages.some((m) => "reasoning_content" in m), false, "the re-send carries none");
    const end = events.find((e) => e.type === "message_end");
    t.assert.equal(end?.type === "message_end" ? end.stopReason : undefined, "end_turn", "the turn survives");

    await this.drain(provider);
    const later = chatBodies(server.requests);
    t.assert.equal(later.length, 3, "a later call costs one request — the refusal was remembered");
    t.assert.equal(later[2]?.messages.some((m) => "reasoning_content" in m), false, "and still goes out without the field");
  }
}

class ADemandedFieldIsNeverDropped extends ReasoningTest {
  readonly id = "an-endpoint-that-demands-reasoning-content-is-not-taught-to-drop-it";
  readonly whyItExists =
    "MiMo's API 400s when a tool-call message comes back WITHOUT its reasoning; reading that error as a refusal would drop the field from every later request and fail each of them the same way";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve(() => ({
      status: 400,
      // Worded with a refusal word in it, as a demand often is: only "required"
      // tells it from a refusal, so this is the case that proves the guard.
      json: { error: { message: "an assistant message with tool_calls is not allowed without reasoning_content in thinking mode: reasoning_content is required", type: "invalid_request_error" } },
    }));
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    let thrown: unknown;
    try {
      await this.drain(provider);
    } catch (err) {
      thrown = err;
    }
    t.assert.ok(thrown instanceof ProviderHttpError && thrown.status === 400, "the demand surfaces as the endpoint's own 400");
    const bodies = chatBodies(server.requests);
    t.assert.equal(bodies.length, 1, "no re-send: a demand is not a refusal");
    t.assert.equal(bodies[0]?.messages.find((m) => m.role === "assistant")?.reasoning_content, PLAN, "and the one request did carry the reasoning");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

const STREAMED_PLAN = "Two steps. First list the markdown files, then answer from the list.";

class TheStreamedReasoningComesBackNextCall extends ReasoningTest {
  readonly id = "the-reasoning-streamed-with-a-tool-call-comes-back-in-the-next-request";
  readonly whyItExists =
    "the provider could send the field and the turn still lose it — the Session must keep what streamed as reasoning on the message it records, or the next call of the same turn starts blind again";
  override readonly timeoutMs: number = 60_000;

  #engine: EngineDriver | undefined;
  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  /** loadSettings merges ~/.magentra/settings.json: the developer's own must not reach the engine. */
  #isolateHome(): void {
    const home = mkdtempSync(join(tmpdir(), "magentra-reasoning-home-"));
    this.#dirs.push(home);
    for (const name of ["HOME", "USERPROFILE"]) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
    for (const [name, value] of this.#savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
  }

  override async run(t: TestRun): Promise<void> {
    this.#isolateHome();
    let call = 0;
    const server = await this.serve((request) => {
      // The engine also asks for the model catalog; only chat calls are the script.
      if (!request.url.endsWith("/chat/completions")) return { status: 200, json: { data: [] } };
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          headers: SSE_HEADERS,
          text: sse([
            { choices: [{ delta: { reasoning_content: STREAMED_PLAN.slice(0, 20) } }] },
            { choices: [{ delta: { reasoning_content: STREAMED_PLAN.slice(20) } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_glob", function: { name: "Glob", arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pattern":"*.md"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 30 } },
          ]),
        };
      }
      return { status: 200, text: sseText("There are none."), headers: SSE_HEADERS };
    });

    const workspace = mkdtempSync(join(tmpdir(), "magentra-reasoning-back-"));
    this.#dirs.push(workspace);
    this.#engine = await startEngineOn(new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 }), {
      workspace,
      settings: { model: "m" },
    });
    const turn = await this.#engine.runTurn("which markdown files are here?");
    t.assert.deepEqual([...turn.errors], [], "the turn ran clean");

    const bodies = chatBodies(server.requests);
    t.assert.ok(bodies.length >= 2, `the turn made a second call after the tool ran (${bodies.length})`);
    const back = bodies[1]!.messages.filter((m) => m.role === "assistant");
    const withCall = back.find((m) => m.tool_calls?.some((c) => c.function.name === "Glob"));
    t.assert.ok(withCall, "the second request replays the assistant message that called Glob");
    t.assert.equal(withCall!.reasoning_content, STREAMED_PLAN, "with the reasoning that streamed before the call, verbatim");
  }
}

registerFeatureTests(
  new TheReasoningRidesOnItsMessage(),
  new ARefusedFieldIsDroppedOnceAndRemembered(),
  new ADemandedFieldIsNeverDropped(),
  new TheStreamedReasoningComesBackNextCall(),
);
