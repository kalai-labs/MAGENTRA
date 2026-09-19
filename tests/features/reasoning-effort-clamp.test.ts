/**
 * `reasoning-effort-clamp`.
 *
 * The user picks one of seven thinking levels for a connection; endpoints have
 * shorter ladders. `EffortClamp` learns from an endpoint's own 400 which levels
 * it lacks and clamps every later request to the nearest one it has — a level
 * above `high` lowers the ceiling, one below raises the floor, a refused `high`
 * or an "unknown field" body drops the setting for good — and the user is told
 * once what was actually sent. A request is never refused over a level, and
 * never silently sent with the wrong one.
 *
 * `pure` + `net`, and the record said `pure`. Items 1–4 are the clamp's own
 * state machine, a function of the rejections it is fed. Item 5 is the
 * provider: `OpenAICompatProvider` reaches the network with the global `fetch`
 * and takes no fetch parameter, so the only place to see that it re-sent with
 * a lower level is the far end of a real socket — a local HTTP server that
 * refuses `max` the way a real endpoint words it. Re-declared 2026-09-19.
 */

import { OpenAICompatProvider, EffortClamp, type ProviderEvent, type WireEffort } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest } from "../lib/netTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "reasoning-effort-clamp";

/** Verbatim from the record. */
const INVARIANT =
  "A level the endpoint does not have maps to the nearest one it does; a request is never refused over a level and never silently sent with the wrong one.";

abstract class ClampTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class ARejectedHighLevelLowersTheCeiling extends ClampTest {
  readonly id = "a-rejected-level-above-high-lowers-the-ceiling-one-rung-at-a-time";
  readonly whyItExists =
    "a model whose ladder stops at 'high' refused every request that asked for 'max', and the turn failed instead of running at the most the model had";

