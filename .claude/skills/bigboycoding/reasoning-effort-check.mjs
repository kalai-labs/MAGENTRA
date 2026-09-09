#!/usr/bin/env node
// reasoning-effort-check — the thinking-depth and local-context contract, asserted
// against the BUILT engine (engine/*/dist).
// Run: npm run build && node .claude/skills/bigboycoding/reasoning-effort-check.mjs
//
// Guards the 2026-09-08 features "choose the model's context size for a local
// server" and "choose the model's reasoning effort":
//   1. `reasoningEffort` is a validated setting (schema, /settings, set_connection),
//      and Session hands it to the provider on every turn call.
//   2. OpenAICompatProvider sends it as `reasoning_effort` ("off" → "none" plus the
//      chat-template switch), and CLAMPS a rejected level to the nearest one the
//      endpoint accepts — over the maximum, the maximum is taken — telling the user
//      once through onNegotiated. A body that says the field is unknown drops it.
//   3. An endpoint that proves to be Ollama is driven through its NATIVE /api/chat
//      when a context window was asked for, because Ollama's /v1 layer has no
//      `options.num_ctx` at all; `think` follows the same clamp-and-tell rule.
//   4. AnthropicProvider sends `output_config.effort`, clamps off/minimal up to
//      "low", and steps xhigh/max down on a 400.
// Every model call in here hits a local stub server; no test may call a real API.

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { REASONING_EFFORTS } = await imp("engine/protocol/dist/index.js");
const { Session, Engine, settingsSchema } = await imp("engine/core/dist/index.js");
const { createDefaultRegistry } = await imp("engine/tools/dist/index.js");
const { FakeProvider, OpenAICompatProvider, AnthropicProvider, EffortClamp } = await imp("engine/providers/dist/index.js");

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  PASS  ${name}`); };
const bad = (name, why) => { fail++; console.log(`  FAIL  ${name} — ${why}`); };
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === false) bad(name, "returned false");
    else ok(name);
  } catch (err) {
    bad(name, err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── stub servers ───────────────────────────────────────────────────────────
/**
 * A programmable HTTP stub. `route(req, body)` returns
 *   { status, json }            — a plain JSON reply
 *   { sse: [chunk, ...] }       — an OpenAI-style SSE stream of JSON chunks
 *   { ndjson: [line, ...] }     — an Ollama-style NDJSON stream
 * Every request (method, path, parsed body) is recorded in `seen`.
 */
function stub(route) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      seen.push({ method: req.method, path: req.url, body });
      const r = route(req, body) ?? { status: 404, json: { error: "no route" } };
      if (r.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of r.sse) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (r.ndjson) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (const line of r.ndjson) res.write(`${JSON.stringify(line)}\n`);
        res.end();
        return;
      }
      if (r.anthropicSse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const ev of r.anthropicSse) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ seen, port, origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

const okStream = { sse: [{ choices: [{ delta: { content: "fine" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }] };
const req = (over = {}) => ({
  model: "m",
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxTokens: 100,
  signal: new AbortController().signal,
  ...over,
});
async function drain(stream) {
  const events = [];
  for await (const e of stream) events.push(e);
  return events;
}

console.log("\n1. The setting\n");

await check("settingsSchema accepts every level and rejects a made-up one", () => {
  for (const level of REASONING_EFFORTS) {
    const parsed = settingsSchema.parse({ model: "m", reasoningEffort: level });
    assert(parsed.reasoningEffort === level, `lost ${level}`);
  }
  assert(settingsSchema.parse({ model: "m" }).reasoningEffort === undefined, "absent must stay absent");
  assert(!settingsSchema.safeParse({ model: "m", reasoningEffort: "ultra" }).success, "ultra must be rejected");
  assert(REASONING_EFFORTS.join(",") === "off,minimal,low,medium,high,xhigh,max", `ladder changed: ${REASONING_EFFORTS}`);
});

await check("Session passes settings.reasoningEffort to the provider on the turn call, and nothing when unset", async () => {
  for (const level of ["max", undefined]) {
    const cwd = mkdtempSync(join(tmpdir(), "magentra-effort-"));
    try {
      const settings = settingsSchema.parse({ model: "fake/model", contextWindow: 100_000, clarify: false, ...(level ? { reasoningEffort: level } : {}) });
      const provider = new FakeProvider([{ text: "done" }, { text: "done" }, { text: "done" }]);
      const session = new Session({
        cwd, settings, provider, registry: createDefaultRegistry(), emit: () => {},
        requestApproval: async () => ({ decision: "allow" }), askUser: async () => ({}),
      });
      await session.runTurn("hello");
      const turnReq = provider.requests.find((r) => r.tools.length > 0);
      assert(turnReq, "no turn request recorded");
      assert(turnReq.reasoningEffort === level, `expected ${level}, got ${turnReq.reasoningEffort}`);
      assert(typeof turnReq.onNegotiated === "function", "the turn call must listen for negotiation notes");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
});

await check("Session shows a negotiation note once per session, not once per call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "magentra-effort-"));
  try {
    const settings = settingsSchema.parse({ model: "fake/model", contextWindow: 100_000, clarify: false, reasoningEffort: "max" });
    const events = [];
    const provider = new FakeProvider([
      { text: "a", toolCalls: [{ name: "Glob", input: { pattern: "*.nothing" } }] },
      { text: "b" },
    ]);
    const inner = provider.stream.bind(provider);
    provider.stream = (r) => { r.onNegotiated?.("reasoning effort \"max\" is not available on this model — using \"high\", the nearest level it accepts"); return inner(r); };
    const session = new Session({
      cwd, settings, provider, registry: createDefaultRegistry(), emit: (e) => events.push(e),
      requestApproval: async () => ({ decision: "allow" }), askUser: async () => ({}),
    });
    await session.runTurn("go");
    const notes = events.filter((e) => e.type === "command_output" && e.text.startsWith("⚙ reasoning effort"));
    assert(provider.requests.filter((r) => r.tools.length > 0).length >= 2, "expected at least two turn calls");
    assert(notes.length === 1, `expected exactly one note, got ${notes.length}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

