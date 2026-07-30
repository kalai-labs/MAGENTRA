"use strict";

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  LEGACY_API_KEY_ENV_VARS,
  DEFAULT_THEME,
  THEMES,
  readConfig,
  writeConfig,
  rememberWorkspace,
  isLocalBaseUrl,
  apiKeyEnvVarFor,
  writeJsonAtomic,
  globalSettingsPath,
  readWorkspaceSettings,
  readGlobalSettings,
  readEffectiveWorkspaceSettings,
  updateWorkspaceSettings,
  shouldStartFullScreen,
} = require("./main/config.js");
const { logEvent, setLogWorkspace, flushLog, initFallbackLog, activeLogsDir } = require("./main/logging.js");
const { resolveWorkspaceFile, undoWorkspaceDiffs } = require("./main/changes.js");
const { testEndpoint, validateCredentialPayload } = require("./main/connection.js");
const { readProfiles, upsertProfile, deleteProfile, findProfile, sanitizeProfile } = require("./main/profiles.js");

const SMOKE = process.argv.includes("--smoke");

// One instance only: two engines editing the same workspace tree concurrently,
// and two writers of userData/config.json, corrupt each other. A second launch
// focuses the existing window instead (skipped for --smoke so CI can boot a
// throwaway instance beside a developer's running app).
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Portable runs extract to a temp dir whose ACLs the sandboxed Chromium child
// processes cannot read — renderer/GPU die at boot with STATUS_DLL_NOT_FOUND.
// Disable the Chromium sandbox for portable only; the renderer still runs with
// contextIsolation, no Node integration, a strict CSP, and navigation denial.
// Installed/unpacked/dev builds keep the full sandbox.
if (process.env.PORTABLE_EXECUTABLE_FILE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Linux sandbox handling deliberately does NOT live here. Chromium forks its
// zygote before this script runs, so appendSwitch("no-sandbox") would already be
// too late — the flag has to be in the process arguments. scripts/launch.js
// decides it up-front; a packaged AppImage that hits the same wall can be run
// with --no-sandbox on the command line.

// Windows toast notifications and taskbar grouping need an explicit
// AppUserModelID — without it, notifications show as "electron.app.MAGENTRA".
if (process.platform === "win32") {
  app.setAppUserModelId("com.magentra.app");
}

// The live app config. main.js is its single owner: main/config.js is pure
// (read/write/transform), so there is never a second copy that can drift.
let currentConfig = readConfig();

/** @type {BrowserWindow | null} */
let mainWindow = null;
// --- Engine pool ---------------------------------------------------------
// Each open workspace runs in its OWN engine process — a "tab". The pool holds
// per-tab process state (the child, its not-yet-exited predecessor, and stdio
// line buffers) so several workspaces can run concurrently; the engine binary
// and the wire protocol are unchanged (see docs/CONCURRENT-WORKSPACES.md). Today
// the renderer drives one tab at a time, so exactly one entry exists and the
// behaviour matches a single engine; `activeTab()` is the tab an untagged
// renderer request targets.
/**
 * @typedef {Object} EngineTab
 * @property {string} id
 * @property {string|null} workspace
 * @property {string|null} model
 * @property {import("node:child_process").ChildProcessWithoutNullStreams | null} child
 * @property {import("node:child_process").ChildProcessWithoutNullStreams | null} dying
 * @property {string} stdoutBuffer
 * @property {string} stderrBuffer
 */
/** @type {Map<string, EngineTab>} */
const engineTabs = new Map();
let tabSeq = 0;

// At most this many workspaces run at once (docs/CONCURRENT-WORKSPACES.md): a
// hard cap with manual close, no eviction. Each tab is one engine process. The
// cap is global — across every window.
const MAX_TABS = 4;

/** The BrowserWindow behind a renderer request (its own window, or the main one).
 * Each window keeps its own focused tab in `win.mgActiveTabId`, so several
 * windows can each drive their own workspaces. */
function winOf(evt) {
  try {
    return (evt && evt.sender && BrowserWindow.fromWebContents(evt.sender)) || mainWindow;
  } catch {
    return mainWindow;
  }
}

/** The active tab of a window (default: the main window) — where an untagged
 * request from that window lands. */
function activeTab(win) {
  const w = win || mainWindow;
  const id = w && w.mgActiveTabId;
  return id ? engineTabs.get(id) ?? null : null;
}

/** The window's active tab, created on first use. */
function ensureActiveTab(win) {
  const w = win || mainWindow;
  let tab = activeTab(w);
  if (!tab) tab = createTab(null, w);
  return tab;
}

function createTab(workspace, win) {
  const w = win || mainWindow;
  const id = `tab${++tabSeq}`;
  const tab = { id, workspace: workspace ?? null, model: null, child: null, dying: null, stdoutBuffer: "", stderrBuffer: "", win: w };
  engineTabs.set(id, tab);
  if (w && !w.mgActiveTabId) w.mgActiveTabId = id;
  return tab;
}

/** The tab currently showing `workspace`, or undefined — the same-folder rule
 * (one live session per folder, across ALL windows) is enforced by focusing this
 * instead of opening a second engine on the same directory. */
function tabForWorkspace(workspace) {
  for (const tab of engineTabs.values()) {
    if (tab.workspace === workspace) return tab;
  }
  return undefined;
}

/** Make a tab its window's focused one: mirror its workspace/model into
 * currentConfig (the model/restart/web-search handlers read that for the focused
 * workspace) and tell its window to swap the console in. */
function focusTab(tabId) {
  const tab = engineTabs.get(tabId);
  if (!tab) return;
  const win = tab.win || mainWindow;
  if (win) win.mgActiveTabId = tabId;
  if (win && !win.isFocused() && !win.isDestroyed()) win.focus();
  if (tab.workspace) {
    currentConfig = { ...currentConfig, workspace: tab.workspace, ...(tab.model ? { model: tab.model } : {}) };
    setLogWorkspace(tab.workspace);
  }
  sendToRenderer("tab:focused", { tabId }, win);
}

/** Close a tab: stop its engine, drop it from the pool, and focus another tab IN
 * THE SAME WINDOW (or none). */
function closeTab(tabId) {
  const tab = engineTabs.get(tabId);
  if (!tab) return;
  const win = tab.win || mainWindow;
  stopEngine(tab);
  engineTabs.delete(tabId);
  let nextId = null;
  if (win && win.mgActiveTabId === tabId) {
    for (const t of engineTabs.values()) {
      if ((t.win || mainWindow) === win) { nextId = t.id; break; }
    }
    win.mgActiveTabId = nextId;
  }
  sendToRenderer("tab:closed", { tabId, focus: nextId }, win);
  if (nextId) focusTab(nextId);
}

// ---------------------------------------------------------------------------
// Engine process management
// ---------------------------------------------------------------------------

/**
 * Where the engine process lives. Packaged: the single-file CJS bundle that
 * scripts/bundle-engine.js produced, run through Electron's own Node (no
 * node_modules on disk). Development: the compiled engine host straight out of
 * the workspace, so an engine change only needs `npm run build`.
 */
function engineEntryPoint() {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [path.join(process.resourcesPath, "engine", "engine.cjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return {
    command: "node",
    args: [path.join(__dirname, "..", "engine", "host", "dist", "main.js")],
    env: {},
  };
}

function sendToRenderer(channel, payload, win) {
  const w = win || mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** Send to every open window — for app-global updates (recents, update notices)
 * that are not tied to one window's tab. */
function broadcastToRenderers(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// A tab's `dying` field holds the child from a previous stopEngine that has not
// exited yet. A replacement for the SAME tab must never spawn while it lives —
// two engines on one workspace race over its state.
function stopEngine(tab) {
  if (!tab) return;
  if (tab.child) {
    const child = tab.child;
    logEvent("sys", { ev: "kill", pid: child.pid });
    // Mark this exit as ours (restart, quit, model change) so the exit handler
    // can tell a deliberate stop from a crash — only crashes get a banner.
    child.expectedExit = true;
    try {
      child.stdin.end(); // EOF: the engine interrupts its turn and drains
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Escalate if it ignores SIGTERM (wedged turn, stuck pipe).
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 3000);
    if (killTimer.unref) killTimer.unref();
    tab.dying = child;
    child.once("exit", () => {
      clearTimeout(killTimer);
      if (tab.dying === child) tab.dying = null;
    });
    tab.child = null;
  }
  tab.stdoutBuffer = "";
  tab.stderrBuffer = "";
}

/** Stop every tab's engine — app quit / all windows closed. */
function stopAllEngines() {
  for (const tab of engineTabs.values()) stopEngine(tab);
}

// Frames that represent an explicit user action: dropping one silently reads
// as "the app ignored me". State-sync frames (set_modes,
// set_deletion_guard) are re-sent on session start, so their
// drops stay quiet by design — the renderer fires them before any engine runs.
const USER_ACTION_FRAMES = new Set([
  "user_message",
  "slash_command",
  "bang_command",
  "interrupt",
  "permission_response",
  "question_response",
  "steer_message",
  "resume_session",
  "delete_session",
  "list_sessions",
  "stop_background",
  "rename_session",
  "archive_session",
  // Sent only when the child is writable, so a drop here means the engine died
  // in the same tick — and a connection the user just saved silently not
  // applying is exactly the confusion this set exists to prevent.
  "set_connection",
]);

// The generate_skill frame can carry a resolved profile's API key (to author
// with a different provider). It must reach the engine over stdin but must NOT
// land in the log — redact it in the logged copy only.
function redactFrameForLog(frame) {
  if (frame && typeof frame === "object" && frame.connection && typeof frame.connection === "object" && "apiKey" in frame.connection) {
    return { ...frame, connection: { ...frame.connection, apiKey: frame.connection.apiKey ? "<redacted>" : "" } };
  }
  return frame;
}

function writeToEngine(frame, tabId) {
  const tab = tabId ? engineTabs.get(tabId) ?? null : activeTab();
  if (tab && tab.child && tab.child.stdin.writable) {
    tab.child.stdin.write(JSON.stringify(frame) + "\n");
    logEvent("ui", redactFrameForLog(frame));
    return;
  }
  logEvent("sys", { ev: "engine-write-dropped", type: frame && frame.type });
  if (frame && USER_ACTION_FRAMES.has(frame.type)) {
    sendToRenderer("engine:event", {
      type: "error",
      message: "The engine is not running — restart it from the banner, or reopen the workspace.",
      fatal: false,
      ...(tab ? { tabId: tab.id } : {}),
    }, tab && tab.win);
  }
}

/**
 * The API-key lines of a workspace .env, parsed into { VAR: value }. The
 * workspace .env is the source of truth the app itself manages: startEngine
 * overlays these onto the child env so a stale key exported in the user's
 * shell can never shadow the key they just saved (the engine's own .env
 * loader deliberately lets real env vars win).
 */
function readWorkspaceEnvKeys(workspace) {
  const keys = {};
  if (!workspace) return keys;
  try {
    const content = fs.readFileSync(path.join(workspace, ".env"), "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
      if (!/^[A-Z0-9_]*API_KEY$/.test(name)) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) keys[name] = value;
    }
  } catch {
    // missing/unreadable .env — nothing to overlay
  }
  return keys;
}

/**
 * Whether a workspace is configured well enough for the engine to boot, so we
 * know whether to start it or show the setup wizard. Never throws — treats
 * unreadable/missing files as "no".
 *
 * It asks the question the ENGINE will ask, in the same order (see
 * resolveApiKeySource + bootstrapEngine): the key for THIS workspace's provider,
 * then the env, then a local endpoint that needs no key at all. Answering a
 * looser question — "is any *_API_KEY line present" — was worse than useless: a
 * leftover key line for the other provider read as configured, the engine
 * booted, found nothing it could use, and died with "No API key found" instead
 * of the wizard opening.
 */
function hasCredentials(workspace) {
  if (!workspace) return false;

  // The MERGED view: the engine reads the global layer too, so a key configured
  // once in ~/.magentra/settings.json configures every workspace.
  const settings = readEffectiveWorkspaceSettings(workspace);
  const anthropic = settings.provider === "anthropic";
  const keyVar = apiKeyEnvVarFor(anthropic ? "anthropic" : "openai-compat");
  // The names the engine resolves a key from, for THIS provider, in its order.
  const names = anthropic
    ? ["ANTHROPIC_API_KEY"]
    : [keyVar, "OPENAI_API_KEY", ...LEGACY_API_KEY_ENV_VARS];
  if (typeof settings.apiKeyEnv === "string" && settings.apiKeyEnv) names.unshift(settings.apiKeyEnv);

  const envKeys = readWorkspaceEnvKeys(workspace);
  if (names.some((name) => (envKeys[name] || "").trim() !== "")) return true;
  if (names.some((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "")) return true;
  // A key stored in the engine's own settings (a `/settings global apiKey` user).
  if (typeof settings.apiKey === "string" && settings.apiKey.trim() !== "") return true;
  // A local or LAN endpoint (Ollama, LM Studio, a box on the network) is fully
  // configured without a key. Absent `provider` means the default, which is the
  // OpenAI-compatible one — an older or hand-written settings file that only set
  // baseUrl used to fall through here and be sent to the wizard forever.
  if (!anthropic && typeof settings.baseUrl === "string" && isLocalBaseUrl(settings.baseUrl)) return true;

  return false;
}

/**
 * Remove keys from ~/.magentra/settings.json.
 *
 * The engine merges project settings OVER the global file, so clearing a value
 * in the workspace layer alone leaves the global one to win straight back. Any
 * setting the app clears has to be cleared in both places. Best-effort: a
 * missing or unreadable global file simply has nothing to clear.
 */
function clearGlobalSettingsKeys(keys) {
  try {
    const globalSettings = readGlobalSettings();
    let changed = false;
    for (const key of keys) {
      if (key in globalSettings) {
        delete globalSettings[key];
        changed = true;
      }
    }
    // 0600: this file can hold a stored apiKey.
    if (changed) writeJsonAtomic(globalSettingsPath(), globalSettings, 0o600);
  } catch {
    // no global settings file — nothing to clear
  }
}

/**
 * Turn a raw engine stderr line into a user-facing notice, or null to hide it.
 *
 * The engine's stderr carries three kinds of text, and only one belongs in the
 * chat as a friendly heads-up:
 *   1. Node's own runtime warnings — the NODE_TLS_REJECT_UNAUTHORIZED security
 *      notice (fired because a user opted into allowInsecureTls) and its
 *      "--trace-warnings" footer, deprecation/experimental warnings. These are
 *      never actionable by an end user; drop them (still logged to file).
 *   2. Backups of a fatal error that ALSO arrived as a structured `error` frame
 *      on stdout ("Error: ..." / "fatal: ..."). The frame already drives the
 *      banner, so the stderr copy would just be a duplicate red line — drop it.
 *   3. Genuine engine warnings ("warning [source] message"), e.g. the
 *      allowInsecureTls heads-up. Keep exactly one, softened and de-tagged.
 */
function classifyEngineStderr(line) {
  const trimmed = line.trim();
  // 1. Node runtime noise.
  if (
    /NODE_TLS_REJECT_UNAUTHORIZED/.test(trimmed) ||
    /--trace-warnings/.test(trimmed) ||
    /\bExperimentalWarning\b/.test(trimmed) ||
    /\bDeprecationWarning\b/.test(trimmed) ||
    /^\(node:\d+\)/.test(trimmed)
  ) {
    return null;
  }
  // 2. Duplicate of a structured `error` frame already shown as the banner.
  if (/^(Error|fatal):\s/i.test(trimmed)) return null;
  // 3. A real warning — strip the "warning" keyword and the "[source]" tag so
  //    the user reads a plain sentence, not engine-internal formatting.
  const text = trimmed
    .replace(/^warning\s+/i, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
  if (!text) return null;
  return { text, level: "warning" };
}

function startEngine(workspace, model, tabId) {
  // Resolve the tab: an explicit tabId wins; otherwise the tab already showing
  // this workspace (so a setup-wizard connect / web-search restart lands on the
  // right tab in whichever window owns it); otherwise the main window's active
  // tab (the very first open). Every event this engine emits is stamped with
  // `tab.id` and routed to `tab.win`, so the right window's console gets it.
  const tab =
    (tabId && engineTabs.has(tabId) && engineTabs.get(tabId)) ||
    (workspace && tabForWorkspace(workspace)) ||
    ensureActiveTab();
  const isRestart = !!tab.child;
  stopEngine(tab);

  if (!workspace) return;

  // Never spawn a replacement for THIS tab while its old child lives: wait for
  // its exit (stopEngine escalates to SIGKILL after 3s, so this always resolves).
  if (tab.dying) {
    tab.dying.once("exit", () => startEngine(workspace, model, tab.id));
    return;
  }

  tab.workspace = workspace;
  tab.model = model || DEFAULT_MODEL;

  const entry = engineEntryPoint();
  const args = [...entry.args, "--serve", "--cwd", workspace];

  const env = {
    ...process.env,
    // Workspace .env keys beat anything inherited from the shell — see
    // readWorkspaceEnvKeys for why.
    ...readWorkspaceEnvKeys(workspace),
    ...entry.env,
    MAGENTRA_MODEL: model || DEFAULT_MODEL,
  };

  let child;
  try {
    child = spawn(entry.command, args, {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    sendToRenderer("engine:event", {
      type: "error",
      message: `Failed to start engine: ${err && err.message ? err.message : String(err)}`,
      fatal: true,
      tabId: tab.id,
    }, tab.win);
    return;
  }

  tab.child = child;
  logEvent("sys", {
    ev: isRestart ? "restart" : "spawn",
    pid: child.pid,
    command: entry.command,
    args,
    cwd: workspace,
    model: model || DEFAULT_MODEL,
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    tab.stdoutBuffer += chunk;
    let idx;
    while ((idx = tab.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = tab.stdoutBuffer.slice(0, idx).replace(/\r$/, "");
      tab.stdoutBuffer = tab.stdoutBuffer.slice(idx + 1);
      if (line.trim() === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A corrupt frame means protocol trouble — invisible unless logged.
        logEvent("sys", { ev: "engine-stdout-unparseable", line: line.slice(0, 400) });
        continue;
      }
      logEvent("engine", event);
      sendToRenderer("engine:event", { ...event, tabId: tab.id }, tab.win);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    tab.stderrBuffer += chunk;
    let idx;
    while ((idx = tab.stderrBuffer.indexOf("\n")) !== -1) {
      const line = tab.stderrBuffer.slice(0, idx).replace(/\r$/, "");
      tab.stderrBuffer = tab.stderrBuffer.slice(idx + 1);
      if (line.trim() === "") continue;
      // Everything hits the log file for debugging; the UI gets only what a
      // user can act on — see classifyEngineStderr.
      logEvent("stderr", line);
      const notice = classifyEngineStderr(line);
      if (notice) sendToRenderer("engine:event", { type: "engine_notice", text: notice.text, level: notice.level, tabId: tab.id }, tab.win);
    }
  });

  child.on("exit", (code, signal) => {
    const expected = !!child.expectedExit;
    logEvent("sys", { ev: "exit", pid: child.pid, code, signal, expected });
    flushLog();
    // Signal deaths (SIGSEGV, OOM-kill) have code === null — the renderer must
    // treat any unexpected exit as fatal, whatever the exit code says.
    sendToRenderer("engine:event", { type: "engine_exit", code, signal, expected, tabId: tab.id }, tab.win);
    if (tab.child === child) tab.child = null;
  });

  child.on("error", (err) => {
    sendToRenderer("engine:event", {
      type: "error",
      message: `Engine process error: ${err && err.message ? err.message : String(err)}`,
      fatal: true,
      tabId: tab.id,
    }, tab.win);
  });
  // No app-side credential check here: the engine is the authority. If a key is
  // genuinely missing (and the endpoint is not a keyless local one), the engine
  // emits a single fatal credential `error` frame, which the renderer turns into
  // the friendly "pick a profile / set up a connection" flow. A second heuristic
  // check here only produced a duplicate — and could contradict the engine.
}

// ---------------------------------------------------------------------------
// Attach-context file reading (composer "+" button)
//
// Files the user attaches are read here in the main process; the renderer folds
// their text into the next message. Binary documents (PDF, DOCX, …) are
// text-extracted with the engine's OWN extractor — reused, never reimplemented.
// A hard 2 MB ceiling per file guards against loading a huge blob into memory
// or the model's context window.
// ---------------------------------------------------------------------------
// Caps apply to the WHOLE pending set (attachments accumulate across repeated
// "+" clicks), not one dialog batch — the renderer passes its current pending
// count/bytes and the reader enforces the remaining budget as it goes, so it
// never reads a file it would only reject.
const MAX_ATTACH_FILES = 15;
const MAX_ATTACH_TOTAL_BYTES = 2 * 1024 * 1024;
const DOC_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".rtf", ".odt", ".epub"]);
// Text/code extensions the picker offers (no leading dot — dialog filter form).
const TEXT_EXTS = [
  "txt", "md", "markdown", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "swift", "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml",
  "html", "htm", "css", "scss", "sql", "csv", "tsv", "log", "env", "gradle",
];
// Document extensions in dialog-filter form, derived from DOC_EXTS (single source).
const DOC_EXTS_LIST = [...DOC_EXTS].map((e) => e.slice(1));

// The engine's document extractor, loaded lazily and cached (undefined = tried
// and unavailable). Packaged: the standalone doc-extract.mjs bundled next to
// engine.cjs. Development: engine/core's compiled ESM from the workspace (needs
// `npm run build`, which dev already requires).
let docExtractor;
let docExtractorTried = false;
async function loadDocExtractor() {
  if (docExtractorTried) return docExtractor;
  docExtractorTried = true;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "engine", "doc-extract.mjs")
    : path.join(__dirname, "..", "engine", "core", "dist", "knowledge", "docs.js");
  try {
    if (fs.existsSync(candidate)) {
      docExtractor = await import(pathToFileURL(candidate).href);
    }
  } catch (err) {
    logEvent("sys", { ev: "doc-extractor-load-failed", error: err && err.message ? err.message : String(err) });
    docExtractor = undefined;
  }
  return docExtractor;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read one attachment for the composer. `remainingBudget` is how many bytes are
 *  still free in the total 2 MB allowance; a file bigger than that is rejected
 *  before it is read (memory-safe). Returns a plain record and never throws, so
 *  one unreadable pick doesn't sink the whole selection. */
async function readAttachment(filePath, remainingBudget) {
  const name = path.basename(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { name, ok: false, error: "could not read file" };
  }
  if (!stat.isFile()) return { name, ok: false, error: "not a file" };
  if (stat.size > remainingBudget) {
    const error =
      stat.size > MAX_ATTACH_TOTAL_BYTES
        ? `too large (${formatBytes(stat.size)} > ${formatBytes(MAX_ATTACH_TOTAL_BYTES)} total limit)`
        : `would exceed the ${formatBytes(MAX_ATTACH_TOTAL_BYTES)} total (only ${formatBytes(Math.max(0, remainingBudget))} left)`;
    return { name, ok: false, error };
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { name, ok: false, error: "could not read file" };
  }
  const ext = path.extname(filePath).toLowerCase();

  if (DOC_EXTS.has(ext)) {
    const extractor = await loadDocExtractor();
    if (!extractor || typeof extractor.extractDocumentText !== "function") {
      return { name, ok: false, error: "document text extraction is unavailable in this build" };
    }
    try {
      const res = extractor.extractDocumentText(filePath, buf);
      if (!res || !res.text || !res.text.trim()) {
        return { name, ok: false, error: "no extractable text (scanned or encrypted?)" };
      }
      return { name, ok: true, bytes: stat.size, kind: res.kind, text: res.text };
    } catch (err) {
      return { name, ok: false, error: `extraction failed: ${err && err.message ? err.message : String(err)}` };
    }
  }

  // Everything else is treated as UTF-8 text. A NUL byte is the cheap, reliable
  // tell for "this is binary" — reject rather than paste mojibake into a prompt.
  if (buf.includes(0)) {
    return { name, ok: false, error: "looks like a binary file — not text-readable" };
  }
  return { name, ok: true, bytes: stat.size, kind: "text", text: buf.toString("utf8") };
}

ipcMain.handle("context:pickFiles", async (_evt, opts = {}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Attach context",
      properties: ["openFile", "multiSelections"],
      // The FIRST filter is active when the dialog opens, so it lists every
      // attachable type — otherwise PDFs/docs are hidden until the user manually
      // switches the filter dropdown. The narrower filters and "All Files"
      // follow for when someone wants to restrict the view.
      filters: [
        { name: "Attachable files", extensions: [...TEXT_EXTS, ...DOC_EXTS_LIST] },
        { name: "Documents", extensions: DOC_EXTS_LIST },
        { name: "Text & code", extensions: TEXT_EXTS },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };

    // Start from what the composer already holds, so the 15-file / 2 MB caps
    // cover the whole pending set rather than resetting each pick.
    let count = Number.isFinite(opts.pendingCount) ? Math.max(0, opts.pendingCount) : 0;
    let bytes = Number.isFinite(opts.pendingBytes) ? Math.max(0, opts.pendingBytes) : 0;
    const files = [];
    for (const fp of result.filePaths) {
      if (count >= MAX_ATTACH_FILES) {
        files.push({ name: path.basename(fp), ok: false, error: `attachment limit reached (max ${MAX_ATTACH_FILES} files)` });
        continue;
      }
      const rec = await readAttachment(fp, MAX_ATTACH_TOTAL_BYTES - bytes);
      if (rec.ok) {
        count += 1;
        bytes += rec.bytes;
      }
      files.push(rec);
    }
    return { ok: true, files };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "context-pick-failed", error: message });
    return { ok: false, error: message };
  }
});

// Mission builder "Browse…": pick where a mission's report is written. A mission
// writes its deliverable with the engine's Write tool, which is workspace-scoped,
// so the path MUST resolve inside the workspace — a pick outside it is rejected.
// Returns the chosen path workspace-relative (forward slashes), ready for the
// mission file's `deliverable:` key.
ipcMain.handle("mission:pickDeliverable", async (_evt, defaultRel) => {
  try {
    const workspace = currentConfig.workspace;
    if (!workspace) return { ok: false, error: "no workspace open" };
    const rel = typeof defaultRel === "string" && defaultRel.trim() ? defaultRel.trim() : "report.md";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Where to save the mission report",
      defaultPath: path.join(workspace, rel),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const relPath = path.relative(workspace, result.filePath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return { ok: false, error: "pick a location inside the workspace folder" };
    }
    return { ok: true, path: relPath.split(path.sep).join("/") };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** Saved bounds, clamped to a live display so a detached monitor can't strand the window. */
function savedWindowBounds() {
  const saved = currentConfig.window;
  if (!saved) return {};
  const bounds = { width: saved.width, height: saved.height };
  if (saved.x !== undefined && saved.y !== undefined) {
    const { screen } = require("electron");
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        saved.x + saved.width > a.x + 40 &&
        saved.x < a.x + a.width - 40 &&
        saved.y >= a.y - 20 &&
        saved.y < a.y + a.height - 40
      );
    });
    if (visible) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
  }
  return bounds;
}

/** Persist bounds + maximize state (debounced — resize fires continuously). */
// Full screen is not persisted: every launch starts full screen regardless.
let windowStateTimer = null;
function rememberWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    // getBounds() while maximized or full screen reports that covering rect;
    // keep the last restored bounds so leaving either state after a restart
    // looks right.
    const covering = maximized || mainWindow.isFullScreen();
    const bounds = covering ? (currentConfig.window || mainWindow.getNormalBounds()) : mainWindow.getBounds();
    currentConfig = {
      ...currentConfig,
      window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized },
    };
    writeConfig(currentConfig);
  }, 400);
}

