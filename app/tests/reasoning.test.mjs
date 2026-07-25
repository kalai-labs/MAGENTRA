// Reasoning-leak defenses: inline <think> segregation in the OpenAI-compatible
// provider, and robust self-verify DONE detection. Both regressions surfaced
// together when the active model was a reasoning model (deepseek) served over an
// OpenAI-compatible endpoint that inlines its chain of thought into `content`.

import assert from "node:assert/strict";
import { ThinkTagSplitter } from "../../engine/providers/dist/openai-compat.js";
import { isSelfVerifyDone } from "../../engine/core/dist/runtime/session.js";

/** Feed a whole content string one chunk at a time and collect the result. */
function run(chunks) {
  const s = new ThinkTagSplitter();
  let text = "";
  let thinking = "";
  for (const c of chunks) {
    const r = s.push(c);
    text += r.text;
    thinking += r.thinking;
  }
  const tail = s.flush();
  return { text: text + tail.text, thinking: thinking + tail.thinking };
}

// ── inline <think> fully wrapped ─────────────────────────────────────────────
{
  const r = run(["<think>weighing options</think>The answer is 42."]);
  assert.equal(r.text, "The answer is 42.");
  assert.equal(r.thinking, "weighing options");
}

// ── stray closing </think> only (implicit open from the chat template) ───────
// This is the reported bug: the visible bubble started with "</think>".
{
  const r = run(["</think>\n\nThe answer is 42."]);
  assert.equal(r.text, "\n\nThe answer is 42.");
  assert.equal(r.thinking, "");
}

// ── tag split across SSE chunk boundaries (both open and close) ──────────────
{
  const r = run(["<thi", "nk>plan", "ning</thi", "nk>done"]);
  assert.equal(r.text, "done");
  assert.equal(r.thinking, "planning");
}

// ── single-character dribble of the whole stream ─────────────────────────────
{
  const full = "<think>abc</think>xyz";
  const r = run([...full]); // one char per chunk
  assert.equal(r.text, "xyz");
  assert.equal(r.thinking, "abc");
}

// ── <thinking> long-form variant ─────────────────────────────────────────────
{
  const r = run(["<thinking>hmm</thinking>ok"]);
  assert.equal(r.text, "ok");
  assert.equal(r.thinking, "hmm");
}

// ── a literal '<' that is NOT a think tag is preserved verbatim ──────────────
{
  const r = run(["if a < b and c ", "< d then loop"]);
  assert.equal(r.text, "if a < b and c < d then loop");
  assert.equal(r.thinking, "");
}

// ── a lone trailing '<' held then resolved to plain text on flush ────────────
{
  const r = run(["done <"]);
  assert.equal(r.text, "done <");
  assert.equal(r.thinking, "");
}

// ── clean answer with no reasoning passes straight through ───────────────────
{
  const r = run(["just a normal answer"]);
  assert.equal(r.text, "just a normal answer");
  assert.equal(r.thinking, "");
}

// ── isSelfVerifyDone: the sentinel, decorated and repeated, ends the turn ─────
for (const done of ["DONE", "done", " DONE ", "DONE.", "DONE!", "**DONE**", "DONE DONE DONE", "DONE.\nDONE", "`DONE`", "DONE…"]) {
  assert.equal(isSelfVerifyDone(done), true, `should be DONE: ${JSON.stringify(done)}`);
}

// ── isSelfVerifyDone: genuine continued work is NOT swallowed (must reveal) ───
for (const work of [
  "",
  "Not done yet, fixing the bug.",
  "DONE and now cleaning up",
  "1. first\n2. second",
  "The task is complete.",
  "</think> Let me confirm the task list is fully clean", // leaked reasoning must never read as DONE
]) {
  assert.equal(isSelfVerifyDone(work), false, `should NOT be DONE: ${JSON.stringify(work)}`);
}

console.log("reasoning.test.mjs: all assertions passed");
