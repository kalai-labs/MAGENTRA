/**
 * `wire-round-trip`.
 *
 * The engine and the app are two processes joined by NDJSON on a pipe. Every
 * `CoreEvent` the engine emits and every `FrontendRequest` the app sends has to
 * come out of `decodeFrames(encodeFrame(x))` deep-equal to what went in — a
 * frame that did not survive the trip is two processes silently disagreeing
 * about what was said.
 *
 * `pure`: encode and decode are functions of the frame.
 *
 * ONE SAMPLE PER VARIANT, ENFORCED BY THE COMPILER. The samples are typed as
 * `{ [K in CoreEvent["type"]]: Extract<CoreEvent, { type: K }> }`, so a variant
 * added to the protocol without a sample here is a type error in
 * `npm run typecheck:tests`, and a sample that does not match its variant's
 * shape is one too. A hand-kept list of "representative" frames would drift the
 * first time the wire grew; this list cannot.
 */

import { decodeFrames, encodeFrame, PROTOCOL_VERSION, type CoreEvent, type FrontendRequest } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "wire-round-trip";

/** Verbatim from the record. */
const INVARIANT = "A frame survives the round trip, and a malformed line yields an error frame instead of killing the transport.";

type EventSamples = { [K in CoreEvent["type"]]: Extract<CoreEvent, { type: K }> };
type RequestSamples = { [K in FrontendRequest["type"]]: Extract<FrontendRequest, { type: K }> };

const USAGE = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30 };

/** Text that exercises the encoder: newlines, tabs, quotes, backslashes, emoji, Turkish letters, a NUL. */
const AWKWARD = 'line one\nline two\ttabbed "quoted" back\\slash 🚀 İstanbul’da şöyle ğüşıöç — \u0000 end';

/** Every event variant, once. */
const EVENTS: EventSamples = {
  session_started: {
    type: "session_started",
    v: PROTOCOL_VERSION,
    sessionId: "s_abc123",
    cwd: "C:\\work\\proj",
    model: "some/model",
    reasoningEffort: "high",
    overdrive: false,
    commands: [
      { cmd: "/help", args: "", desc: "show this help" },
      { cmd: "/review", args: "[args]", desc: "an addon", addon: true },
    ],
    rateCard: { "some/model": { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.6, contextWindow: 128000 } },
    addons: [{ name: "magentron", description: "built in", builtin: true }],
  },
  turn_started: { type: "turn_started", turnId: "t_1", at: 1_758_650_400_000 },
  tool_output_delta: { type: "tool_output_delta", id: "call_1", text: AWKWARD },
  retry_status: { type: "retry_status", attempt: 2, delayMs: 1500, reason: "429 rate limited" },
  text_delta: { type: "text_delta", text: AWKWARD },
  thinking_delta: { type: "thinking_delta", text: "hmm\n\nthinking…" },
  tool_call_started: {
    type: "tool_call_started",
    id: "call_2",
    tool: "Bash",
    input: { command: 'echo "hi"\nls', timeout: 5000 },
    description: "echo",
    subagent: true,
    agentId: "ag_1",
    agentDesc: "explore",
    at: 1_758_650_400_010,
  },
  tool_call_finished: { type: "tool_call_finished", id: "call_2", tool: "Bash", resultPreview: "hi\n", isError: false, subagent: false, at: 1_758_650_401_500 },
  agent_spawned: { type: "agent_spawned", agentId: "ag_1", agentDesc: "explore the repo", background: true },
  agent_finished: { type: "agent_finished", agentId: "ag_1", isError: false },
  permission_request: {
    type: "permission_request",
    id: "perm_1",
    tool: "Bash",
    input: { command: "rm -rf ./tmp/*" },
    description: "delete ./tmp/*",
    subject: "rm -rf ./tmp/*",
    grant: "rm",
  },
  question_request: {
    type: "question_request",
    id: "q_1",
    questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "a", preview: "```\nA\n```" }], multiSelect: false }],
  },
  task_list_updated: {
    type: "task_list_updated",
    tasks: [{ id: "1", subject: "s", description: "d", activeForm: "doing", status: "in_progress", owner: "me", blocks: ["2"], blockedBy: [], metadata: { k: 1 }, startedAt: 1_758_650_400_000 }, { id: "2", subject: "t", description: "e", status: "completed", blocks: [], blockedBy: ["1"], startedAt: 1_758_650_400_100, completedAt: 1_758_650_460_000 }],
  },
  file_edited: { type: "file_edited", path: "src/a.ts", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" },
  background_notification: { type: "background_notification", taskId: "bash_1", kind: "exit", payload: { exitCode: 0, description: "npm test" } },
  overdrive_changed: { type: "overdrive_changed", enabled: true },
  command_output: { type: "command_output", text: AWKWARD },
  context_update: { type: "context_update", contextTokens: 12345, outputTokens: 678, contextWarn: true },
  session_report: { type: "session_report", text: "tokens: 1\n\ncost: none" },
  session_list: {
    type: "session_list",
    sessions: [{ id: "s_1", createdAt: "2026-09-19T10:00:00.000Z", updatedAt: "2026-09-19T11:00:00.000Z", cwd: "/w", firstUserMessage: "hi", model: "m", label: "L" }],
  },
  turn_finished: { type: "turn_finished", turnId: "t_1", stopReason: "end_turn", usage: USAGE, contextTokens: 1050, overdriveSnapshot: "abc123", contextWarn: false },
  error: { type: "error", message: AWKWARD, fatal: true },
  addon_draft: { type: "addon_draft", ok: false, text: "---\nname: x\n---\nbody", suggestedFilename: "x.md", error: "no" },
  addon_export: { type: "addon_export", ok: true, name: "x", filename: "x.md", text: "---\nname: x\n---\n" },
  addons_updated: { type: "addons_updated", addons: [{ name: "x", description: "y", builtin: false }], commands: [{ cmd: "/x", args: "[args]", desc: "y", addon: true }] },
  session_restored: {
    type: "session_restored",
    sessionId: "s_1",
    messages: [
      { role: "user", text: "do it" },
      { role: "assistant", text: "done", thinking: "…", toolCalls: [{ tool: "Read", input: { file_path: "/a" }, result: "x\n", isError: false }] },
    ],
  },
  model_catalog: { type: "model_catalog", models: ["a", "b/c"] },
  cwd_changed: { type: "cwd_changed", cwd: "/w/.worktrees/x", worktree: true },
};