// Native window chrome per theme, reasserted by the renderer on every theme
// switch so the controls stay visually integrated. `background` is the window's
// pre-paint fill and must match the theme's --bg; the other two mirror
// THEME_TITLEBAR in renderer/modules/state.js.
const TITLEBAR_HEIGHT = 36;
const THEME_CHROME = {
  light: { color: "#e7ebf0", symbolColor: "#36424f", background: "#eef1f5" },
  workbench: { color: "#0e1114", symbolColor: "#ced6dd", background: "#0b0e11" },
  matrix: { color: "#040a06", symbolColor: "#b9f5cd", background: "#030705" },
};
const themeChrome = (name) => THEME_CHROME[name] || THEME_CHROME[DEFAULT_THEME];

/** Hold the window to its opening posture — filling the screen.
 *
 * The `fullscreen: true` constructor option is the preferred route (no visible
 * windowed-then-resize flash), but it is a REQUEST: several Linux WMs drop a
 * state asked for before the window is mapped, and the window then simply keeps
 * the saved bounds — which is how a launch ended up as a small window in a
 * corner. So re-assert once the window is on screen, and if full screen is still
 * refused a moment later, maximize instead. Filling the work area is the point;
 * full screen is only the preferred way to get there. */
function applyOpeningPosture(win) {
  if (!shouldStartFullScreen()) return;
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (!win.isFullScreen()) win.setFullScreen(true);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      if (!win.isFullScreen() && !win.isMaximized()) win.maximize();
      // Which posture the desktop actually granted — the one fact that separates
      // "the WM refused full screen" from "the app never asked".
      logEvent("sys", { ev: "window-posture", fullScreen: win.isFullScreen(), maximized: win.isMaximized() });
    }, 400);
  });
}