await check("set_connection sets reasoningEffort from the frame and clears it when the frame omits it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "magentra-effort-"));
  try {
    const settings = settingsSchema.parse({ model: "fake/model", contextWindow: 100_000, clarify: false });
    const engine = new Engine({
      cwd, settings, provider: new FakeProvider([]), registry: createDefaultRegistry(),
      providerFactory: () => new FakeProvider([]),
    });
    const base = { provider: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "m", contextWindow: 4096 };
    engine.send({ type: "set_connection", connection: { ...base, reasoningEffort: "xhigh" } });
    assert(settings.reasoningEffort === "xhigh", `not set: ${settings.reasoningEffort}`);
    engine.send({ type: "set_connection", connection: { ...base, reasoningEffort: "ultra" } });
    assert(settings.reasoningEffort === undefined, "an unknown level must not be stored");
    engine.send({ type: "set_connection", connection: { ...base, reasoningEffort: "low" } });
    engine.send({ type: "set_connection", connection: base });
    assert(settings.reasoningEffort === undefined, "absent in the frame must clear the setting");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

console.log("\n2. The effort clamp (pure)\n");

await check("EffortClamp: max → xhigh → high on value rejections; minimal → low; high refused drops the field", () => {
  const c = new EffortClamp();
  assert(c.resolve("max") === "max");
  assert(c.reject("max", false) === true && c.resolve("max") === "xhigh", "first step down");
  assert(c.reject("xhigh", false) === true && c.resolve("max") === "high", "second step down");
  assert(c.resolve("low") === "low", "low unaffected by the ceiling");
  assert(c.reject("minimal", false) === true && c.resolve("minimal") === "low", "floor rises");
  assert(c.reject("high", false) === true && c.resolve("max") === undefined && c.resolve("low") === undefined, "high refused = no field");
  const d = new EffortClamp();
  assert(d.reject("medium", true) === true && d.resolve("medium") === undefined, "unknown field = no field");
  assert(d.reject("medium", true) === false, "nothing further to learn");
  const e = new EffortClamp();
  assert(e.resolve("off") === "none" && e.reject("none", false) === true && e.resolve("off") === undefined && e.resolve("high") === "high", "none rejected only affects off");
});

console.log("\n3. OpenAI-compatible transport\n");

await check("a level rides as reasoning_effort; 'off' is 'none' plus the chat-template switch; unset sends neither", async () => {
  const s = await stub(() => okStream);
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1` });
    await drain(p.stream(req({ reasoningEffort: "high" })));
    await drain(p.stream(req({ reasoningEffort: "off" })));
    await drain(p.stream(req()));
    const [a, b, c] = s.seen.map((x) => x.body);
    assert(a.reasoning_effort === "high" && a.chat_template_kwargs === undefined, `high: ${JSON.stringify(a)}`);
    assert(b.reasoning_effort === "none" && b.chat_template_kwargs?.enable_thinking === false, `off: ${JSON.stringify(b)}`);
    assert(c.reasoning_effort === undefined && c.chat_template_kwargs === undefined, "unset must send nothing");
  } finally { s.close(); }
});

await check("over the maximum, the maximum is taken: max → xhigh → high, told once, remembered", async () => {
  const s = await stub((_r, body) => {
    if (body.reasoning_effort === "max" || body.reasoning_effort === "xhigh") {
      return { status: 400, json: { error: { message: `Invalid value: '${body.reasoning_effort}'. Supported values are: 'low', 'medium', and 'high'.`, param: "reasoning_effort" } } };
    }
    return okStream;
  });
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1` });
    const notes = [];
    const ev = await drain(p.stream(req({ reasoningEffort: "max", onNegotiated: (n) => notes.push(n) })));
    assert(ev.some((e) => e.type === "text_delta" && e.text === "fine"), "the clamped request must succeed");
    assert(s.seen.map((x) => x.body.reasoning_effort).join(">") === "max>xhigh>high", `ladder: ${s.seen.map((x) => x.body.reasoning_effort)}`);
    assert(notes.length === 1 && /using "high"/.test(notes[0]), `note: ${notes}`);
    await drain(p.stream(req({ reasoningEffort: "max", onNegotiated: (n) => notes.push(n) })));
    assert(s.seen.length === 4 && s.seen[3].body.reasoning_effort === "high", "the ceiling must be remembered — one request, already clamped");
  } finally { s.close(); }
});

