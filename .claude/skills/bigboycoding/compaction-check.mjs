#!/usr/bin/env node
// compaction-check — the context-window contract, asserted against the BUILT
// engine (engine/*/dist). Run: npm run build && node .claude/skills/bigboycoding/compaction-check.mjs
//
// Guards the 2026-09-01 fix for "silent death at the context limit":
//   1. the auto-compact limit is DERIVED from the connection's contextWindow
//      (× compactionThreshold), so the TUI, headless runs and subagents — which
//      never send set_compact_limit — compact too; the UI frame is only a cap.
//   2. a context overflow (HTTP 400/413, an in-band SSE {"error"} chunk, or a
//      context_overflow stop reason) compacts and RETRIES instead of ending the
//      turn — or, worse, asking the model to "continue" into a fuller window.
//   3. an output-length cutoff streak is bounded on BOTH emit sites and ends the
//      turn visibly, instead of "↻ continuing" forever.
//   4. an in-band {"error"} chunk on a 200 stream is surfaced, not swallowed as
//      a clean empty turn.
// Every scenario runs on FakeProvider (no test may call a real API).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

const { Session, settingsSchema } = await imp("engine/core/dist/index.js");
const { createDefaultRegistry } = await imp("engine/tools/dist/index.js");
const { FakeProvider, OpenAICompatProvider, ProviderHttpError, isContextOverflowError, friendlyProviderError } =
  await imp("engine/providers/dist/index.js");

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

// ── harness ────────────────────────────────────────────────────────────────
function makeSession(turns, settingsOverride = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "magentra-compaction-"));
  const settings = settingsSchema.parse({
    model: "fake/model",
    contextWindow: 100_000, // the user's number: limit = 0.8 × this = 80,000
    clarify: false,
    ...settingsOverride,
  });
  const provider = new FakeProvider(turns);
  const events = [];
  const session = new Session({
    cwd,
    settings,
    provider,
    registry: createDefaultRegistry(),
    emit: (e) => events.push(e),
    requestApproval: async () => ({ decision: "allow" }),
    askUser: async () => ({}),
  });
  const outputs = () => events.filter((e) => e.type === "command_output").map((e) => e.text);
  const finished = () => events.filter((e) => e.type === "turn_finished").pop();
  const errors = () => events.filter((e) => e.type === "error").map((e) => e.message);
  const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { session, provider, events, outputs, finished, errors, cleanup, settings, cwd };
}
const glob = { name: "Glob", input: { pattern: "*.nothing" } };
const round = (n, usage = {}) => ({ text: `round ${n}`, toolCalls: [glob], usage: { inputTokens: 100, ...usage } });

console.log("\nDerived limit — the connection's window, not a UI default\n");

await check("effective limit = compactionThreshold × contextWindow when no frame was sent", async () => {
  const h = makeSession([]);
  try {
    assert(h.session.effectiveCompactLimit() === 80_000, `got ${h.session.effectiveCompactLimit()}`);
  } finally { h.cleanup(); }
});
await check("set_compact_limit can only LOWER the derived limit (1,024,000 UI default is inert)", async () => {
  const h = makeSession([]);
  try {
    h.session.setAutoCompactLimit(1_024_000);
    assert(h.session.effectiveCompactLimit() === 80_000, `cap above window changed the limit: ${h.session.effectiveCompactLimit()}`);
    h.session.setAutoCompactLimit(50_000);
    assert(h.session.effectiveCompactLimit() === 50_000, `cap below window not honored: ${h.session.effectiveCompactLimit()}`);
  } finally { h.cleanup(); }
});
await check("an explicit 0 from the UI still means off (Additive-Only State: the key kept its meaning)", async () => {
  const h = makeSession([]);
  try {
    h.session.setAutoCompactLimit(0);
    assert(h.session.effectiveCompactLimit() === 0, `got ${h.session.effectiveCompactLimit()}`);
    assert(h.session.contextOverWarnThreshold() === false, "warn must be off when compaction is off");
  } finally { h.cleanup(); }
});
await check("compactionThreshold setting is honored (0.5 × 100k = 50k)", async () => {
  const h = makeSession([], { compactionThreshold: 0.5 });
  try {
    assert(h.session.effectiveCompactLimit() === 50_000, `got ${h.session.effectiveCompactLimit()}`);
  } finally { h.cleanup(); }
});
await check("no contextWindow set → conservative 128k fallback (× 0.8), never 'off'", async () => {
  const h = makeSession([], { contextWindow: undefined });
  try {
    assert(h.session.effectiveCompactLimit() === 102_400, `got ${h.session.effectiveCompactLimit()}`);
  } finally { h.cleanup(); }
});