/** Full screen hides the native title bar on every platform — and on Windows
 * the controls overlay goes with it, which left a packaged build with no
 * minimize/restore/close button and no menu (Menu.setApplicationMenu(null)) to
 * leave full screen from: the window was stuck. So every window gets two ways
 * out that do not depend on native chrome:
 *  - F11 toggles full screen, handled here rather than through a menu
 *    accelerator (packaged non-mac builds have no menu at all).
 *  - the renderer is told the current posture and draws its own window buttons
 *    in the top strip while the native ones are gone. */
function wireWindowChrome(win) {
  const push = () => sendToRenderer("window:fullscreen", win.isFullScreen(), win);
  win.on("enter-full-screen", push);
  win.on("leave-full-screen", push);
  // The opening posture is applied before the page loads, so the first state
  // the renderer ever hears about has to be sent when it is ready to listen.
  win.webContents.on("did-finish-load", push);
  win.webContents.on("before-input-event", (_evt, input) => {
    if (input.type !== "keyDown" || input.key !== "F11") return;
    if (win.isDestroyed()) return;
    win.setFullScreen(!win.isFullScreen());
  });
}

function createWindow() {
  // Last session's theme, so the very first frame is already the right shade.
  const chrome = themeChrome(currentConfig.theme);
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    ...savedWindowBounds(),
    // Full screen from the first paint. Setting it as a constructor option
    // rather than calling setFullScreen() after creation avoids the visible
    // windowed-then-resize flash, and avoids WMs that drop a state change
    // sent before the window is mapped.
    ...(shouldStartFullScreen() ? { fullscreen: true } : {}),
    // Title bar per platform:
    //  - macOS: hidden with inset traffic lights (the dock reserves their room).
    //  - Windows: hidden with the native controls overlaid top-right — the
    //    overlay is solid there, so the app's own top strip stays the drag region.
    //  - Linux: a NORMAL native frame. A frameless window here extends under the
    //    desktop's top panel (the clock/status bar) on many WMs, clipping the
    //    app's own top-row icons left and right, and the controls overlay is
    //    flaky on GTK. A real frame lets the WM place the window below the panel
    //    with working controls — the top row is fully visible. (macOS/Windows
    //    are unchanged.)
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: chrome.color,
              symbolColor: chrome.symbolColor,
              height: TITLEBAR_HEIGHT,
            },
          }
        : { frame: true }),
    // The responsive floor the stylesheet is built for — below this, panels
    // would clip horizontally rather than wrap.
    minWidth: 700,
    minHeight: 480,
    backgroundColor: chrome.background,
    title: "MAGENTRA",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The Chromium sandbox cannot initialize from the portable stub's temp
      // extraction dir (renderer dies at boot). Portable runs fall back to
      // contextIsolation + no-node + CSP; every other build keeps the sandbox.
      sandbox: !process.env.PORTABLE_EXECUTABLE_FILE,
      devTools: !app.isPackaged,
    },
  });

  // Every launch opens like a professional IDE: full screen. Leaving full
  // screen mid-session restores the saved bounds; the next launch starts full
  // screen again.
  applyOpeningPosture(mainWindow);
  wireWindowChrome(mainWindow);
  mainWindow.on("resize", rememberWindowState);
  mainWindow.on("move", rememberWindowState);
  mainWindow.on("maximize", rememberWindowState);
  mainWindow.on("unmaximize", rememberWindowState);
  mainWindow.on("enter-full-screen", rememberWindowState);
  mainWindow.on("leave-full-screen", rememberWindowState);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // will-navigate is governed centrally by the app-level "web-contents-created"
  // handler below — it fires for this window too. Keeping the navigation policy
  // in one place is deliberate: a second per-window listener here would ALSO
  // have to allow the "Welcome page" reload, and a stray preventDefault() in
  // either listener cancels the navigation for both (which is exactly the bug
  // that made the home button do nothing).

  let rendererCrashed = false;
  mainWindow.webContents.once("did-finish-load", () => {
    if (SMOKE) {
      setTimeout(() => {
        app.exit(rendererCrashed ? 1 : 0);
      }, 5000);
    }
    // Frames sent before the page has loaded are silently dropped, so this
    // waits for the renderer. Always land on the start page (logo + recent
    // folders) rather than auto-opening the last workspace.
    sendToRenderer("workspace:recent", currentConfig.recentWorkspaces || []);
    logEvent("sys", { ev: "landing-shown", count: (currentConfig.recentWorkspaces || []).length });
  });
  mainWindow.webContents.on("render-process-gone", (_evt, details) => {
    rendererCrashed = true;
    logEvent("renderer", { ev: "render-process-gone", reason: details && details.reason });
    if (SMOKE) app.exit(1);
  });
  mainWindow.webContents.on("unresponsive", () => {
    logEvent("renderer", { ev: "unresponsive" });
  });
  mainWindow.webContents.on("console-message", (_evt, level, message, line, sourceId) => {
    const isWarningOrAbove =
      typeof level === "number" ? level >= 2 : /warn|error/i.test(String(level));
    if (!isWarningOrAbove) return;
    logEvent("renderer", { ev: "console-message", level, message, line, sourceId });
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

/** The per-platform title-bar options — mirrors createWindow (macOS inset,
 * Windows controls overlay, Linux native frame). */
function platformTitleBarOptions() {
  const chrome = themeChrome(currentConfig.theme);
  if (process.platform === "darwin") return { titleBarStyle: "hiddenInset" };
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbolColor, height: TITLEBAR_HEIGHT },
    };
  }
  return { frame: true };
}