await check("a body that says the FIELD is unknown drops it and says the model runs at its default", async () => {
  const s = await stub((_r, body) =>
    body.reasoning_effort !== undefined
      ? { status: 400, json: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } }
      : okStream,
  );
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1` });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "medium", onNegotiated: (n) => notes.push(n) })));
    assert(s.seen.length === 2 && s.seen[1].body.reasoning_effort === undefined, "second request must omit the field");
    assert(notes.some((n) => /does not accept a reasoning-effort setting/.test(n)), `note: ${notes}`);
  } finally { s.close(); }
});

await check("a rejected chat_template_kwargs is dropped while reasoning_effort 'none' stays", async () => {
  const s = await stub((_r, body) =>
    body.chat_template_kwargs !== undefined
      ? { status: 400, json: { error: { message: "Unrecognized request argument supplied: chat_template_kwargs" } } }
      : okStream,
  );
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1` });
    await drain(p.stream(req({ reasoningEffort: "off" })));
    assert(s.seen.length === 2, `expected one retry, saw ${s.seen.length}`);
    assert(s.seen[1].body.chat_template_kwargs === undefined && s.seen[1].body.reasoning_effort === "none", JSON.stringify(s.seen[1].body));
  } finally { s.close(); }
});

await check("a 400 that names neither field nor value still fails fast (no retry loop)", async () => {
  const s = await stub(() => ({ status: 400, json: { error: { message: "messages: must not be empty" } } }));
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1` });
    let threw = false;
    try { await drain(p.stream(req({ reasoningEffort: "max" }))); } catch { threw = true; }
    assert(threw && s.seen.length === 1, `expected one request and an error, saw ${s.seen.length}`);
  } finally { s.close(); }
});

console.log("\n4. Ollama native transport\n");

const ollamaRoute = (opts = {}) => (r, body) => {
  if (r.url === "/api/version") return { json: { version: "0.12.0" } };
  if (r.url === "/api/chat") {
    if (opts.rejectThink && body.think !== undefined) return { status: 400, json: { error: `"${body.model}" does not support thinking` } };
    if (opts.rejectThinkLevels && typeof body.think === "string") return { status: 400, json: { error: `"${body.model}" does not support thinking levels` } };
    return {
      ndjson: [
        { message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
        { message: { role: "assistant", content: "I will look" }, done: false },
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "Glob", arguments: { pattern: "*.ts" } } }] }, done: false },
        { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 42, eval_count: 7 },
      ],
    };
  }
  if (r.url === "/v1/chat/completions") return okStream;
  return null;
};

await check("with a context window and an Ollama endpoint, the turn goes to /api/chat with options.num_ctx", async () => {
  const s = await stub(ollamaRoute());
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1`, numCtx: 32768 });
    const ev = await drain(p.stream(req({ reasoningEffort: "xhigh", tools: [{ name: "Glob", description: "g", inputSchema: { type: "object" } }] })));
    const chat = s.seen.find((x) => x.path === "/api/chat");
    assert(s.seen.some((x) => x.path === "/api/version"), "must probe /api/version first");
    assert(chat, "no /api/chat request");
    assert(chat.body.options.num_ctx === 32768, `num_ctx: ${JSON.stringify(chat.body.options)}`);
    assert(chat.body.options.num_predict === 100, "max tokens rides as num_predict");
    assert(chat.body.think === "max", `xhigh must map to Ollama's max, got ${chat.body.think}`);
    assert(chat.body.tools?.[0]?.function?.name === "Glob", "tools must be forwarded");
    assert(chat.body.messages[0].role === "system" && chat.body.messages[1].role === "user", "system then user");
    assert(!s.seen.some((x) => x.path === "/v1/chat/completions"), "the /v1 route must not be used");
    const types = ev.map((e) => e.type);
    assert(types.includes("thinking_delta") && types.includes("text_delta"), `events: ${types}`);
    const start = ev.find((e) => e.type === "tool_use_start");
    const delta = ev.find((e) => e.type === "tool_use_delta");
    assert(start?.name === "Glob" && delta?.partialJson === JSON.stringify({ pattern: "*.ts" }), "tool call must be re-emitted as start/delta/end");
    const end = ev.at(-1);
    assert(end.type === "message_end" && end.stopReason === "tool_use", `stop: ${JSON.stringify(end)}`);
    assert(end.usage.inputTokens === 42 && end.usage.outputTokens === 7, `usage: ${JSON.stringify(end.usage)}`);
  } finally { s.close(); }
});