console.log("\nAuto-compaction fires from settings alone (the TUI / headless path)\n");

await check("4 tool rounds, 4th reports 90k input → compaction runs mid-turn without any set_compact_limit", async () => {
  const h = makeSession([
    round(1), round(2), round(3),
    round(4, { inputTokens: 90_000 }), // ≥ 80,000 → maybeCompact fires after these results land
    { text: "SUMMARY: rounds 1-3 globbed nothing." }, // the summarizer call
    { text: "All done." },
  ]);
  try {
    await h.session.runTurn("list things");
    const auto = h.outputs().find((t) => t.startsWith("Auto-compacted"));
    assert(auto, `no Auto-compacted notice; outputs=${JSON.stringify(h.outputs())} errors=${JSON.stringify(h.errors())}`);
    assert(/80% of the 100(,|\.)?0?K?-token context window|100K-token/.test(auto) || auto.includes("context window set for this connection"),
      `notice does not name the window as the reason: ${auto}`);
    assert(h.finished()?.stopReason === "end_turn", `stopReason ${h.finished()?.stopReason}; errors=${JSON.stringify(h.errors())}`);
    // The provider saw the summarizer prompt: 4 rounds + summary + final = 6 requests.
    assert(h.provider.requests.length === 6, `expected 6 requests, saw ${h.provider.requests.length}`);
    assert(h.session.messages[0].content[0].text.includes("compacted"), "history does not start with the compaction summary");
  } finally { h.cleanup(); }
});

console.log("\nSummarizer budget — sized from the same window, not a fixed 2000\n");

await check("100k window → summary reply budget 8192 tokens (10%, capped), seen on the summarizer request", async () => {
  const h = makeSession([
    round(1), round(2), round(3), round(4, { inputTokens: 90_000 }),
    { text: "SUMMARY" }, { text: "done" },
  ]);
  try {
    await h.session.runTurn("go");
    const summary = h.provider.requests[4];
    assert(summary.tools.length === 0 && summary.system.startsWith("Summarize this coding-agent conversation"), "request 4 is not the summarizer call");
    assert(summary.maxTokens === 8192, `summarizer maxTokens ${summary.maxTokens}`);
  } finally { h.cleanup(); }
});
await check("32k window → reply 3276 tokens and an input chunk that fits, so the summarizer cannot overflow itself", async () => {
  const h = makeSession([], { contextWindow: 32_768 });
  try {
    const b = h.session.summarizerBudget();
    assert(b.replyTokens === 3276, `replyTokens ${b.replyTokens}`);
    // chunk + rolling summary + reply must fit inside the window at the shared κ
    assert(b.chunkChars / 3.5 + 2 * b.replyTokens < 32_768, `chunk ${b.chunkChars} chars does not fit a 32k window`);
    assert(b.chunkChars < 200_000, `chunk not reduced for a small window: ${b.chunkChars}`);
  } finally { h.cleanup(); }
});
await check("8k window → reply floors at 2000 and the chunk floors at 4000 chars (never degenerate)", async () => {
  const h = makeSession([], { contextWindow: 8192 });
  try {
    const b = h.session.summarizerBudget();
    assert(b.replyTokens === 2000, `replyTokens ${b.replyTokens}`);
    assert(b.chunkChars >= 4000, `chunkChars ${b.chunkChars}`);
  } finally { h.cleanup(); }
});
await check("1M window → reply capped at 8192 and chunk capped at 200k chars", async () => {
  const h = makeSession([], { contextWindow: 1_000_000 });
  try {
    const b = h.session.summarizerBudget();
    assert(b.replyTokens === 8192 && b.chunkChars === 200_000, JSON.stringify(b));
  } finally { h.cleanup(); }
});
await check("a 3,000-char tool result reaches the summarizer intact (old clip was 500 chars)", async () => {
  // FakeProvider reads each turn object lazily, so the Read can be pointed at
  // the session's own workspace after makeSession has created it.
  const read = { name: "Read", input: { file_path: "" } };
  const h = makeSession([
    { text: "r1", toolCalls: [read], usage: { inputTokens: 100 } },
    round(2), round(3), round(4, { inputTokens: 90_000 }),
    { text: "SUMMARY" }, { text: "done" },
  ]);
  try {
    writeFileSync(join(h.cwd, "big.txt"), "Z".repeat(3000));
    read.input.file_path = join(h.cwd, "big.txt");
    await h.session.runTurn("go");
    const summaryInput = JSON.stringify(h.provider.requests[4].messages[0]);
    assert(summaryInput.includes("Z".repeat(1200)), "the Read result reached the summarizer clipped to the old 500 chars");
  } finally { h.cleanup(); }
});