/** Close every tab whose engine belongs to a window that just closed. */
function closeTabsForWindow(win) {
  for (const tab of [...engineTabs.values()]) {
    if ((tab.win || mainWindow) === win) {
      stopEngine(tab);
      engineTabs.delete(tab.id);
    }
  }
}

/** A SECONDARY window (the "open in new window" path) — the full renderer, its
 * own independent set of tabs. Not the primary window, so no smoke/bounds/quit
 * bookkeeping; the app-level web-contents-created handler still governs its
 * navigation/window-open policy. */
function createExtraWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 480,
    backgroundColor: themeChrome(currentConfig.theme).background,
    title: "MAGENTRA",
    autoHideMenuBar: true,
    ...platformTitleBarOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !process.env.PORTABLE_EXECUTABLE_FILE,
      devTools: !app.isPackaged,
    },
  });
  wireWindowChrome(win);
  win.on("closed", () => closeTabsForWindow(win));
  win.webContents.once("did-finish-load", () => {
    sendToRenderer("workspace:recent", currentConfig.recentWorkspaces || [], win);
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

// ---------------------------------------------------------------------------
// First-run setup wizard (credential entry)
// ---------------------------------------------------------------------------

ipcMain.handle("setup:writeEnv", async (_evt, payload) => {
  // SAVE with an empty key field keeps the already-saved key: the user is
  // updating model/URL/context, not the credential. "The saved key" means the one
  // for the provider being saved — see savedWorkspaceKey.
  if (payload && typeof payload === "object" && payload.useSavedKey) {
    payload = { ...payload, apiKey: savedWorkspaceKey(currentConfig.workspace, payload.provider) };
  }
  const validated = validateCredentialPayload(payload);
  if (!validated.ok) return validated;

  const workspace = currentConfig.workspace;
  if (!workspace) return { ok: false, error: "no workspace" };
  return applyValidatedConnection(workspace, validated);
});

/**
 * Commit a validated connection to a workspace: the API key to its .env, the rest
 * to its .magentra/settings.json, then put it to work. Shared by the setup
 * wizard's writeEnv and by applying a saved global profile, so both paths land
 * credentials identically.
 *
 * A workspace with a LIVE engine is re-pointed in place (the set_connection
 * frame) instead of being respawned. Switching endpoint used to mean killing the
 * process, which took the conversation with it — so trying a different provider
 * mid-task cost the whole session. The persisted files are written either way;
 * they are what a later restart boots from.
 *
 * Returns `{ ok: true, live }` — `live` true when the running session was
 * re-pointed, false when an engine was started.
 */
function applyValidatedConnection(workspace, validated) {
  const { apiKey, model, provider, baseUrl, contextWindow, insecureTls } = validated;

  const envVarName = apiKeyEnvVarFor(provider);

  // Keyless local endpoints (Ollama, LM Studio) get no .env key line — the
  // config lives entirely in settings.json below.
  if (apiKey.length > 0) {
    try {
      const envPath = path.join(workspace, ".env");
      let existingLines = [];
      try {
        existingLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
      } catch {
        existingLines = [];
      }
      // Drop the line we are about to rewrite, plus any legacy-named key line
      // an older build left behind — two keys for one endpoint would leave the
      // engine resolving whichever name it checks first, not the one saved here.
      const replacedNames = provider === "anthropic" ? [envVarName] : [envVarName, ...LEGACY_API_KEY_ENV_VARS];
      const keyLineRe = new RegExp(`^\\s*(?:export\\s+)?(?:${replacedNames.join("|")})\\s*=`);
      const keptLines = existingLines.filter((line) => !keyLineRe.test(line));
      while (keptLines.length > 0 && keptLines[keptLines.length - 1] === "") {
        keptLines.pop();
      }
      keptLines.push(`${envVarName}=${apiKey}`);
      // Holds the API key: owner-only. mode applies only on create, so chmod
      // fixes up a pre-existing world-readable file too (no-op on Windows).
      fs.writeFileSync(envPath, keptLines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      try {
        fs.chmodSync(envPath, 0o600);
      } catch {
        // best-effort — never fail the write over permissions polish
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return { ok: false, error: `failed to write .env: ${message}` };
    }
  }

  // The endpoint as it will be STORED: the default hosted URL is left out, so the
  // engine falls back to it by itself. Computed once and used for both the file
  // and the live frame, so a re-pointed session and a restarted one see the
  // identical connection.
  const storedBaseUrl = provider === "openai-compat" && baseUrl && baseUrl !== DEFAULT_BASE_URL ? baseUrl : "";
  // Keys to clear in the GLOBAL layer, collected during the mutation and written
  // after it: the engine merges project settings OVER global, so a value left up
  // there wins straight back.
  const staleGlobalKeys = ["apiKeyEnv"];

  const settingsError = updateWorkspaceSettings(workspace, (settings) => {
    // The engine's settings schema names the provider "openai-compatible".
    settings.provider = provider === "anthropic" ? "anthropic" : "openai-compatible";
    if (storedBaseUrl) settings.baseUrl = storedBaseUrl;
    else delete settings.baseUrl;
    settings.model = model;
    // Self-signed TLS opt-in (the `verify=False` equivalent). Stored only
    // while true so a later un-check fully clears it.
    if (insecureTls && provider !== "anthropic") settings.allowInsecureTls = true;
    else delete settings.allowInsecureTls;
    // Context size: engine compaction window + `num_ctx` for local servers.
    // An EMPTY field must clear a previous override — a stale tiny window
    // shadowing the model's real one causes constant compaction.
    if (contextWindow !== undefined) {
      settings.contextWindow = contextWindow;
    } else {
      delete settings.contextWindow;
      staleGlobalKeys.push("contextWindow");
    }

    // The key this wizard just saved goes to the workspace .env as
    // MAGENTRA_API_KEY, which makes any `apiKeyEnv` pin left behind by a
    // PREVIOUS provider actively harmful: it names a variable that is not set,
    // and resolution then reaches for whatever stored key is lying around —
    // one provider's key sent to another's URL, reported as a rejected key.
    // Saving a connection is the moment that pin stops being true.
    delete settings.apiKeyEnv;
  });
  if (settingsError) return { ok: false, error: `failed to write settings: ${settingsError}` };
  clearGlobalSettingsKeys(staleGlobalKeys);

  currentConfig = { ...currentConfig, model };
  writeConfig(currentConfig);
  logEvent("sys", { ev: "env-written", provider });

  // A live engine is re-pointed, not respawned: same session, same conversation,
  // new endpoint from the next request on. The frame carries the key because the
  // engine read .env once, at boot — and it travels as `connection` so the
  // stdin log redacts it (see redactFrameForLog).
  const tab = tabForWorkspace(workspace);
  if (tab && tab.child && tab.child.stdin.writable) {
    tab.model = model;
    writeToEngine(
      {
        type: "set_connection",
        connection: {
          provider,
          ...(storedBaseUrl ? { baseUrl: storedBaseUrl } : {}),
          apiKey,
          model,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(insecureTls ? { insecureTls: true } : {}),
        },
      },
      tab.id,
    );
    logEvent("sys", { ev: "connection-swapped", provider, live: true });
    return { ok: true, live: true, model };
  }
  startEngine(workspace, model);
  return { ok: true, live: false, model };
}

// ---------------------------------------------------------------------------
// Global connection profiles: the reusable layer above per-workspace creds.
// Build/save profiles once (even before any workspace is open); apply one to
// the active workspace to connect it. The raw key never crosses back to the
// renderer — list/save return sanitized records, and apply reads the stored
// key here in main.
// ---------------------------------------------------------------------------

/** True if an executable named `bin` sits on PATH — how "is Ollama installed"
 * is answered without spawning anything. Windows also tries PATHEXT suffixes. */
function commandOnPath(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, bin + ext);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
      } catch {
        // unreadable PATH entry — skip
      }
    }
  }
  return false;
}