await check("Ollama: 'off' is think:false; a model without thinking levels gets a boolean; one that cannot think gets nothing — each told", async () => {
  const s = await stub(ollamaRoute({ rejectThinkLevels: true }));
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1`, numCtx: 8192 });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "off" })));
    assert(s.seen.filter((x) => x.path === "/api/chat").at(-1).body.think === false, "off must be think:false");
    await drain(p.stream(req({ reasoningEffort: "low", onNegotiated: (n) => notes.push(n) })));
    const chats = s.seen.filter((x) => x.path === "/api/chat");
    assert(chats.at(-2).body.think === "low" && chats.at(-1).body.think === true, `levels → boolean: ${chats.slice(-2).map((c) => c.body.think)}`);
    assert(notes.length === 1 && /no thinking levels/.test(notes[0]), `note: ${notes}`);
  } finally { s.close(); }
  const t = await stub(ollamaRoute({ rejectThink: true }));
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${t.origin}/v1`, numCtx: 8192 });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "high", onNegotiated: (n) => notes.push(n) })));
    const chats = t.seen.filter((x) => x.path === "/api/chat");
    assert(chats.length === 3 && chats[2].body.think === undefined, `expected level → boolean → none, saw ${chats.map((c) => c.body.think)}`);
    assert(notes.some((n) => /cannot switch thinking/.test(n)), `note: ${notes}`);
    await drain(p.stream(req({ reasoningEffort: "high" })));
    assert(t.seen.filter((x) => x.path === "/api/chat").length === 4, "learned once: no extra retries on the next call");
  } finally { t.close(); }
});

