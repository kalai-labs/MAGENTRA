"use strict";

// Black-box session log: an NDJSON trace of everything the app and engine did,
// written per launch under <workspace>/.magentra/logs/. Secrets are redacted on
// the way in, and old logs are pruned. Self-contained: it owns its own buffers
// and flush timer.
//
// It has to read on its own, without the transcript (field test 2026-09-23,
// L-01…L-04): every line is valid JSON, token counts survive redaction,
// streamed deltas are folded into one line per run, a finished tool call says
// how long it took, and a tab's lines land in THAT tab's workspace log.

const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Black-box session logging (NDJSON, one file per app launch per workspace)
// ---------------------------------------------------------------------------

/** A launch's file stamp, in UTC and marked so ("20260923-150141Z"): the lines'
 *  own `ts` are UTC ISO, and a local-time name beside UTC lines read as a
 *  three-hour gap. */
function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const SESSION_TIMESTAMP = formatTimestamp(new Date());

/** How a key whose value is a secret ENDS, compared without case, `_` or `-`
 *  (apiKey, x-api-key, sessionToken, clientSecret, Authorization). A suffix,
 *  never a substring: /key|token/ also hid every inputTokens and contextTokens
 *  figure — "tokens" ends in an s — which is what a reader of this log most needs. */
const SECRET_KEY_ENDINGS = ["key", "token", "secret", "password", "passwd", "authorization", "cookie", "credential", "credentials"];
/** Words that make any key a secret wherever they sit in it (secrets, apiKeys,
 *  privateKeyPem, secretAccessKeyId) — none of them is part of a token count. */
const SECRET_KEY_WORDS = ["secret", "password", "passwd", "apikey", "privatekey", "accesskey", "credential"];
/** A string that looks like a credential, whatever key it sits under. */
const SECRET_VALUE_RE = /^\s*(?:bearer\s+\S|(?:sk|rk|pk)[-_][A-Za-z0-9_-]{16,}|(?:fw|gsk|hf)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-|AIza[0-9A-Za-z_-]{20,})/i;
/**
 * The same credential shapes INSIDE a longer string — a Bash command's
 * `-H "Authorization: Bearer sk-…"`, a Write of a `.env`, a command's output —
 * each replaced where it sits, so the rest of the line stays readable.
 */
