#!/usr/bin/env node
/**
 * MAGENTRA driver for Terminal-Bench 2.0 (Harbor "installed agent").
 *
 * A second NDJSON frontend to the MAGENTRA engine — the desktop app is the
 * first. It spawns the UNMODIFIED engine bundle, switches the session to
 * OVERDRIVE, sends exactly one user turn (the task instruction), and exits
 * when that turn finishes. The engine is used exactly as the product ships
 * it; everything benchmark-shaped lives on this side of the stdio seam.
 *
 * Interactive frames are answered mechanically:
 *   permission_request -> allow_session  (defensive only: OVERDRIVE never asks)
 *   question_request   -> the first option of every question
 *
 * Env contract (set by magentra_agent.py):
 *   MAGENTRA_TB_INSTRUCTION  path of the task instruction text    (required)
 *   MAGENTRA_TB_EVENTS       ndjson log of every frame            (default /logs/agent/magentra-events.ndjson)
 *   MAGENTRA_TB_RESULT       summary json written on exit         (default /logs/agent/magentra-result.json)
 *   MAGENTRA_TB_ENGINE       engine bundle path                   (default engine.cjs beside this file)
 *   MAGENTRA_TB_CWD          workspace the engine operates on     (default process.cwd())
 *   MAGENTRA_TB_TIMEOUT_SEC  hard driver timeout, 0 = none        (default 0; Harbor owns task timeouts)
 *   MAGENTRA_MODEL / MAGENTRA_API_KEY / MAGENTRA_BASE_URL         read by the engine itself
 *
 * Exit codes: 0 turn finished cleanly · 1 turn ended in error (stopReason
 * "error") or the engine failed outright · 124 driver timeout.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const instructionPath = env.MAGENTRA_TB_INSTRUCTION;
if (!instructionPath) {
  console.error("MAGENTRA_TB_INSTRUCTION is not set — nothing to run.");
  process.exit(2);
}
const instruction = readFileSync(instructionPath, "utf8").trim();
const enginePath = env.MAGENTRA_TB_ENGINE ?? join(HERE, "engine.cjs");
const workspace = resolve(env.MAGENTRA_TB_CWD ?? process.cwd());
const eventsPath = env.MAGENTRA_TB_EVENTS ?? "/logs/agent/magentra-events.ndjson";
const resultPath = env.MAGENTRA_TB_RESULT ?? "/logs/agent/magentra-result.json";
const timeoutSec = Number(env.MAGENTRA_TB_TIMEOUT_SEC ?? "0");

for (const p of [eventsPath, resultPath]) {
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* mounted dirs may pre-exist read-only parents; the write error will say */
  }
}

const startedAt = Date.now();
const result = {
  ok: false,
  stopReason: null,
  usage: null,
  contextTokens: null,
  model: null,
  costUsd: null,
  failureReason: null,
  fatalError: null,
  durationMs: 0,
  toolCalls: 0,
  turns: 0,
};
let rateCard = {};

function logEvent(direction, frame) {
  try {
    appendFileSync(eventsPath, JSON.stringify({ t: Date.now(), dir: direction, frame }) + "\n");
  } catch {
    /* events are diagnostics; losing them must not kill the run */
  }
}

function writeResult() {
  result.durationMs = Date.now() - startedAt;
  try {
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`failed to write result file: ${err.message}`);
  }
}