await check("Ollama: a tool result names the tool it answers, images ride as bare base64, thinking is not replayed", async () => {
  const s = await stub(ollamaRoute());
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1`, numCtx: 8192 });
    await drain(p.stream(req({
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "QUJD", mediaType: "image/png" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "ok" }, { type: "tool_use", id: "c1", name: "Read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "file body" }] },
      ],
    })));
    const m = s.seen.find((x) => x.path === "/api/chat").body.messages;
    assert(m[1].role === "user" && m[1].images?.[0] === "QUJD", JSON.stringify(m[1]));
    assert(m[2].role === "assistant" && m[2].tool_calls[0].function.arguments.path === "a" && m[2].thinking === undefined && !/secret/.test(JSON.stringify(m[2])), JSON.stringify(m[2]));
    assert(m[3].role === "tool" && m[3].tool_name === "Read" && m[3].tool_call_id === "c1" && m[3].content === "file body", JSON.stringify(m[3]));
  } finally { s.close(); }
});

await check("not Ollama (no /api/version) → the /v1 route as before; no window asked → no probe at all", async () => {
  const s = await stub((r) => (r.url === "/v1/chat/completions" ? okStream : null));
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${s.origin}/v1`, numCtx: 8192 });
    await drain(p.stream(req()));
    assert(s.seen.some((x) => x.path === "/api/version") && s.seen.at(-1).path === "/v1/chat/completions", `paths: ${s.seen.map((x) => x.path)}`);
    assert(s.seen.at(-1).body.num_ctx === 8192, "the /v1 body still carries the hint for servers that might read it");
  } finally { s.close(); }
  const t = await stub(ollamaRoute());
  try {
    const p = new OpenAICompatProvider({ apiKey: "", baseUrl: `${t.origin}/v1` });
    await drain(p.stream(req({ reasoningEffort: "medium" })));
    assert(!t.seen.some((x) => x.path === "/api/version"), "no numCtx → no Ollama probe");
    assert(t.seen.at(-1).path === "/v1/chat/completions" && t.seen.at(-1).body.reasoning_effort === "medium", "effort still goes through /v1 where Ollama maps it to think");
  } finally { t.close(); }
});

console.log("\n5. Anthropic\n");

const anthropicOk = {
  anthropicSse: [
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fine" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ],
};

await check("Anthropic: effort rides as output_config.effort; off/minimal clamp UP to low and say so", async () => {
  const s = await stub(() => anthropicOk);
  try {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl: s.origin });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "high" })));
    await drain(p.stream(req({ reasoningEffort: "off", onNegotiated: (n) => notes.push(n) })));
    await drain(p.stream(req()));
    const [a, b, c] = s.seen.map((x) => x.body);
    assert(a.output_config?.effort === "high", JSON.stringify(a.output_config));
    assert(b.output_config?.effort === "low" && b.thinking === undefined, `off: ${JSON.stringify(b.output_config)} ${JSON.stringify(b.thinking)}`);
    assert(notes.length === 1 && /lowest effort level is "low"/.test(notes[0]), `note: ${notes}`);
    assert(c.output_config === undefined, "unset must send nothing");
  } finally { s.close(); }
});

await check("Anthropic: max → xhigh → high on 400s naming effort; an effort-less model drops the field", async () => {
  const s = await stub((_r, body) => {
    const e = body.output_config?.effort;
    if (e === "max" || e === "xhigh") return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: `output_config.effort: "${e}" is not supported on this model` } } };
    return anthropicOk;
  });
  try {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl: s.origin });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "max", onNegotiated: (n) => notes.push(n) })));
    assert(s.seen.map((x) => x.body.output_config?.effort).join(">") === "max>xhigh>high", `ladder: ${s.seen.map((x) => x.body.output_config?.effort)}`);
    assert(notes.length === 1 && /using "high"/.test(notes[0]), `note: ${notes}`);
  } finally { s.close(); }
  const t = await stub((_r, body) =>
    body.output_config !== undefined
      ? { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "output_config.effort is not supported for this model" } } }
      : anthropicOk,
  );
  try {
    const p = new AnthropicProvider({ apiKey: "k", baseUrl: t.origin });
    const notes = [];
    await drain(p.stream(req({ reasoningEffort: "medium", onNegotiated: (n) => notes.push(n) })));
    assert(t.seen.length === 2 && t.seen[1].body.output_config === undefined, `expected one retry without the field, saw ${t.seen.length}`);
    assert(notes.some((n) => /no effort setting/.test(n)), `note: ${notes}`);
  } finally { t.close(); }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