console.log("\nOverflow recovery — compact and retry, never 'continue' into a fuller window\n");

await check("HTTP 400 'maximum context length' mid-turn → compact, retry, finish cleanly", async () => {
  const h = makeSession([
    round(1),
    { error: new ProviderHttpError(400, "provider returned 400: This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.") },
    { text: "SUMMARY: globbed nothing." },
    { text: "Recovered and done." },
  ]);
  try {
    await h.session.runTurn("do work");
    assert(h.outputs().some((t) => t.includes("exceeded the model's context window") && t.includes("(1/2)")),
      `no recovery notice; outputs=${JSON.stringify(h.outputs())} errors=${JSON.stringify(h.errors())}`);
    assert(h.finished()?.stopReason === "end_turn", `stopReason ${h.finished()?.stopReason}; errors=${JSON.stringify(h.errors())}`);
    assert(h.errors().length === 0, `unexpected errors: ${JSON.stringify(h.errors())}`);
    assert(h.provider.requests.length === 4, `expected 4 requests, saw ${h.provider.requests.length}`);
    assert(h.session.messages[0].content[0].text.includes("compacted"), "history does not start with the compaction summary");
  } finally { h.cleanup(); }
});

await check("HTTP 413 → also treated as overflow", async () => {
  assert(isContextOverflowError(new ProviderHttpError(413, "provider returned 413: ")), "413 not classified");
});

await check("an overflow the history is too short to compact ends the turn with a FRIENDLY error, not a raw 400", async () => {
  const h = makeSession([
    { error: new ProviderHttpError(400, "provider returned 400: prompt is too long: 300000 tokens > 200000 maximum") },
  ]);
  try {
    await h.session.runTurn("first message ever");
    assert(h.finished()?.stopReason === "error", `stopReason ${h.finished()?.stopReason}`);
    const msg = h.errors()[0] ?? "";
    assert(msg.includes("exceeded the model's context window") && msg.includes("/compact"), `error not classified: ${msg}`);
  } finally { h.cleanup(); }
});

await check("context_overflow stop reason (input+output filled the window) → compact, then resume as a cutoff", async () => {
  const h = makeSession([
    round(1),
    { text: "partial answer that got cut by the window", stopReason: "context_overflow" },
    { text: "SUMMARY: globbed nothing." },
    { text: "…and the rest of the answer." },
  ]);
  try {
    await h.session.runTurn("write the answer");
    assert(h.outputs().some((t) => t.includes("hit the model's context window") && t.includes("resuming")),
      `no overflow notice; outputs=${JSON.stringify(h.outputs())} errors=${JSON.stringify(h.errors())}`);
    assert(h.outputs().some((t) => t.includes("continuing after output-length cutoff")), "the cutoff resume did not follow the compaction");
    assert(h.finished()?.stopReason === "end_turn", `stopReason ${h.finished()?.stopReason}; errors=${JSON.stringify(h.errors())}`);
    // The resume request carries the continuation reminder AFTER the compaction
    // summary. (FakeProvider records the live message array by reference, so
    // look for the reminder rather than at the last element.)
    const resume = h.provider.requests[3].messages;
    const summaryAt = resume.findIndex((m) => JSON.stringify(m).includes("Earlier conversation was compacted"));
    const reminderAt = resume.findIndex((m) => JSON.stringify(m).includes("cut off mid-output"));
    assert(summaryAt === 0, `resume request does not start with the compaction summary (index ${summaryAt})`);
    assert(reminderAt > summaryAt, "resume request lacks the length-continuation reminder after the summary");
  } finally { h.cleanup(); }
});