const EMBEDDED_SECRET_RES = [
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:fw|gsk|hf)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\b(?:xai|glpat|nvapi|pplx|csk)-[A-Za-z0-9_-]{20,}|\br8_[A-Za-z0-9]{20,}|\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bya29\.[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  // An env-style assignment of a secret: OPENAI_API_KEY=…, DB_PASSWORD: "…"
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))(\s*[=:]\s*)(["']?)[^\s"'&;]{4,}\3/g, "$1$2$3[redacted]$3"],
  // A password in a URL: postgres://user:hunter2@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1[redacted]@"],
];

/** `text` with every embedded credential replaced. */
function scrubSecrets(text) {
  let out = text;
  for (const [re, replacement] of EMBEDDED_SECRET_RES) out = out.replace(re, replacement);
  return out;
}

function isSecretKey(k) {
  const name = k.toLowerCase().replace(/[-_]/g, "");
  return k === "env" || SECRET_KEY_ENDINGS.some((end) => name.endsWith(end)) || SECRET_KEY_WORDS.some((w) => name.includes(w));
}

/** Longest string kept whole; longer ones keep their head and say how much went. */
const STRING_CAP = 1000;
/** Longest array kept whole; the rest is one marker entry. */
const ARRAY_CAP = 100;
// A recursion guard, not a size limit — size is bounded by the two caps above.
// It was 4, which turned every question_request option into "[depth capped]".
const REDACT_MAX_DEPTH = 12;

/**
 * The value as it is logged: secrets hidden, long strings and arrays shortened
 * INSIDE the object, so the line built from it is always valid JSON and the
 * shortened values say by how much.
 */
function redact(data, depth = 0) {
  if (typeof data === "string") {
    if (SECRET_VALUE_RE.test(data)) return "[redacted]";
    if (data.length <= STRING_CAP) return scrubSecrets(data);
    // Scrub a little past the cut, so a key that straddles it is still whole
    // when it is matched, and never leaves its head behind.
    return `${scrubSecrets(data.slice(0, STRING_CAP + 256)).slice(0, STRING_CAP)}…[+${data.length - STRING_CAP} chars]`;
  }
  if (!data || typeof data !== "object") return data;
  if (depth >= REDACT_MAX_DEPTH) return "[depth capped]";
  if (Array.isArray(data)) {
    const kept = data.slice(0, ARRAY_CAP).map((v) => redact(v, depth + 1));
    if (data.length > ARRAY_CAP) kept.push(`…[+${data.length - ARRAY_CAP} items]`);
    return kept;
  }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = isSecretKey(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

let currentLogWorkspace = null;
let currentLogFile = null;
let preWorkspaceLogBuffer = [];
/** Lines waiting to be written, per log file. */
const pendingLogQueues = new Map();
/** The log file of every workspace a line has been routed to this launch. */
const workspaceLogFiles = new Map();
let logFlushTimer = null;
let fallbackLogFile = null;
let fallbackLogDir = null;

/** Arms the userData/logs mirror; call once at app startup, before any workspace opens. */
function initFallbackLog(userDataDir) {
  try {
    fallbackLogDir = path.join(userDataDir, "logs");
    fs.mkdirSync(fallbackLogDir, { recursive: true });
    pruneOldLogs(fallbackLogDir);
    fallbackLogFile = path.join(fallbackLogDir, `desktop-${SESSION_TIMESTAMP}.log`);
  } catch (err) {
    console.error("Failed to init fallback log:", err);
  }
}

/** The folder "Open logs" should reveal: workspace logs when open, else userData/logs. */
function activeLogsDir() {
  if (currentLogFile) return path.dirname(currentLogFile);
  return fallbackLogDir;
}

/** This launch's log file in `workspace`, its folder created (and pruned) on first use. */
function logFileFor(workspace) {
  if (workspaceLogFiles.has(workspace)) return workspaceLogFiles.get(workspace);
  const logsDir = path.join(workspace, ".magentra", "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    // Remembered, so every later line does not retry (and report) the mkdir.
    console.error("Failed to create session log directory:", err);
    workspaceLogFiles.set(workspace, null);
    return null;
  }
  pruneOldLogs(logsDir);
  const file = path.join(logsDir, `desktop-${SESSION_TIMESTAMP}.log`);
  workspaceLogFiles.set(workspace, file);
  return file;
}

function flushLog() {
  closeDeltaRuns();
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  for (const [file, lines] of pendingLogQueues) {
    if (lines.length === 0) continue;
    pendingLogQueues.set(file, []);
    try {
      fs.appendFileSync(file, lines.join("\n") + "\n", "utf8");
    } catch (err) {
      console.error("Failed to write session log:", err);
    }
  }
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushLog();
  }, 500);
}

function enqueueLogLine(line, file) {
  if (!file) {
    preWorkspaceLogBuffer.push(line);
    if (preWorkspaceLogBuffer.length > 2000) preWorkspaceLogBuffer.shift();
    return;
  }
  const queue = pendingLogQueues.get(file) ?? [];
  queue.push(line);
  pendingLogQueues.set(file, queue);
  if (queue.length >= 50) {
    flushLog();
  } else {
    scheduleLogFlush();
  }
}

/**
 * The file a line for `target` goes to: its workspace's log; the userData log
 * when that workspace's log folder cannot be made (never another workspace's);
 * the focused workspace's log for a line with no workspace.
 */
function logFileOf(target) {
  if (target && target.workspace) return logFileFor(target.workspace) ?? fallbackLogFile;
  return currentLogFile;
}

/**
 * One line. `target` routes a tab-bound line — `{ workspace, tabId }` — to that
 * tab's own workspace log and names the tab on it; without one the line goes to
 * the focused workspace's log.
 */
function logEvent(ch, data, target) {
  const tabId = target && target.tabId;
  const file = logFileOf(target);
  // A line lands after the deltas it followed: close that tab's open run — or,
  // for a line with no tab, every run headed for the same file.
  if (tabId && deltaRuns.has(tabId)) closeDeltaRun(tabId);
  else if (!tabId) for (const [key, run] of [...deltaRuns]) if (logFileOf(run.target) === file) closeDeltaRun(key);
  const entry = { ts: new Date().toISOString(), ch, ...(tabId ? { tab: tabId } : {}), data: redact(data) };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, ch, data: redact(String(data)) });
  }
  enqueueLogLine(line, file);
  // App-level channels also mirror to userData/logs so a crash BEFORE any
  // workspace opens still leaves a findable log. Low-frequency, so a direct
  // append is fine.
  if (fallbackLogFile && file !== fallbackLogFile && (ch === "sys" || ch === "renderer")) {
    try {
      fs.appendFileSync(fallbackLogFile, line + "\n", "utf8");
    } catch {
      // the mirror is best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Engine frames: deltas folded into runs, tool calls timed
// ---------------------------------------------------------------------------

/** Frames that arrive once per token: folded into one line per run. */
const DELTA_TYPES = new Set(["thinking_delta", "text_delta", "tool_output_delta"]);
/** A run is closed and written after this long, so a long stream still leaves a line a second. */
const DELTA_RUN_MS = 1000;
/** How much of a run's text is kept: its head, with room for the marker that counts the rest. */
const RUN_HEAD = STRING_CAP - 40;
/** Open delta runs, per tab. */
const deltaRuns = new Map();
let deltaRunTimer = null;
/** When each running tool call started, per tab and call id. */
const toolStarts = new Map();

function closeDeltaRun(key) {
  const run = deltaRuns.get(key);
  if (!run) return;
  deltaRuns.delete(key);
  const text = run.chars > run.text.length ? `${run.text}…[+${run.chars - run.text.length} chars]` : run.text;
  logEvent(
    "engine",
    { type: run.type, ...(run.id !== undefined ? { id: run.id } : {}), deltas: run.count, chars: run.chars, from: run.from, text },
    run.target,
  );
}

function closeDeltaRuns() {
  if (deltaRunTimer) {
    clearTimeout(deltaRunTimer);
    deltaRunTimer = null;
  }
  for (const key of [...deltaRuns.keys()]) closeDeltaRun(key);
}

/**
 * Log one engine frame. Deltas join the tab's open run (a new run starts on a
 * different type or tool id, or once the run is a second old); any other frame
 * first closes the tab's run, so the log keeps the stream's order. A
 * tool_call_finished gains the durationMs since its tool_call_started.
 */
function logEngineFrame(event, target) {
  const key = (target && target.tabId) || "";
  if (event && DELTA_TYPES.has(event.type)) {
    const text = typeof event.text === "string" ? event.text : "";
    const run = deltaRuns.get(key);
    if (run && run.type === event.type && run.id === event.id && Date.now() - run.started < DELTA_RUN_MS) {
      run.count += 1;
      run.chars += text.length;
      // The head only; closeDeltaRun says how many characters went unwritten.
      if (run.text.length < RUN_HEAD) run.text += text.slice(0, RUN_HEAD - run.text.length);
      return;
    }
    closeDeltaRun(key);
    deltaRuns.set(key, {
      type: event.type,
      id: event.id,
      count: 1,
      chars: text.length,
      text: text.slice(0, RUN_HEAD),
      from: new Date().toISOString(),
      started: Date.now(),
      target,
    });
    if (!deltaRunTimer) {
      deltaRunTimer = setTimeout(() => {
        deltaRunTimer = null;
        closeDeltaRuns();
      }, DELTA_RUN_MS);
    }
    return;
  }
  closeDeltaRun(key);
  let frame = event;
  if (event && event.type === "tool_call_started" && event.id !== undefined) {
    // Calls that never finish (an engine that died) must not pile up.
    if (toolStarts.size >= 1000) toolStarts.delete(toolStarts.keys().next().value);
    toolStarts.set(`${key}\0${event.id}`, { seen: Date.now(), at: event.at });
  } else if (event && event.type === "tool_call_finished" && event.id !== undefined) {
    const startKey = `${key}\0${event.id}`;
    const started = toolStarts.get(startKey);
    if (started !== undefined) {
      toolStarts.delete(startKey);
      // The engine's own clock when both frames carry it (a batch's finished
      // frames can reach main well after each call ended); else main's.
      const durationMs =
        typeof event.at === "number" && typeof started.at === "number" ? event.at - started.at : Date.now() - started.seen;
      frame = { ...event, durationMs };
    }
  }
  logEvent("engine", frame, target);
}

function pruneOldLogs(logsDir) {
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => /^desktop-.*\.log$/.test(f))
      .map((f) => {
        const full = path.join(logsDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          // ignore
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(10)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {
        // ignore
      }
    }
  } catch {
    // logs dir may not exist yet / not readable; ignore
  }
}

/** Make `workspace` the focused one: lines with no tab go to its log from now on. */
function setLogWorkspace(workspace) {
  if (!workspace) return;
  const previousWorkspace = currentLogWorkspace;
  if (currentLogFile && previousWorkspace && previousWorkspace !== workspace) {
    logEvent("sys", { ev: "workspace-switched", from: previousWorkspace, to: workspace });
  }
  // Queued lines belong to the file they were queued for; write them before
  // the default target moves. (This used to empty the queue instead — on
  // every focus change, even back to the same workspace.)
  flushLog();

  const file = logFileFor(workspace);
  if (!file) return;
  currentLogWorkspace = workspace;
  currentLogFile = file;

  if (preWorkspaceLogBuffer.length > 0) {
    const chunk = preWorkspaceLogBuffer.join("\n") + "\n";
    preWorkspaceLogBuffer = [];
    try {
      fs.appendFileSync(currentLogFile, chunk, "utf8");
    } catch (err) {
      console.error("Failed to flush pre-workspace session log buffer:", err);
    }
  }
}

module.exports = {
  formatTimestamp,
  redact,
  logEvent,
  logEngineFrame,
  setLogWorkspace,
  flushLog,
  initFallbackLog,
  activeLogsDir,
};