/** Short probe of a local server's HTTP port — any answer at all (even a 404)
 * means something is listening. Covers a server that is running but whose CLI
 * is not on PATH (a portable install, a container). */
async function probeLocal(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Which local model servers are present on this machine — installed (on PATH)
 * or already running. Drives the grayed-out OLLAMA / LM STUDIO presets. */
async function detectLocalServers() {
  const ollamaInstalled = commandOnPath("ollama");
  const lmsInstalled = commandOnPath("lms") || commandOnPath("lm-studio");
  const [ollamaUp, lmsUp] = await Promise.all([
    ollamaInstalled ? Promise.resolve(true) : probeLocal("http://127.0.0.1:11434/api/version"),
    lmsInstalled ? Promise.resolve(true) : probeLocal("http://127.0.0.1:1234/v1/models"),
  ]);
  return {
    ollama: ollamaUp ? { available: true } : { available: false, reason: "Ollama wasn't found on this PC" },
    lmstudio: lmsUp ? { available: true } : { available: false, reason: "LM Studio wasn't found on this PC" },
  };
}

ipcMain.handle("connections:detectLocal", () => detectLocalServers());

// Skill generation, routed through main so it can resolve a chosen connection
// profile into a full connection (the renderer never holds a profile's key).
// Without a profileId it is a plain passthrough to the engine's generate_skill.
ipcMain.handle("skills:generate", (evt, payload) => {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid payload" };
  const genTab = activeTab(winOf(evt));
  if (!genTab || !genTab.child) return { ok: false, error: "Open a workspace and connect an engine first." };
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  if (!description) return { ok: false, error: "Describe the skill first." };
  const frame = { type: "generate_skill", description, kind: payload.kind === "action" ? "action" : "discipline" };
  if (typeof payload.context === "string" && payload.context.trim()) frame.context = payload.context.trim();
  if (typeof payload.profileId === "string" && payload.profileId) {
    const profile = findProfile(payload.profileId);
    if (!profile) return { ok: false, error: "profile not found" };
    frame.connection = {
      provider: profile.provider === "anthropic" ? "anthropic" : "openai-compat",
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
      model: profile.model || "",
    };
  } else if (typeof payload.model === "string" && payload.model) {
    frame.model = payload.model;
  }
  writeToEngine(frame, genTab.id);
  return { ok: true };
});

// Save a skill's .md (text supplied by the engine's skill_export) to a chosen
// location. The engine sources the text — including built-ins — so every skill
// exports, not only on-disk ones.
ipcMain.handle("skills:saveExport", async (_evt, payload) => {
  const filename = payload && typeof payload.filename === "string" ? payload.filename : "";
  const text = payload && typeof payload.text === "string" ? payload.text : "";
  if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(filename) || text.length === 0) {
    return { ok: false, error: "nothing to export" };
  }
  if (!mainWindow) return { ok: false, error: "no window" };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export skill",
    defaultPath: filename,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, text.endsWith("\n") ? text : text + "\n", "utf8");
  } catch (err) {
    return { ok: false, error: `failed to write: ${err && err.message ? err.message : String(err)}` };
  }
  logEvent("sys", { ev: "skill-exported" });
  return { ok: true, path: result.filePath };
});