await check("overflow recovery is bounded: a 3rd overflow in one turn surfaces an error instead of looping", async () => {
  const overflow = () => ({ error: new ProviderHttpError(400, "provider returned 400: context_length_exceeded") });
  const h = makeSession([
    round(1), round(2), round(3),
    overflow(), { text: "S1" },
    overflow(), { text: "S2" },
    overflow(),
  ]);
  try {
    await h.session.runTurn("do work");
    assert(h.finished()?.stopReason === "error", `stopReason ${h.finished()?.stopReason}`);
    assert(h.outputs().filter((t) => t.includes("compacting older history and retrying")).length === 2, "expected exactly 2 recoveries");
    assert(h.errors().some((m) => m.includes("exceeded the model's context window")), `no friendly error: ${JSON.stringify(h.errors())}`);
  } finally { h.cleanup(); }
});

console.log("\nCutoff streak — bounded on both emit sites, visible when exhausted\n");

await check("text path: 3 resumes, then the 4th consecutive cutoff ends the turn with a ⏸ notice", async () => {
  const cut = { text: "x".repeat(40), stopReason: "max_tokens" };
  const h = makeSession([cut, cut, cut, cut, cut, cut]);
  try {
    await h.session.runTurn("write a novel");
    assert(h.provider.requests.length === 4, `expected 4 requests (1 + 3 resumes), saw ${h.provider.requests.length}`);
    assert(h.outputs().filter((t) => t.includes("continuing after output-length cutoff")).length === 3, "expected 3 resumes");
    assert(h.outputs().some((t) => t.startsWith("⏸") && t.includes("4 times in a row")), `no visible stop: ${JSON.stringify(h.outputs())}`);
    assert(h.finished()?.stopReason === "max_tokens", `stopReason ${h.finished()?.stopReason}`);
  } finally { h.cleanup(); }
});

await check("tool-call path: a cutoff mid tool call reissues at most 3 times, then stops with results in place", async () => {
  // A tool call whose JSON is truncated is the cutoff signature on this path.
  const cutCall = { text: "", toolCalls: [{ name: "Write", input: { path: "big.txt", content: "…" } }], stopReason: "max_tokens" };
  const h = makeSession([cutCall, cutCall, cutCall, cutCall, cutCall, cutCall]);
  try {
    await h.session.runTurn("write a huge file");
    assert(h.provider.requests.length === 4, `expected 4 requests, saw ${h.provider.requests.length}`);
    assert(h.outputs().some((t) => t.startsWith("⏸") && t.includes("mid tool call")), `no visible stop: ${JSON.stringify(h.outputs())}`);
    assert(h.finished()?.stopReason === "max_tokens", `stopReason ${h.finished()?.stopReason}`);
    // History must not end on a tool_use without its results (providers reject that).
    const last = h.session.messages.at(-1);
    assert(last.role === "user" && last.content.some((b) => b.type === "tool_result"), "history ends without tool results");
  } finally { h.cleanup(); }
});

await check("a complete response resets the streak (2 cutoffs, a clean answer, 2 more cutoffs → no stop)", async () => {
  const cut = { text: "x".repeat(40), stopReason: "max_tokens" };
  const h = makeSession([cut, cut, { text: "clean.", toolCalls: [glob] }, cut, cut, { text: "done." }]);
  try {
    await h.session.runTurn("go");
    assert(!h.outputs().some((t) => t.startsWith("⏸")), `streak did not reset: ${JSON.stringify(h.outputs())}`);
    assert(h.finished()?.stopReason === "end_turn", `stopReason ${h.finished()?.stopReason}; errors=${JSON.stringify(h.errors())}`);
  } finally { h.cleanup(); }
});