/** Every request variant, once. */
const REQUESTS: RequestSamples = {
  user_message: { type: "user_message", text: AWKWARD, images: [{ name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=" }] },
  permission_response: { type: "permission_response", id: "perm_1", decision: "allow_always", message: "ok but careful" },
  question_response: { type: "question_response", id: "q_1", answers: { "q:0": ["A", "B"], "q:1": [] } },
  interrupt: { type: "interrupt" },
  set_deletion_guard: { type: "set_deletion_guard", enabled: false },
  set_overdrive: { type: "set_overdrive", enabled: true },
  set_compact_limit: { type: "set_compact_limit", limit: 0 },
  set_model: { type: "set_model", model: "a/b" },
  set_connection: {
    type: "set_connection",
    connection: {
      provider: "openai-compat",
      baseUrl: "http://192.168.1.20:1234/v1",
      apiKey: "",
      model: "local",
      contextWindow: 32000,
      reasoningEffort: "off",
      insecureTls: true,
      vision: { enabled: true, provider: "openai-compat", baseUrl: "http://192.168.1.21/v1", apiKey: "vk", model: "llava", contextWindow: 8192, insecureTls: false },
    },
  },
  set_vision: { type: "set_vision", enabled: false },
  steer_message: { type: "steer_message", text: "also this", images: [] },
  slash_command: { type: "slash_command", command: "settings", args: "global apiKey sk-x" },
  bang_command: { type: "bang_command", cmd: 'git log --format="%s" -1' },
  resume_session: { type: "resume_session", id: "s_1" },
  delete_session: { type: "delete_session", id: "s_1" },
  stop_background: { type: "stop_background", taskId: "bash_1" },
  rename_session: { type: "rename_session", id: "s_1", label: "İş" },
  archive_session: { type: "archive_session", id: "s_1" },
  list_sessions: { type: "list_sessions" },
  generate_addon: {
    type: "generate_addon",
    description: "review PRs",
    model: "m",
    context: "when asked",
    connection: { provider: "anthropic", apiKey: "sk-ant", model: "claude" },
  },
  export_addon: { type: "export_addon", name: "review" },
  install_addon: { type: "install_addon", filename: "review.md", text: "---\nname: review\ndescription: d\n---\nbody\n" },
};

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield part;
}

async function decodeAll(...parts: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const frame of decodeFrames(chunks(...parts))) out.push(frame);
  return out;
}

abstract class WireTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class EveryEventSurvives extends WireTest {
  readonly id = "every-core-event-variant-survives-encode-then-decode";
  readonly whyItExists =
    "a frame the app decoded differently from what the engine encoded — a dropped optional field, a mangled nested object — is a UI that shows the wrong state with no error anywhere";

  override async run(t: TestRun): Promise<void> {
    const events = Object.values(EVENTS);
    t.assert.ok(events.length >= 25, `the protocol has ${events.length} event variants sampled — the compiler holds this list complete`);
    for (const event of events) {
      const [decoded, ...rest] = await decodeAll(encodeFrame(event));
      t.assert.deepEqual(decoded, event, `${event.type} did not survive the round trip`);
      t.assert.deepEqual(rest, [], `${event.type} must encode to exactly one frame`);
    }
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryRequestSurvives extends WireTest {
  readonly id = "every-frontend-request-variant-survives-encode-then-decode";
  readonly whyItExists =
    "a set_connection whose nested vision block or key did not survive is a connection the engine applies half of, which the user sees as an auth failure on the wrong endpoint";

  override async run(t: TestRun): Promise<void> {
    const requests = Object.values(REQUESTS);
    t.assert.ok(requests.length >= 20, `the protocol has ${requests.length} request variants sampled — the compiler holds this list complete`);
    for (const request of requests) {
      const [decoded, ...rest] = await decodeAll(encodeFrame(request));
      t.assert.deepEqual(decoded, request, `${request.type} did not survive the round trip`);
      t.assert.deepEqual(rest, [], `${request.type} must encode to exactly one frame`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AwkwardTextIsOneLine extends WireTest {
  readonly id = "newlines-unicode-and-backslashes-encode-to-one-line-and-decode-unchanged";
  readonly whyItExists =
    "a literal newline inside a frame's text would split it into two lines on the wire — one unparseable, one lost — so every multi-line tool output would have broken the transport";

  override async run(t: TestRun): Promise<void> {
    const frame: CoreEvent = { type: "text_delta", text: AWKWARD };
    const encoded = encodeFrame(frame);
    t.assert.equal(encoded.endsWith("\n"), true, "a frame ends with exactly one newline");
    t.assert.equal(encoded.slice(0, -1).includes("\n"), false, "and contains no other newline, whatever the text held");
    t.assert.equal(encoded.includes("\r"), false, "and never a carriage return");
    const [decoded] = await decodeAll(encoded);
    t.assert.deepEqual(decoded, frame);
    t.assert.equal((decoded as { text: string }).text, AWKWARD, "the awkward text came back byte for byte");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ConcatenatedFramesDecodeInOrder extends WireTest {
  readonly id = "n-encoded-frames-concatenated-decode-to-the-same-n-frames-in-order";
  readonly whyItExists =
    "the pipe hands the reader many frames in one chunk; a decoder that took the first line and dropped the rest lost every event that arrived in a burst";

  override async run(t: TestRun): Promise<void> {
    const all: unknown[] = [...Object.values(EVENTS), ...Object.values(REQUESTS)];
    const joined = all.map((frame) => encodeFrame(frame)).join("");
    const decoded = await decodeAll(joined);
    t.assert.equal(decoded.length, all.length);
    t.assert.deepEqual(decoded, all, "every frame, in the order it was written");

    // The same bytes in awkward chunks: one giant chunk vs. many tiny ones agree.
    const tiny: string[] = [];
    for (let i = 0; i < joined.length; i += 7) tiny.push(joined.slice(i, i + 7));
    t.assert.deepEqual(await decodeAll(...tiny), all, "chunking must not change what is decoded");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class GarbageBetweenFramesLeavesBothIntact extends WireTest {
  readonly id = "a-garbage-line-between-two-frames-yields-an-error-frame-with-both-frames-intact";
  readonly whyItExists =
    "one corrupt line used to end the session; the two good frames around it were the turn's start and end, and losing either left the UI spinning forever";

  override async run(t: TestRun): Promise<void> {
    const first = EVENTS.turn_started;
    const second = EVENTS.turn_finished;
    const decoded = (await decodeAll(`${encodeFrame(first)}{this is: not json}\n${encodeFrame(second)}`)) as Record<string, unknown>[];
    t.assert.equal(decoded.length, 3);
    t.assert.deepEqual(decoded[0], first, "the frame before the garbage is intact");
    t.assert.equal(decoded[1]?.["type"], "error");
    t.assert.equal(decoded[1]?.["fatal"], false, "the garbage is reported, not fatal");
    t.assert.match(String(decoded[1]?.["message"]), /unparseable frame/);
    t.assert.deepEqual(decoded[2], second, "the frame after the garbage is intact");
  }
}

registerFeatureTests(
  new EveryEventSurvives(),
  new EveryRequestSurvives(),
  new AwkwardTextIsOneLine(),
  new ConcatenatedFramesDecodeInOrder(),
  new GarbageBetweenFramesLeavesBothIntact(),
);