ipcMain.handle("profiles:list", () => readProfiles().map(sanitizeProfile));

ipcMain.handle("profiles:save", (_evt, payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid payload" };
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) return { ok: false, error: "profile name required" };

  // Editing a profile without re-typing its key keeps the stored one — mirrors
  // the workspace card's "empty field means keep the saved key". Forking a
  // profile ("save as new") names the source via copyKeyFrom so the new profile
  // inherits that key the same way, since the renderer never holds it.
  let connection = payload;
  const keySourceId = typeof payload.id === "string" && payload.id
    ? payload.id
    : (typeof payload.copyKeyFrom === "string" ? payload.copyKeyFrom : "");
  if (keySourceId && (!payload.apiKey || !String(payload.apiKey).trim())) {
    const existing = findProfile(keySourceId);
    if (existing && typeof existing.apiKey === "string") connection = { ...payload, apiKey: existing.apiKey };
  }
  const validated = validateCredentialPayload(connection);
  if (!validated.ok) return validated;

  const { list, id } = upsertProfile({
    id: typeof payload.id === "string" ? payload.id : undefined,
    name,
    baseUrl: validated.baseUrl,
    apiKey: validated.apiKey,
    model: validated.model,
    provider: validated.provider,
    ...(validated.contextWindow !== undefined ? { contextWindow: validated.contextWindow } : {}),
    ...(validated.insecureTls ? { insecureTls: true } : {}),
  });
  logEvent("sys", { ev: "profile-saved" });
  return { ok: true, id, profiles: list.map(sanitizeProfile) };
});

ipcMain.handle("profiles:delete", (_evt, id) => {
  if (typeof id !== "string" || !id) return { ok: false, error: "invalid id" };
  const list = deleteProfile(id);
  logEvent("sys", { ev: "profile-deleted" });
  return { ok: true, profiles: list.map(sanitizeProfile) };
});

ipcMain.handle("profiles:apply", (_evt, payload) => {
  const id = payload && typeof payload === "object" ? payload.id : payload;
  if (typeof id !== "string" || !id) return { ok: false, error: "invalid id" };
  const workspace = currentConfig.workspace;
  if (!workspace) return { ok: false, error: "no workspace open" };
  const profile = findProfile(id);
  if (!profile) return { ok: false, error: "profile not found" };
  const validated = validateCredentialPayload({
    baseUrl: profile.baseUrl,
    apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
    model: profile.model,
    provider: profile.provider,
    contextWindow: profile.contextWindow,
    insecureTls: profile.insecureTls === true,
  });
  if (!validated.ok) return validated;
  const result = applyValidatedConnection(workspace, validated);
  if (result.ok) logEvent("sys", { ev: "profile-applied" });
  return result;
});

/**
 * The saved key for a workspace, for the provider it is actually configured with.
 *
 * Provider-aware on purpose. Switching a workspace between an OpenAI-compatible
 * endpoint and Anthropic leaves BOTH key lines in its .env (each save rewrites
 * only its own name, and deleting the other would throw away a key the user may
 * switch back to). Taking "the first *_API_KEY line" then handed the reveal
 * button, "keep the saved key" and TEST whichever key happened to sit higher in
 * the file — one provider's key sent to the other's URL, reported as a bad key.
 *
 * `provider` overrides the saved one, for a card that is testing a provider the
 * workspace has not been switched to yet.
 */
function savedWorkspaceKey(workspace = currentConfig.workspace, provider) {
  const keys = readWorkspaceEnvKeys(workspace);
  const settings = readEffectiveWorkspaceSettings(workspace);
  const kind = provider ?? (settings.provider === "anthropic" ? "anthropic" : "openai-compat");
  const names = [apiKeyEnvVarFor(kind)];
  if (kind !== "anthropic") names.push("OPENAI_API_KEY", ...LEGACY_API_KEY_ENV_VARS);
  // An explicit apiKeyEnv pin is what the engine tries first; match it.
  if (typeof settings.apiKeyEnv === "string" && settings.apiKeyEnv) names.unshift(settings.apiKeyEnv);
  for (const name of names) {
    if ((keys[name] || "").trim() !== "") return keys[name];
  }
  return "";
}

/** The model a workspace has saved in its own .magentra/settings.json, or "" if
 * none. Each tab is a distinct workspace/connection, so opening one must honour
 * ITS model — not whatever the currently-focused tab happens to be running. */
function savedWorkspaceModel(workspace) {
  const settings = readWorkspaceSettings(workspace);
  return typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : "";
}

/** Persist a workspace's chosen model into its .magentra/settings.json so the
 * choice survives closing and reopening the tab. The app-global currentConfig
 * .model stays only as the fallback for a workspace that never picked one.
 * Best-effort — a failed write must never break the model switch itself. */
function persistWorkspaceModel(workspace, model) {
  if (!workspace || typeof model !== "string" || !model.trim()) return;
  // Best-effort: updateWorkspaceSettings returns the error instead of throwing,
  // and a failed write must never break the model switch itself.
  updateWorkspaceSettings(workspace, (settings) => {
    settings.model = model.trim();
  });
}

// What the Settings → Connection card shows on open: the saved endpoint and
// whether a key exists (never the key itself — that goes through revealKey).
ipcMain.handle("connection:info", () => {
  const workspace = currentConfig.workspace;
  const info = { baseUrl: "", model: currentConfig.model || "", provider: "openai-compat", contextWindow: "", hasKey: false, allowInsecureTls: false };
  if (!workspace) return info;
  const settings = readWorkspaceSettings(workspace);
  if (typeof settings.baseUrl === "string") info.baseUrl = settings.baseUrl;
  if (typeof settings.model === "string") info.model = settings.model;
  if (settings.provider === "anthropic") info.provider = "anthropic";
  if (Number.isFinite(settings.contextWindow)) info.contextWindow = String(settings.contextWindow);
  info.allowInsecureTls = settings.allowInsecureTls === true;
  // Asked for THIS workspace's provider, so a leftover key line for the other
  // one cannot make the card claim a key it would never send.
  info.hasKey = savedWorkspaceKey(workspace, info.provider) !== "";
  return info;
});