  override run(t: TestRun): void {
    const clamp = new EffortClamp();
    t.assert.equal(clamp.resolve("max"), "max", "before any rejection the user's choice is sent as is");
    t.assert.equal(clamp.reject("max", false), true, "learning something new reports true, so the caller retries");
    t.assert.equal(clamp.resolve("max"), "xhigh", "after 'max' is refused the ceiling is 'xhigh'");
    t.assert.equal(clamp.reject("xhigh", false), true);
    t.assert.equal(clamp.resolve("max"), "high", "after 'xhigh' is refused too the ceiling is 'high'");
    // A level under the ceiling is untouched.
    t.assert.equal(clamp.resolve("medium"), "medium");
    // Rejecting a level already above the ceiling teaches nothing.
    t.assert.equal(clamp.reject("max", false), false, "a rejection of a level already clamped away is not new information");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ARejectedLowLevelRaisesTheFloor extends ClampTest {
  readonly id = "a-rejected-level-below-high-raises-the-floor-and-off-is-handled-on-its-own";
  readonly whyItExists =
    "an endpoint without 'minimal' refused the request outright, and one that refused 'none' kept being sent 'none' on every turn";

  override run(t: TestRun): void {
    const clamp = new EffortClamp();
    t.assert.equal(clamp.reject("minimal", false), true);
    t.assert.equal(clamp.resolve("minimal"), "low", "the floor rose to 'low'");
    t.assert.equal(clamp.resolve("off"), "none", "'off' is its own thing — the floor does not touch it");
    t.assert.equal(clamp.resolve("high"), "high", "levels above the floor are untouched");

    t.assert.equal(clamp.reject("none", false), true);
    t.assert.equal(clamp.resolve("off"), undefined, "after 'none' is refused nothing is sent for 'off'");
    t.assert.equal(clamp.resolve("low"), "low", "and every other level is unaffected");
    t.assert.equal(clamp.reject("none", false), false, "a second refusal of 'none' teaches nothing");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class ARefusedHighOrAnUnknownFieldDropsTheSetting extends ClampTest {
  readonly id = "a-refused-high-or-an-unknown-field-drops-the-setting-for-good";
  readonly whyItExists =
    "every reasoning endpoint has 'high' if it has the field at all, so a refused 'high' means the field itself is the problem, and retrying other levels would burn a request per rung for nothing";

  override run(t: TestRun): void {
    const refusedHigh = new EffortClamp();
    t.assert.equal(refusedHigh.reject("high", false), true);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      t.assert.equal(refusedHigh.resolve(level), undefined, `after a refused 'high' nothing is sent for ${level}`);
    }
    t.assert.equal(refusedHigh.reject("medium", false), false, "nothing more to learn");
    t.assert.equal(refusedHigh.reject("none", false), false);

    const unknownField = new EffortClamp();
    t.assert.equal(unknownField.reject("medium", true), true, "an unknown-field body is new information the first time");
    for (const level of ["off", "low", "max"] as const) {
      t.assert.equal(unknownField.resolve(level), undefined, `after the field is unknown nothing is sent for ${level}`);
    }
    t.assert.equal(unknownField.reject("low", true), false, "and any further rejection teaches nothing");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheUserIsToldWhatWasSent extends ClampTest {
  readonly id = "describe-says-what-was-sent-only-when-it-differs-from-what-was-chosen";
  readonly whyItExists =
    "a silently altered request is the failure the setting exists to prevent: the user chose 'max', got 'high', and had no way to know the model was not thinking as hard as asked";

  override run(t: TestRun): void {
    const clamp = new EffortClamp();
    const clamped = clamp.describe("max", "high");
    t.assert.match(clamped ?? "", /reasoning effort "max" is not available on this model — using "high"/, "a clamped level names both the choice and what was sent");
    const dropped = clamp.describe("max", undefined);
    t.assert.match(dropped ?? "", /does not accept a reasoning-effort setting/, "a dropped field says the model runs at its default");
    t.assert.equal(clamp.describe("high", "high"), undefined, "no note when the request went out as chosen");
    t.assert.equal(clamp.describe("off", "none"), undefined, "'off' sent as 'none' is the same choice, not a change");
    t.assert.match(clamp.describe("off", "low") ?? "", /using "low"/, "'off' clamped up to a level is a change worth saying");
    t.assert.match(clamp.describe("low", "none") ?? "", /using "off"/, "and 'none' is spelled 'off' for the user, never 'none'");
  }
}

/* ---- checklist 5 — net ----------------------------------------------- */

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

class TheProviderRetriesWithTheNearestLevel extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-400-over-max-is-answered-with-one-retry-at-xhigh-and-the-turn-completes";
  readonly whyItExists =
    "the turn failed with 'provider returned 400: reasoning_effort must be one of low, medium, high' on a model that would have run fine at high, and the user's only recourse was to guess a level";

  override async run(t: TestRun): Promise<void> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      const body = JSON.parse(request.body) as { reasoning_effort?: string };
      if (body.reasoning_effort === "max") {
        return { status: 400, json: { error: { message: "reasoning_effort must be one of low, medium, high", type: "invalid_request_error", param: "reasoning_effort" } } };
      }
      return { status: 200, text: sseCompletion("done"), headers: { "content-type": "text/event-stream" } };
    });

    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    const notes: string[] = [];
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 64,
      reasoningEffort: "max",
      signal: new AbortController().signal,
      onNegotiated: (note) => notes.push(note),
    })) {
      events.push(event);
    }

    const chats = server.requests.filter((r) => r.url.endsWith("/chat/completions"));
    t.assert.equal(chats.length, 2, "exactly two requests: the refused one and the clamped retry");
    const sent = chats.map((r) => (JSON.parse(r.body) as { reasoning_effort?: WireEffort }).reasoning_effort);
    t.assert.deepEqual(sent, ["max", "xhigh"], "the retry carries the next level down, not a guess");

    // The turn completed instead of failing.
    const end = events.find((e) => e.type === "message_end");
    t.assert.notEqual(end, undefined, "the stream must end normally");
    t.assert.equal(end?.type === "message_end" ? end.stopReason : undefined, "end_turn");
    t.assert.equal(events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.text : "")).join(""), "done");

    // And the user was told — once, on the request that was accepted.
    t.assert.deepEqual(notes, ['reasoning effort "max" is not available on this model — using "xhigh", the nearest level it accepts']);

    // A later request on the same provider goes straight to xhigh: learned once, remembered.
    for await (const _ of provider.stream({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "again" }] }],
      tools: [],
      maxTokens: 64,
      reasoningEffort: "max",
      signal: new AbortController().signal,
    })) {
      /* drain */
    }
    const later = server.requests.filter((r) => r.url.endsWith("/chat/completions"));
    t.assert.equal(later.length, 3, "the second turn costs one request, not two");
    t.assert.equal((JSON.parse(later[2]!.body) as { reasoning_effort?: string }).reasoning_effort, "xhigh");
  }
}

registerFeatureTests(
  new ARejectedHighLevelLowersTheCeiling(),
  new ARejectedLowLevelRaisesTheFloor(),
  new ARefusedHighOrAnUnknownFieldDropsTheSetting(),
  new TheUserIsToldWhatWasSent(),
  new TheProviderRetriesWithTheNearestLevel(),
);
