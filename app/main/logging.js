"use strict";

// Black-box session log: an NDJSON trace of everything the app and engine did,
// written per launch under <workspace>/.magentra/logs/. Secrets are redacted on
// the way in, and old logs are pruned. Self-contained: it owns its own buffer
// and flush timer.

const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Black-box session logging (NDJSON, one file per app launch per workspace)
// ---------------------------------------------------------------------------

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

const SESSION_TIMESTAMP = formatTimestamp(new Date());
const SENSITIVE_KEY_RE = /key|token|secret/i;

let currentLogWorkspace = null;
let currentLogFile = null;
let preWorkspaceLogBuffer = [];
let pendingLogQueue = [];
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

// Recursive with a depth cap: a secret nested inside {config:{auth:{apiKey}}}
// must not survive just because it sat two levels down. Beyond the cap the
// value is stringified-truncated rather than trusted.
const REDACT_MAX_DEPTH = 4;

function redact(data, depth = 0) {
  if (!data || typeof data !== "object") return data;
  if (depth >= REDACT_MAX_DEPTH) return "[depth capped]";
  if (Array.isArray(data)) return data.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = k === "env" || SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function flushLog() {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
  if (!currentLogFile || pendingLogQueue.length === 0) return;
  const chunk = pendingLogQueue.join("\n") + "\n";
  pendingLogQueue = [];
  try {
    fs.appendFileSync(currentLogFile, chunk, "utf8");
  } catch (err) {
    console.error("Failed to write session log:", err);
  }
}

function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    flushLog();
  }, 500);
}

function enqueueLogLine(line) {
  if (!currentLogFile) {
    preWorkspaceLogBuffer.push(line);
    if (preWorkspaceLogBuffer.length > 2000) preWorkspaceLogBuffer.shift();
    return;
  }
  pendingLogQueue.push(line);
  if (pendingLogQueue.length >= 50) {
    flushLog();
  } else {
    scheduleLogFlush();
  }
}

function logEvent(ch, data) {
  const entry = { ts: new Date().toISOString(), ch, data: redact(data) };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, ch, data: String(data) });
  }
  if (line.length > 2048) {
    line = line.slice(0, 2048) + "…[truncated]";
  }
  enqueueLogLine(line);
  // App-level channels also mirror to userData/logs so a crash BEFORE any
  // workspace opens still leaves a findable log. Low-frequency, so a direct
  // append is fine.
  if (fallbackLogFile && (ch === "sys" || ch === "renderer")) {
    try {
      fs.appendFileSync(fallbackLogFile, line + "\n", "utf8");
    } catch {
      // the mirror is best-effort
    }
  }
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

function setLogWorkspace(workspace) {
  if (!workspace) return;
  const previousWorkspace = currentLogWorkspace;
  const previousLogFile = currentLogFile;

  if (previousLogFile && previousWorkspace && previousWorkspace !== workspace) {
    logEvent("sys", { ev: "workspace-switched", from: previousWorkspace, to: workspace });
    flushLog();
  }

  const logsDir = path.join(workspace, ".magentra", "logs");
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create session log directory:", err);
    return;
  }
  pruneOldLogs(logsDir);

  currentLogWorkspace = workspace;
  currentLogFile = path.join(logsDir, `desktop-${SESSION_TIMESTAMP}.log`);
  pendingLogQueue = [];

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
  setLogWorkspace,
  flushLog,
  initFallbackLog,
  activeLogsDir,
};