// The actual saved key, on explicit request (the reveal button). It is the
// user's own workspace .env on their own machine — "reveal" must mean reveal.
ipcMain.handle("connection:revealKey", () => ({ key: savedWorkspaceKey() }));

ipcMain.handle("setup:testConnection", async (_evt, payload) => {
  // An empty key field with a saved key means "test the saved connection" — the
  // key for the provider being tested, which may not be the one saved (the card
  // infers the provider from the URL being typed).
  if (payload && typeof payload === "object" && payload.useSavedKey) {
    payload = { ...payload, apiKey: savedWorkspaceKey(currentConfig.workspace, payload.provider) };
  }
  // Testing a saved profile with a blank key field: resolve the key from the
  // profile store (the renderer never holds it). Without this, TEST sends no
  // key and a hosted endpoint rejects it 401 though the profile is valid.
  if (payload && typeof payload === "object" && payload.profileId && !String(payload.apiKey || "").trim()) {
    const profile = findProfile(payload.profileId);
    if (profile && typeof profile.apiKey === "string") payload = { ...payload, apiKey: profile.apiKey };
  }
  const validated = validateCredentialPayload(payload);
  if (!validated.ok) return validated;
  // testEndpoint tries the URL as given, retries `localhost` as 127.0.0.1
  // (Windows resolves localhost IPv6-first and stalls on IPv4-only servers),
  // gives local endpoints a longer budget, and treats a local server without
  // a /models catalog as reachable-with-a-note rather than a failure.
  const result = await testEndpoint(validated, DEFAULT_BASE_URL);
  logEvent("sys", {
    ev: "connection-test",
    ok: result.ok,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  return result;
});

// Packaged builds carry the real 4-part version as `magentraVersion`
// (electron-builder itself only accepts semver — see scripts/dist.js);
// development reads the 4-part straight from package.json via getVersion().
ipcMain.handle("app:info", () => ({
  version: require("./package.json").magentraVersion || app.getVersion(),
}));

// Theme switches re-tint the window-controls overlay so the min/max/close
// strip never clashes with the app theme. Colors are validated as hex —
// nothing else from the renderer reaches a native API.
ipcMain.on("app:titleBarTheme", (_evt, theme) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Remember the choice for the next launch's pre-paint chrome. This runs even
  // where the overlay is unsupported (macOS), since backgroundColor still is.
  const name = theme && theme.name;
  if (THEMES.includes(name) && name !== currentConfig.theme) {
    currentConfig = { ...currentConfig, theme: name };
    writeConfig(currentConfig);
  }
  // Only Windows uses the controls overlay now (macOS lacks it; Linux is framed).
  if (process.platform !== "win32" || typeof mainWindow.setTitleBarOverlay !== "function") return;
  const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
  const color = hex(theme && theme.color);
  const symbolColor = hex(theme && theme.symbolColor);
  if (!color || !symbolColor) return;
  try {
    mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
  } catch {
    // overlay unsupported on this platform/session — the default stands
  }
});

// Diagnostics must be reachable from the UI: reveal the live log folder
// (workspace logs when one is open, else the pre-workspace userData mirror).
ipcMain.handle("app:openLogs", () => {
  const dir = activeLogsDir();
  if (!dir) return { ok: false };
  flushLog();
  shell.openPath(dir);
  return { ok: true };
});

// Open only a validated file inside the active workspace; symlinks are
// resolved by resolveWorkspaceFile before the native shell sees the path.
ipcMain.handle("workspace:openFile", async (_evt, relPath) => {
  const target = resolveWorkspaceFile(currentConfig.workspace, relPath, true);
  if (!target) return { ok: false, error: "invalid workspace file" };
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
});

// Reveal a workspace ROOT in the desktop's file manager — Explorer on Windows,
// Finder on macOS, whatever xdg-open resolves to on Linux; shell.openPath is the
// one call that covers all three. Deliberately NOT routed through
// workspace:openFile: that helper resolves a path the renderer names and refuses
// the root by design, so relaxing it would widen a security boundary for an
// unrelated case. Here the renderer names only a TAB — main looks the folder up
// itself, so a background pane's button reveals its own workspace and no
// arbitrary path can ever reach the shell.
ipcMain.handle("workspace:reveal", async (evt, tabId) => {
  const tab = (typeof tabId === "string" && engineTabs.get(tabId)) || activeTab(winOf(evt));
  const dir = (tab && tab.workspace) || currentConfig.workspace;
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: "no workspace open" };
  const error = await shell.openPath(dir);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("changes:undo", async (_evt, payload) => {
  const relPath = payload && payload.relPath;
  const diffs = payload && payload.diffs;
  const result = await undoWorkspaceDiffs(currentConfig.workspace, relPath, diffs);
  if (!result.ok) return result;
  logEvent("sys", { ev: "changes-undone", file: relPath, edits: diffs.length });
  return { ok: true };
});

// The renderer may open exactly these pages (the wizard's "get an API key"
// links) in the system browser — an allowlist, never an arbitrary URL, so a
// compromised renderer cannot use the shell as a launcher.
const EXTERNAL_URL_ALLOWLIST = new Set([
  "https://console.anthropic.com/settings/keys",
  "https://github.com/kalai-labs/MAGENTRA",
]);

ipcMain.on("app:openExternal", (_evt, url) => {
  if (typeof url === "string" && EXTERNAL_URL_ALLOWLIST.has(url)) {
    shell.openExternal(url);
  }
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("config:get", () => currentConfig);

ipcMain.handle("config:setModel", (evt, model) => {
  if (typeof model !== "string") return currentConfig;
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return currentConfig;

  // The model change targets the sender window's active tab (its own workspace).
  const win = winOf(evt);
  const tab = activeTab(win);
  currentConfig = { ...currentConfig, model: trimmed };
  writeConfig(currentConfig);
  if (tab) tab.model = trimmed;
  logEvent("sys", { ev: "model-changed", model: trimmed });
  // Change the model on the LIVE session (takes effect next turn) rather than
  // respawning the engine — a restart would drop the current conversation. The
  // persisted config still makes it the default a future (re)start uses.
  const workspace = (tab && tab.workspace) || currentConfig.workspace;
  // Remember the choice on the workspace itself, so reopening its tab restores
  // this model instead of falling back to the global/last-focused one.
  if (workspace) persistWorkspaceModel(workspace, trimmed);
  if (workspace && tab && tab.child) {
    writeToEngine({ type: "set_model", model: trimmed }, tab.id);
  } else if (workspace) {
    // No live engine to update (not yet linked / crashed) — bring one up on the
    // chosen model so the picker still connects.
    startEngine(workspace, trimmed, tab && tab.id);
    sendToRenderer("engine:restarted", { model: trimmed }, win);
  }
  return currentConfig;
});

ipcMain.handle("settings:getWebSearch", () => {
  const settings = readWorkspaceSettings(currentConfig.workspace);
  // The engine defaults to enabled; only an explicit false turns it off.
  return !(settings.search && settings.search.enabled === false);
});

ipcMain.handle("settings:setWebSearch", (_evt, enabled) => {
  if (typeof enabled !== "boolean") return { ok: false, error: "invalid value" };

  const workspace = currentConfig.workspace;
  if (!workspace) return { ok: false, error: "no workspace" };

  const error = updateWorkspaceSettings(workspace, (settings) => {
    const search =
      settings.search && typeof settings.search === "object" && !Array.isArray(settings.search)
        ? settings.search
        : {};
    settings.search = { ...search, enabled };
  });
  if (error) return { ok: false, error: `failed to write settings: ${error}` };

  logEvent("sys", { ev: "websearch-changed", enabled });
  startEngine(workspace, currentConfig.model);
  sendToRenderer("engine:restarted", { model: currentConfig.model }, tabForWorkspace(workspace)?.win);
  return { ok: true };
});

/** Open a workspace: persist it, remember it, then either start the engine or
 *  trigger the setup wizard. Shared by the folder dialog and recent-folder
 *  clicks so there is exactly one open path. */
function openWorkspace(workspace, win) {
  const w = win || mainWindow;
  // Same-folder rule: one live session per folder (across ALL windows) — focus
  // the existing tab instead of opening a second engine on the same directory.
  const existing = tabForWorkspace(workspace);
  if (existing) {
    focusTab(existing.id);
    return currentConfig;
  }
  // Cap: at most MAX_TABS live tabs across the app. The renderer shows the notice.
  if (engineTabs.size >= MAX_TABS) {
    sendToRenderer("tab:cap", { max: MAX_TABS }, w);
    return currentConfig;
  }
  const tab = createTab(workspace, w);
  if (w) w.mgActiveTabId = tab.id;
  currentConfig = rememberWorkspace({ ...currentConfig, workspace }, workspace);
  writeConfig(currentConfig);
  // Recents are app-global — every window's sidebar reflects them.
  broadcastToRenderers("workspace:recent", currentConfig.recentWorkspaces || []);
  setLogWorkspace(workspace);
  logEvent("sys", { ev: "workspace-changed", workspace, tabId: tab.id });
  // Tell this window's renderer to create+focus the tab BEFORE the engine can
  // speak, so the tagged workspace_changed/session events route into it.
  sendToRenderer("tab:opened", { tabId: tab.id, workspace }, w);
  sendToRenderer("engine:event", { type: "workspace_changed", workspace, tabId: tab.id }, w);
  if (hasCredentials(workspace)) {
    // Honour the workspace's OWN saved model — not the focused tab's — so opening
    // a2/a3/a4 while a1 is focused doesn't run them on a1's model.
    startEngine(workspace, savedWorkspaceModel(workspace) || currentConfig.model, tab.id);
  } else {
    sendToRenderer("setup:required", { workspace, tabId: tab.id }, w);
    logEvent("sys", { ev: "setup-required", tabId: tab.id });
  }
  return currentConfig;
}

ipcMain.on("tab:focus", (_evt, tabId) => {
  if (typeof tabId === "string") focusTab(tabId);
});

ipcMain.on("tab:close", (_evt, tabId) => {
  if (typeof tabId === "string") closeTab(tabId);
});

// The window buttons the renderer draws while full screen hides the native
// title bar — the same three actions that bar offers. Acts on the calling
// window, so a secondary window closes itself and not the main one.
ipcMain.on("window:control", (evt, action) => {
  const win = winOf(evt);
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  else if (action === "close") win.close();
  else if (action === "toggleFullScreen") win.setFullScreen(!win.isFullScreen());
});

// Open a workspace in a SEPARATE window ("open in new window"). The same-folder
// rule still applies — an already-open folder just focuses its tab.
ipcMain.on("window:open", (_evt, workspace) => {
  if (typeof workspace !== "string" || !workspace) return;
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) return;
  const existing = tabForWorkspace(workspace);
  if (existing) {
    focusTab(existing.id);
    return;
  }
  if (engineTabs.size >= MAX_TABS) {
    sendToRenderer("tab:cap", { max: MAX_TABS });
    return;
  }
  const win = createExtraWindow();
  win.webContents.once("did-finish-load", () => openWorkspace(workspace, win));
});

ipcMain.handle("workspace:choose", async (evt) => {
  const win = winOf(evt);
  if (!win) return currentConfig;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return currentConfig;
  return openWorkspace(result.filePaths[0], win);
});

ipcMain.handle("workspace:open", (evt, workspace) => {
  if (typeof workspace !== "string" || !workspace) return currentConfig;
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    // A recent folder that no longer exists: drop it and tell every window.
    currentConfig = {
      ...currentConfig,
      recentWorkspaces: (currentConfig.recentWorkspaces || []).filter((p) => p !== workspace),
    };
    writeConfig(currentConfig);
    broadcastToRenderers("workspace:recent", currentConfig.recentWorkspaces);
    return currentConfig;
  }
  return openWorkspace(workspace, winOf(evt));
});

ipcMain.on("engine:send", (evt, payload) => {
  // Back-compat + per-tab routing: a bare frame (it has a string `type`) targets
  // the SENDER WINDOW's active tab; a { frame, tabId } envelope (no top-level
  // `type`) targets a specific tab's engine — so a background tab's reply reaches
  // the engine that asked, not whichever tab is focused.
  const envelope = payload && typeof payload === "object" && typeof payload.type !== "string";
  const frame = envelope ? payload.frame : payload;
  const tabId = envelope ? payload.tabId : activeTab(winOf(evt))?.id;
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") {
    logEvent("sys", { ev: "invalid-frame" });
    return;
  }
  writeToEngine(frame, tabId);
});

ipcMain.on("engine:setModes", (evt, activeIds) => {
  writeToEngine({ type: "set_modes", active: activeIds }, activeTab(winOf(evt))?.id);
});

ipcMain.on("engine:interrupt", (evt) => {
  writeToEngine({ type: "interrupt" }, activeTab(winOf(evt))?.id);
});

// Restart after a crash — the failure banner's way back without re-running setup.
// Targets the sender window's active tab (its own workspace/engine).
ipcMain.on("engine:restart", (evt) => {
  const tab = activeTab(winOf(evt));
  const workspace = (tab && tab.workspace) || currentConfig.workspace;
  if (!workspace) return;
  const model = (tab && tab.model) || currentConfig.model;
  startEngine(workspace, model, tab && tab.id);
  sendToRenderer("engine:restarted", { model }, winOf(evt));
});

ipcMain.on("engine:permission", (evt, { id, decision, message, tabId }) => {
  // Route the decision to the engine that ASKED — with concurrent tabs the
  // request may belong to a background tab, not the focused one. Fall back to the
  // active tab (single-tab / untagged requests).
  const target = tabId && engineTabs.has(tabId) ? tabId : activeTab(winOf(evt))?.id;
  writeToEngine({ type: "permission_response", id, decision, ...(message ? { message } : {}) }, target);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  try {
    logEvent("sys", {
      ev: "uncaughtException",
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined,
    });
    flushLog();
  } catch {
    // never let logging itself mask the original error
  }
  throw err;
});

app.on("web-contents-created", (_evt, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    // Allow a document to reload ITSELF — a reload is a navigation to the
    // current URL, and the "Welcome page" home button (composer.js) returns to
    // the start screen by reloading the renderer. Block navigation anywhere
    // else (external links, foreign origins) for the main window and any child
    // contents alike. This is the single source of truth for navigation policy.
    if (url === contents.getURL()) return;
    event.preventDefault();
  });
});