console.log("\nOpenAI-compat stream — in-band errors surface, finish reasons map\n");

const realFetch = globalThis.fetch;
const sse = (...lines) => new Response(lines.map((l) => `data: ${l}\n`).join("\n") + "\ndata: [DONE]\n", { status: 200 });
async function collect(provider) {
  const events = [];
  for await (const e of provider.stream({ model: "m", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], maxTokens: 10, signal: new AbortController().signal })) events.push(e);
  return events;
}
try {
  await check("a 200 stream carrying {\"error\":…} (context overflow) throws a classified ProviderHttpError, not an empty turn", async () => {
    globalThis.fetch = async () => sse(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens", code: 400 } }));
    let thrown;
    try { await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 })); } catch (e) { thrown = e; }
    assert(thrown instanceof ProviderHttpError && thrown.status === 400, `expected ProviderHttpError 400, got ${thrown}`);
    assert(isContextOverflowError(thrown), "in-band overflow not classified");
  });
  await check("a 200 stream carrying a 500-coded in-band error throws with that status (and is NOT an overflow)", async () => {
    globalThis.fetch = async () => sse(JSON.stringify({ error: { message: "upstream worker crashed", code: 500 } }));
    let thrown;
    try { await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 })); } catch (e) { thrown = e; }
    assert(thrown instanceof ProviderHttpError && thrown.status === 500, `expected 500, got ${thrown}`);
    assert(!isContextOverflowError(thrown), "a 5xx must not be treated as overflow");
  });
  await check("a healthy stream still parses (regression): text + stop → end_turn", async () => {
    globalThis.fetch = async () => sse(
      JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1 } }),
    );
    const ev = await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 }));
    assert(ev.some((e) => e.type === "text_delta" && e.text === "hi"), "text lost");
    const end = ev.at(-1);
    assert(end.type === "message_end" && end.stopReason === "end_turn" && end.usage.inputTokens === 7, `bad end: ${JSON.stringify(end)}`);
  });
  await check("finish_reason context_length_exceeded → context_overflow (not max_tokens)", async () => {
    globalThis.fetch = async () => sse(JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: "context_length_exceeded" }] }));
    const ev = await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 }));
    assert(ev.at(-1).stopReason === "context_overflow", `got ${ev.at(-1).stopReason}`);
  });
  await check("finish_reason length still → max_tokens", async () => {
    globalThis.fetch = async () => sse(JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }));
    const ev = await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 }));
    assert(ev.at(-1).stopReason === "max_tokens", `got ${ev.at(-1).stopReason}`);
  });
  await check("a 400 'max_tokens + prompt exceed the context' is an overflow, NOT a max_tokens field rejection", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("{\"error\":{\"message\":\"max_tokens is invalid: prompt + max_tokens exceed the context length of 4096\"}}", { status: 400 }); };
    let thrown;
    try { await collect(new OpenAICompatProvider({ apiKey: "", baseUrl: "http://x/v1", maxRetries: 0 })); } catch (e) { thrown = e; }
    assert(calls === 1, `field negotiation re-sent the oversized request (${calls} calls)`);
    assert(isContextOverflowError(thrown), `not classified: ${thrown}`);
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log("\nFriendly errors\n");

await check("overflow → names /compact and the Context size", async () => {
  const m = friendlyProviderError(new ProviderHttpError(400, "provider returned 400: prompt is too long: 300000 tokens > 200000 maximum"), "api.test");
  assert(m.includes("context window") && m.includes("/compact") && m.includes("Context size"), m);
});
await check("plain 400 → framed, with the server's own words", async () => {
  const m = friendlyProviderError(new ProviderHttpError(400, "provider returned 400: Unsupported parameter: foo"), "api.test");
  assert(m.includes("rejected the request (HTTP 400)") && m.includes("Unsupported parameter: foo"), m);
});
await check("401 branch unchanged (regression)", async () => {
  const m = friendlyProviderError(new ProviderHttpError(401, "provider returned 401: nope"));
  assert(m.includes("HTTP 401"), m);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