const child = spawn(process.execPath, [enginePath, "--cwd", workspace], {
  cwd: workspace,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

// A frame can arrive AFTER finish() has ended stdin: readline keeps delivering
// lines already buffered in the pipe, and question_request is reachable under
// OVERDRIVE (AskUserQuestion is in the default registry). Writing to an ended
// stream raises ERR_STREAM_WRITE_AFTER_END as an ASYNC 'error' event, not a
// throw — which is why finish()'s try/catch never caught it, and why one trial
// (train-fasttext) died here with the whole run's only non-timeout crash.
// Dropping the response is safe: the engine resolves pending questions when it
// is interrupted, so nothing is left waiting on us.
function sendFrame(frame) {
  if (finishing || !child.stdin.writable) {
    logEvent("dropped", frame);
    return;
  }
  logEvent("out", frame);
  child.stdin.write(JSON.stringify(frame) + "\n");
}

let finishing = false;
// Same hazard from the other direction: once the engine is gone, an in-flight
// write surfaces as an unhandled 'error' and kills the driver with exit 1,
// bypassing finish()'s own exit code.
child.stdin.on("error", (err) => {
  logEvent("stdin-error", { message: err.message, code: err.code });
});
function finish(code) {
  if (finishing) return;
  finishing = true;
  writeResult();
  // EOF on stdin is the engine's own shutdown signal (serve.ts): it interrupts
  // any in-flight work, drains events, and exits 0. Escalate only if it hangs.
  try {
    child.stdin.end();
  } catch {
    /* already gone */
  }
  const term = setTimeout(() => child.kill("SIGTERM"), 15_000);
  const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
  child.once("exit", () => {
    clearTimeout(term);
    clearTimeout(kill);
    process.exit(code);
  });
}

if (timeoutSec > 0) {
  const guard = setTimeout(() => {
    console.error(`driver timeout after ${timeoutSec}s — interrupting engine.`);
    result.fatalError = `driver timeout after ${timeoutSec}s`;
    finish(124);
  }, timeoutSec * 1000);
  guard.unref();
}

child.on("error", (err) => {
  console.error(`failed to spawn engine: ${err.message}`);
  result.fatalError = `spawn: ${err.message}`;
  writeResult();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (finishing) return;
  // The engine died before the turn finished — a plumbing or provider failure.
  console.error(`engine exited early (code ${code}, signal ${signal ?? "none"})`);
  if (!result.fatalError) result.fatalError = `engine exited early (code ${code})`;
  writeResult();
  process.exit(code === 0 ? 1 : (code ?? 1));
});

// Engine stderr carries boot warnings — keep them visible and logged.
createInterface({ input: child.stderr }).on("line", (line) => {
  if (line.trim() === "") return;
  logEvent("stderr", line);
  console.error(`[engine] ${line}`);
});

function answersFor(questions) {
  const answers = {};
  questions.forEach((q, i) => {
    const first = q.options?.[0]?.label;
    answers[`q:${i}`] = [first ?? "Proceed with your best judgment."];
  });
  return answers;
}

function costOf(usage, model) {
  const rate = rateCard[model];
  if (!rate || !usage) return null;
  const per = 1_000_000;
  return (
    (usage.inputTokens * rate.input) / per +
    (usage.outputTokens * rate.output) / per +
    (usage.cacheReadTokens * (rate.cacheRead ?? rate.input)) / per +
    (usage.cacheWriteTokens * (rate.cacheWrite ?? rate.input)) / per
  );
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    logEvent("unparseable", line);
    return;
  }
  logEvent("in", frame);

  switch (frame.type) {
    case "session_started":
      result.model = frame.model;
      rateCard = frame.rateCard ?? {};
      // Order matters: OVERDRIVE first, so the one turn runs fully autonomous
      // (no deletion/protected-path prompts, caps lifted, self-verify end check).
      sendFrame({ type: "set_overdrive", enabled: true });
      sendFrame({ type: "user_message", text: instruction });
      break;
    case "turn_started":
      result.turns += 1;
      break;
    case "tool_call_started":
      result.toolCalls += 1;
      break;
    case "permission_request":
      // Unreachable under OVERDRIVE by design; answered anyway so a future
      // stance change can never hang a benchmark run.
      sendFrame({ type: "permission_response", id: frame.id, decision: "allow_session" });
      break;
    case "question_request":
      sendFrame({ type: "question_response", id: frame.id, answers: answersFor(frame.questions ?? []) });
      break;
    case "turn_finished": {
      result.stopReason = frame.stopReason;
      result.usage = frame.usage;
      result.contextTokens = frame.contextTokens;
      result.costUsd = costOf(frame.usage, result.model);
      // A turn that DIED is not a turn that finished. The engine emits
      // error{fatal:false} and then turn_finished{stopReason:"error"} when a
      // provider fails mid-turn, and mapping that to ok:true/exit 0 reported a
      // clean agent run over an untouched workspace — 4 trials in one 89-task
      // run, 2 of which never issued a single API request, all recorded as
      // MAGENTRA's own capability failures. Exit non-zero so the runner records
      // an agent exception instead; the verifier still runs either way.
      const died = frame.stopReason === "error";
      result.ok = !died;
      if (died) {
        // Deliberately short and free of HTTP status codes or billing words:
        // the runner substring-scans this file for "401"/"quota"/"unauthorized"
        // to detect a spent API key, and a per-task provider hiccup must not
        // masquerade as a billing wall. The detailed message already reaches
        // Harbor through the [engine error] stderr echo below.
        result.failureReason = "turn ended in error";
      }
      finish(died ? 1 : 0);
      break;
    }
    case "error":
      // Echo to stderr so Harbor's error classifiers see provider failures.
      console.error(`[engine error] ${frame.message}`);
      if (frame.fatal) {
        result.fatalError = frame.message;
        finish(1);
      }
      break;
    default:
      break; // streamed deltas, task lists, context meters — logged above
  }
});