// ---------------------------------------------------------------------------
// Update check (notify-only). The binaries ship unsigned (no code-signing cert
// yet), so silent auto-update is off the table — instead, compare the latest
// GitHub release tag against this build once per launch and tell the user.
// ---------------------------------------------------------------------------

const RELEASES_URL = "https://github.com/kalai-labs/MAGENTRA/releases/latest";

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when this install format can self-update (electron-updater support):
 *  Windows NSIS and Linux AppImage. tar.gz/deb and the unsigned mac dmg
 *  cannot — those fall back to the notify-only release poll below. */
function selfUpdateSupported() {
  return process.platform === "win32" || Boolean(process.env.APPIMAGE);
}

async function checkForUpdates() {
  if (!app.isPackaged) return;
  if (selfUpdateSupported()) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.logger = { info: () => {}, warn: () => {}, error: (m) => logEvent("sys", { ev: "updater-error", m: String(m) }) };
      autoUpdater.on("update-downloaded", (info) => {
        logEvent("sys", { ev: "update-downloaded", version: info?.version });
        sendToRenderer("engine:event", {
          type: "command_output",
          text: `⬆ MAGENTRA ${info?.version ?? ""} downloaded — it installs when you quit the app.`,
        });
      });
      await autoUpdater.checkForUpdatesAndNotify();
      return;
    } catch (err) {
      // Fall through to the notify-only poll: an updater failure must never
      // cost the user the "a new version exists" signal.
      logEvent("sys", { ev: "updater-fallback", m: String(err && err.message) });
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://api.github.com/repos/kalai-labs/MAGENTRA/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const body = await res.json();
    const latest = body && typeof body.tag_name === "string" ? body.tag_name : null;
    const current = require("./package.json").magentraVersion || app.getVersion();
    if (latest && compareVersions(latest, current) > 0) {
      logEvent("sys", { ev: "update-available", current, latest });
      sendToRenderer("engine:event", {
        type: "command_output",
        text: `⬆ MAGENTRA ${latest} is available (you run v${current}). Download: ${RELEASES_URL}`,
      });
    }
  } catch {
    // offline or rate-limited — try again next launch
  }
}

app.whenReady().then(() => {
  // The in-app menu bar (renderer #menuBar) replaces the native menu in
  // packaged builds — no Alt-flash of a foreign File/Edit strip. Development
  // keeps Electron's default menu for its devtools/reload accelerators.
  if (app.isPackaged && process.platform !== "darwin") Menu.setApplicationMenu(null);
  // Arm the userData/logs mirror first: a crash on the landing page (before
  // any workspace opens) must still leave a log a user can find from the UI.
  initFallbackLog(app.getPath("userData"));
  createWindow();
  setTimeout(() => void checkForUpdates(), 5000);
});

app.on("window-all-closed", () => {
  stopAllEngines();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopAllEngines();
});

app.on("will-quit", () => {
  flushLog();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
