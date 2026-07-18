"use strict";

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const {
  DEFAULT_MODEL,
  configPath,
  readConfig,
  writeConfig,
  rememberWorkspace,
  isLocalBaseUrl,
  shouldStartMaximized,
} = require("./main/config.js");
const { logEvent, setLogWorkspace, flushLog, initFallbackLog, activeLogsDir } = require("./main/logging.js");
const { resolveWorkspaceFile, undoWorkspaceDiffs } = require("./main/changes.js");

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
/** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
let engineChild = null;
let engineStdoutBuffer = "";
let engineStderrBuffer = "";

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

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// The child from a previous stopEngine that has not exited yet. A replacement
// must never spawn while it lives — two engines in one process tree race over
// the same workspace state.
let dyingEngine = null;

function stopEngine() {
  if (engineChild) {
    const child = engineChild;
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
    dyingEngine = child;
    child.once("exit", () => {
      clearTimeout(killTimer);
      if (dyingEngine === child) dyingEngine = null;
    });
    engineChild = null;
  }
  engineStdoutBuffer = "";
  engineStderrBuffer = "";
}

// Frames that represent an explicit user action: dropping one silently reads
// as "the app ignored me". State-sync frames (set_mode, set_modes,
// set_deletion_guard, reload_team) are re-sent on session start, so their
// drops stay quiet by design — the renderer fires them before any engine runs.
const USER_ACTION_FRAMES = new Set([
  "user_message",
  "slash_command",
  "bang_command",
  "interrupt",
  "permission_response",
  "question_response",
  "plan_decision",
  "resume_session",
  "delete_session",
  "list_sessions",
  "bang_command",
  "stop_background",
  "rename_session",
  "archive_session",
]);

function writeToEngine(frame) {
  if (engineChild && engineChild.stdin.writable) {
    engineChild.stdin.write(JSON.stringify(frame) + "\n");
    logEvent("ui", frame);
    return;
  }
  logEvent("sys", { ev: "engine-write-dropped", type: frame && frame.type });
  if (frame && USER_ACTION_FRAMES.has(frame.type)) {
    sendToRenderer("engine:event", {
      type: "error",
      message: "The engine is not running — restart it from the banner, or reopen the workspace.",
      fatal: false,
    });
  }
}

const API_KEY_ENV_LINE_RE = /^\s*(?:export\s+)?[A-Z0-9_]*API_KEY\s*=\s*\S/;

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

/** Best-effort check for whether a workspace already has API credentials
 * configured, so we know whether to run the engine or trigger the setup
 * wizard instead. Never throws — treats unreadable/missing files as "no". */
function hasCredentials(workspace) {
  if (!workspace) return false;

  try {
    const envPath = path.join(workspace, ".env");
    const content = fs.readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (API_KEY_ENV_LINE_RE.test(line)) return true;
    }
  } catch {
    // missing/unreadable .env — ignore
  }

  if (
    (typeof process.env.DEEPINFRA_API_KEY === "string" && process.env.DEEPINFRA_API_KEY.trim() !== "") ||
    (typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.trim() !== "")
  ) {
    return true;
  }

  try {
    const settingsPath = path.join(workspace, ".magentra", "settings.json");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed.apiKeyEnv === "string" && parsed.apiKeyEnv) {
      const val = process.env[parsed.apiKeyEnv];
      if (typeof val === "string" && val.trim() !== "") return true;
    }
    // A local endpoint (Ollama, LM Studio) is fully configured without a key.
    if (parsed && parsed.provider === "openai-compatible" && isLocalBaseUrl(parsed.baseUrl)) {
      return true;
    }
  } catch {
    // missing/invalid settings.json — ignore
  }

  return false;
}

function startEngine(workspace, model) {
  const isRestart = !!engineChild;
  stopEngine();

  if (!workspace) return;

  // Never spawn a replacement while the old child lives: wait for its exit
  // (stopEngine escalates to SIGKILL after 3s, so this always resolves).
  if (dyingEngine) {
    dyingEngine.once("exit", () => startEngine(workspace, model));
    return;
  }

  const entry = engineEntryPoint();
  const args = [...entry.args, "--serve", "--dangerously-bypass", "--cwd", workspace];

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
    });
    return;
  }

  engineChild = child;
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
    engineStdoutBuffer += chunk;
    let idx;
    while ((idx = engineStdoutBuffer.indexOf("\n")) !== -1) {
      const line = engineStdoutBuffer.slice(0, idx).replace(/\r$/, "");
      engineStdoutBuffer = engineStdoutBuffer.slice(idx + 1);
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
      sendToRenderer("engine:event", event);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    engineStderrBuffer += chunk;
    let idx;
    while ((idx = engineStderrBuffer.indexOf("\n")) !== -1) {
      const line = engineStderrBuffer.slice(0, idx).replace(/\r$/, "");
      engineStderrBuffer = engineStderrBuffer.slice(idx + 1);
      if (line.trim() === "") continue;
      logEvent("stderr", line);
      sendToRenderer("engine:event", { type: "engine_stderr", text: line });
    }
  });

  child.on("exit", (code, signal) => {
    const expected = !!child.expectedExit;
    logEvent("sys", { ev: "exit", pid: child.pid, code, signal, expected });
    flushLog();
    // Signal deaths (SIGSEGV, OOM-kill) have code === null — the renderer must
    // treat any unexpected exit as fatal, whatever the exit code says.
    sendToRenderer("engine:event", { type: "engine_exit", code, signal, expected });
    if (engineChild === child) engineChild = null;
  });

  child.on("error", (err) => {
    sendToRenderer("engine:event", {
      type: "error",
      message: `Engine process error: ${err && err.message ? err.message : String(err)}`,
      fatal: true,
    });
  });

  // Credential sanity check — engine still starts regardless. A keyless local
  // endpoint (Ollama, LM Studio) counts as configured, so it won't warn.
  if (!hasCredentials(workspace)) {
    sendToRenderer("engine:event", {
      type: "error",
      message: "No credentials for this workspace — open Setup to add a provider.",
      fatal: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Crew designer (CREW / TEAM view) file operations
// ---------------------------------------------------------------------------

function teamDir(workspace) {
  return path.join(workspace, ".magentra", "team");
}

const AGENT_ID_RE = /^[a-z0-9_-]+$/;

function dedupeFileName(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let candidate = baseName;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n++;
  }
  return candidate;
}

/** Minimally parse the `---` frontmatter block and append relPath to the
 * `docs:` line (comma-separated), inserting a docs line if none exists. */
function appendDocToFrontmatter(content, relPath) {
  const lines = content.split(/\r?\n/);
  if (lines[0] === undefined || lines[0].trim() !== "---") {
    return `---\ndocs: ${relPath}\n---\n\n${content}`;
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return `---\ndocs: ${relPath}\n---\n\n${content}`;
  }
  let docsLineIdx = -1;
  for (let i = 1; i < endIdx; i++) {
    if (/^docs\s*:/.test(lines[i])) {
      docsLineIdx = i;
      break;
    }
  }
  if (docsLineIdx !== -1) {
    const line = lines[docsLineIdx];
    const sepIdx = line.indexOf(":");
    const key = line.slice(0, sepIdx);
    const existing = line.slice(sepIdx + 1).trim();
    lines[docsLineIdx] = existing ? `${key}: ${existing}, ${relPath}` : `${key}: ${relPath}`;
  } else {
    lines.splice(endIdx, 0, `docs: ${relPath}`);
  }
  return lines.join("\n");
}

/** Copy filePath into <workspace>/.magentra/team/docs, append it to the
 * agent's frontmatter `docs:` list, and tell the engine to reload the team.
 * Shared by team:addDoc (drag&drop) and team:pickDoc (file dialog). */
function addDocToAgent(workspace, agentId, filePath) {
  if (
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    throw new Error("invalid file");
  }

  const docsDir = path.join(teamDir(workspace), "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const destName = dedupeFileName(docsDir, path.basename(filePath));
  const destPath = path.join(docsDir, destName);
  fs.copyFileSync(filePath, destPath);
  const relPath = path.relative(workspace, destPath).split(path.sep).join("/");

  const teamFilePath = path.join(teamDir(workspace), `${agentId}.md`);
  let content;
  try {
    content = fs.readFileSync(teamFilePath, "utf8");
  } catch {
    content = `---\nname: ${agentId}\n---\n`;
  }
  fs.writeFileSync(teamFilePath, appendDocToFrontmatter(content, relPath), "utf8");

  writeToEngine({ type: "reload_team" });
  logEvent("sys", { ev: "team-doc-added", agentId, doc: relPath });
  return relPath;
}

ipcMain.handle("team:addDoc", async (_evt, { agentId, filePath }) => {
  try {
    const workspace = currentConfig.workspace;
    if (!workspace) return { ok: false, error: "no workspace open" };

    const doc = addDocToAgent(workspace, agentId, filePath);
    return { ok: true, doc };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "team-doc-add-failed", agentId, error: message });
    return { ok: false, error: message };
  }
});

ipcMain.handle("team:pickDoc", async (_evt, agentId) => {
  try {
    if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
      return { ok: false, error: "invalid agentId" };
    }
    const workspace = currentConfig.workspace;
    if (!workspace) return { ok: false, error: "no workspace open" };

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [
        { name: "Documents", extensions: ["pdf", "docx", "md", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };

    const doc = addDocToAgent(workspace, agentId, result.filePaths[0]);
    return { ok: true, doc };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "team-doc-add-failed", agentId, error: message });
    return { ok: false, error: message };
  }
});

ipcMain.handle("team:editAgent", async (_evt, agentId) => {
  try {
    if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
      return { ok: false };
    }
    const workspace = currentConfig.workspace;
    if (!workspace) return { ok: false };

    const teamFilePath = path.join(teamDir(workspace), `${agentId}.md`);
    const errorMessage = await shell.openPath(teamFilePath);
    if (errorMessage) {
      logEvent("sys", { ev: "team-edit-agent-failed", agentId, error: errorMessage });
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "team-edit-agent-failed", agentId, error: message });
    return { ok: false };
  }
});

ipcMain.handle("team:createTemplate", async () => {
  try {
    const workspace = currentConfig.workspace;
    if (!workspace) return { ok: false, error: "no workspace open" };

    const dir = teamDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(dir, `agent-${n}.md`))) n++;
    const id = `agent-${n}`;
    const content = [
      "---",
      "name: New Agent",
      "role: Specialist",
      "emoji: ◆",
      "docs:",
      "---",
      "",
      "Describe this agent's expertise and how it should work.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");

    writeToEngine({ type: "reload_team" });
    logEvent("sys", { ev: "team-template-created", id });
    return { ok: true, id };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "team-template-create-failed", error: message });
    return { ok: false, error: message };
  }
});

ipcMain.on("team:reload", () => {
  writeToEngine({ type: "reload_team" });
});

ipcMain.handle("team:removeAgent", async (_evt, agentId) => {
  try {
    if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
      logEvent("sys", { ev: "team-remove-agent-failed", agentId, error: "invalid agentId" });
      return { removed: false };
    }

    const workspace = currentConfig.workspace;
    if (!workspace) return { removed: false };

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Dismiss agent",
      message: `Dismiss ${agentId} from the crew?`,
      detail: "The team file and its backpack index will be deleted. This cannot be undone from the app.",
      buttons: ["Cancel", "Dismiss"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return { removed: false };

    const teamFilePath = path.join(teamDir(workspace), `${agentId}.md`);
    try {
      fs.unlinkSync(teamFilePath);
    } catch (err) {
      logEvent("sys", { ev: "team-remove-agent-md-missing", agentId, error: err.message });
    }

    const backpackDir = path.join(teamDir(workspace), "backpacks", agentId);
    try {
      fs.rmSync(backpackDir, { recursive: true, force: true });
    } catch (err) {
      logEvent("sys", { ev: "team-remove-agent-backpack-failed", agentId, error: err.message });
    }

    writeToEngine({ type: "reload_team" });
    logEvent("sys", { ev: "team-agent-removed", agentId });
    return { removed: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logEvent("sys", { ev: "team-remove-agent-failed", agentId, error: message });
    return { removed: false };
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
let windowStateTimer = null;
function rememberWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    // getBounds() while maximized reports the maximized rect; keep the
    // last restored bounds so un-maximizing after a restart looks right.
    const bounds = maximized ? (currentConfig.window || mainWindow.getNormalBounds()) : mainWindow.getBounds();
    currentConfig = {
      ...currentConfig,
      window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized },
    };
    writeConfig(currentConfig);
  }, 400);
}

// Concept A uses one neutral workbench titlebar, also reasserted by the
// renderer so the native controls stay visually integrated.
const TITLEBAR_HEIGHT = 36;
const DEFAULT_TITLEBAR = { color: "#0e1114", symbolColor: "#ced6dd", height: TITLEBAR_HEIGHT };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    ...savedWindowBounds(),
    // Hide the OS title bar — the app's own top strip becomes the drag region,
    // so no foreign gray band sits above the themed UI. Windows/Linux get the
    // native window controls overlaid top-right; macOS keeps its inset
    // traffic lights (the dock reserves room for them).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" }
      : { titleBarStyle: "hidden", titleBarOverlay: DEFAULT_TITLEBAR }),
    // The responsive floor the stylesheet is built for — below this, panels
    // would clip horizontally rather than wrap.
    minWidth: 700,
    minHeight: 480,
    backgroundColor: "#0b0e11",
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

  // Every launch opens like a professional IDE: maximized, with native window
  // controls still available. Un-maximizing mid-session restores the saved
  // bounds; the next launch starts maximized again.
  if (shouldStartMaximized()) mainWindow.maximize();
  mainWindow.on("resize", rememberWindowState);
  mainWindow.on("move", rememberWindowState);
  mainWindow.on("maximize", rememberWindowState);
  mainWindow.on("unmaximize", rememberWindowState);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

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

// ---------------------------------------------------------------------------
// First-run setup wizard (credential entry)
// ---------------------------------------------------------------------------

const DEEPINFRA_DEFAULT_BASE_URL = "https://api.deepinfra.com/v1/openai";

/** Shared validation for the setup wizard's writeEnv/testConnection payloads.
 * Never echoes the apiKey back in error messages or logs. */
function validateCredentialPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid payload" };
  }

  const { apiKey, model, provider, baseUrl, contextWindow } = payload;

  // Local servers (Ollama, LM Studio) need no key; every hosted endpoint does.
  const local = isLocalBaseUrl(baseUrl);
  if (typeof apiKey !== "string") {
    return { ok: false, error: "apiKey is required" };
  }
  // Pasted keys routinely arrive with a trailing newline/space; trimming here
  // keeps TEST, .env, and the engine all seeing the exact same string.
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length === 0 && !local) {
    return { ok: false, error: "apiKey is required" };
  }
  if (trimmedKey.length > 4096) {
    return { ok: false, error: "apiKey is too long" };
  }
  if (/[\r\n]/.test(trimmedKey)) {
    return { ok: false, error: "apiKey must not contain newlines" };
  }

  let resolvedContextWindow;
  if (contextWindow !== undefined && contextWindow !== null && contextWindow !== "") {
    const n = Number(contextWindow);
    if (!Number.isInteger(n) || n < 256 || n > 10_000_000) {
      return { ok: false, error: "invalid context size" };
    }
    resolvedContextWindow = n;
  }

  let resolvedModel = DEFAULT_MODEL;
  if (model !== undefined && model !== null && model !== "") {
    if (typeof model !== "string" || model.length > 200) {
      return { ok: false, error: "invalid model" };
    }
    resolvedModel = model;
  }

  let resolvedProvider = "openai-compat";
  if (provider !== undefined && provider !== null && provider !== "") {
    if (provider !== "anthropic" && provider !== "openai-compat") {
      return { ok: false, error: "invalid provider" };
    }
    resolvedProvider = provider;
  }

  let resolvedBaseUrl = "";
  if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") {
    if (typeof baseUrl !== "string") {
      return { ok: false, error: "invalid baseUrl" };
    }
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return { ok: false, error: "invalid baseUrl" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "invalid baseUrl" };
    }
    resolvedBaseUrl = baseUrl;
  }

  return {
    ok: true,
    apiKey: trimmedKey,
    model: resolvedModel,
    provider: resolvedProvider,
    baseUrl: resolvedBaseUrl,
    contextWindow: resolvedContextWindow,
  };
}

ipcMain.handle("setup:writeEnv", async (_evt, payload) => {
  // SAVE with an empty key field keeps the already-saved key: the user is
  // updating model/URL/context, not the credential.
  if (payload && typeof payload === "object" && payload.useSavedKey) {
    payload = { ...payload, apiKey: savedWorkspaceKey() };
  }
  const validated = validateCredentialPayload(payload);
  if (!validated.ok) return validated;
  const { apiKey, model, provider, baseUrl, contextWindow } = validated;

  const workspace = currentConfig.workspace;
  if (!workspace) return { ok: false, error: "no workspace" };

  const envVarName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "DEEPINFRA_API_KEY";

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
      const keyLineRe = new RegExp(`^\\s*(?:export\\s+)?${envVarName}\\s*=`);
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

  try {
    const magentraDir = path.join(workspace, ".magentra");
    fs.mkdirSync(magentraDir, { recursive: true });
    const settingsPath = path.join(magentraDir, "settings.json");
    let settings = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch {
      settings = {};
    }

    // The engine's settings schema names the provider "openai-compatible".
    settings.provider = provider === "anthropic" ? "anthropic" : "openai-compatible";
    if (provider === "openai-compat" && baseUrl && baseUrl !== DEEPINFRA_DEFAULT_BASE_URL) {
      settings.baseUrl = baseUrl;
    } else {
      delete settings.baseUrl;
    }
    settings.model = model;
    // Context size: engine compaction window + `num_ctx` for local servers.
    // An EMPTY field must clear a previous override — a stale tiny window
    // shadowing the model's real one causes constant compaction.
    if (contextWindow !== undefined) {
      settings.contextWindow = contextWindow;
    } else {
      delete settings.contextWindow;
      // The engine merges project settings over ~/.magentra/settings.json —
      // a leftover in the GLOBAL layer would silently win right back, so the
      // clear must reach it too (best-effort).
      try {
        const globalPath = path.join(os.homedir(), ".magentra", "settings.json");
        const globalSettings = JSON.parse(fs.readFileSync(globalPath, "utf8"));
        if (globalSettings && typeof globalSettings === "object" && "contextWindow" in globalSettings) {
          delete globalSettings.contextWindow;
          fs.writeFileSync(globalPath, JSON.stringify(globalSettings, null, 2), "utf8");
        }
      } catch {
        // no global settings file — nothing to clear
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: `failed to write settings: ${message}` };
  }

  currentConfig = { ...currentConfig, model };
  writeConfig(currentConfig);
  logEvent("sys", { ev: "env-written", provider });
  startEngine(workspace, model);
  return { ok: true };
});

/** The saved key for the current workspace (first *_API_KEY line of .env). */
function savedWorkspaceKey() {
  const keys = readWorkspaceEnvKeys(currentConfig.workspace);
  const name = Object.keys(keys)[0];
  return name ? keys[name] : "";
}

// What the Settings → Connection card shows on open: the saved endpoint and
// whether a key exists (never the key itself — that goes through revealKey).
ipcMain.handle("connection:info", () => {
  const workspace = currentConfig.workspace;
  const info = { baseUrl: "", model: currentConfig.model || "", provider: "openai-compat", contextWindow: "", hasKey: false };
  if (!workspace) return info;
  info.hasKey = savedWorkspaceKey() !== "";
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".magentra", "settings.json"), "utf8"));
    if (settings && typeof settings === "object") {
      if (typeof settings.baseUrl === "string") info.baseUrl = settings.baseUrl;
      if (typeof settings.model === "string") info.model = settings.model;
      if (settings.provider === "anthropic") info.provider = "anthropic";
      if (Number.isFinite(settings.contextWindow)) info.contextWindow = String(settings.contextWindow);
    }
  } catch {
    // no settings file yet — defaults stand
  }
  return info;
});

// The actual saved key, on explicit request (the reveal button). It is the
// user's own workspace .env on their own machine — "reveal" must mean reveal.
ipcMain.handle("connection:revealKey", () => ({ key: savedWorkspaceKey() }));

ipcMain.handle("setup:testConnection", async (_evt, payload) => {
  // An empty key field with a saved key means "test the saved connection".
  if (payload && typeof payload === "object" && payload.useSavedKey) {
    payload = { ...payload, apiKey: savedWorkspaceKey() };
  }
  const validated = validateCredentialPayload(payload);
  if (!validated.ok) return validated;
  const { apiKey, provider, baseUrl } = validated;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    let res;
    if (provider === "anthropic") {
      res = await fetch("https://api.anthropic.com/v1/models", {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
    } else {
      const effectiveBaseUrl = baseUrl || DEEPINFRA_DEFAULT_BASE_URL;
      res = await fetch(`${effectiveBaseUrl.replace(/\/$/, "")}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
    }
    // Both API shapes list models as data[].id — hand them to the wizard so
    // its model picker reflects the actual endpoint, not a hardcoded preset.
    let models = [];
    if (res.ok) {
      try {
        const body = await res.json();
        if (body && Array.isArray(body.data)) {
          models = body.data.map((m) => m && m.id).filter((id) => typeof id === "string");
        }
      } catch {
        // a catalog is a bonus; the reachability result stands on its own
      }
    }
    return { ok: res.ok, status: res.status, models };
  } catch (err) {
    const message =
      err && err.name === "AbortError" ? "timed out" : err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
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
  if (typeof mainWindow.setTitleBarOverlay !== "function") return; // macOS: no overlay
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
  "https://deepinfra.com/dash/api_keys",
  "https://console.anthropic.com/settings/keys",
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

ipcMain.handle("config:setModel", (_evt, model) => {
  if (typeof model !== "string") return currentConfig;
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return currentConfig;

  currentConfig = { ...currentConfig, model: trimmed };
  writeConfig(currentConfig);
  logEvent("sys", { ev: "model-changed", model: currentConfig.model });
  if (currentConfig.workspace) {
    startEngine(currentConfig.workspace, currentConfig.model);
    sendToRenderer("engine:restarted", { model: currentConfig.model });
  }
  return currentConfig;
});

ipcMain.handle("settings:getWebSearch", () => {
  const workspace = currentConfig.workspace;
  if (!workspace) return true;
  try {
    const settingsPath = path.join(workspace, ".magentra", "settings.json");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return !(parsed.search && parsed.search.enabled === false);
    }
  } catch {
    // missing or unparseable settings.json — the engine defaults to enabled
  }
  return true;
});

ipcMain.handle("settings:setWebSearch", (_evt, enabled) => {
  if (typeof enabled !== "boolean") return { ok: false, error: "invalid value" };

  const workspace = currentConfig.workspace;
  if (!workspace) return { ok: false, error: "no workspace" };

  try {
    const magentraDir = path.join(workspace, ".magentra");
    fs.mkdirSync(magentraDir, { recursive: true });
    const settingsPath = path.join(magentraDir, "settings.json");
    let settings = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch {
      settings = {};
    }

    const search =
      settings.search && typeof settings.search === "object" && !Array.isArray(settings.search)
        ? settings.search
        : {};
    settings.search = { ...search, enabled };

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: `failed to write settings: ${message}` };
  }

  logEvent("sys", { ev: "websearch-changed", enabled });
  startEngine(workspace, currentConfig.model);
  sendToRenderer("engine:restarted", { model: currentConfig.model });
  return { ok: true };
});

/** Open a workspace: persist it, remember it, then either start the engine or
 *  trigger the setup wizard. Shared by the folder dialog and recent-folder
 *  clicks so there is exactly one open path. */
function openWorkspace(workspace) {
  currentConfig = rememberWorkspace({ ...currentConfig, workspace }, workspace);
  writeConfig(currentConfig);
  // Keep the sidebar's workspace list current — the opened folder moves to
  // the top of the recents the renderer shows.
  sendToRenderer("workspace:recent", currentConfig.recentWorkspaces || []);
  setLogWorkspace(workspace);
  logEvent("sys", { ev: "workspace-changed", workspace });
  // Reset workspace-scoped renderer state before the replacement engine can
  // emit anything. Waiting for the invoke response races a fast engine boot.
  sendToRenderer("engine:event", { type: "workspace_changed", workspace });
  if (hasCredentials(workspace)) {
    startEngine(workspace, currentConfig.model);
  } else {
    sendToRenderer("setup:required", { workspace });
    logEvent("sys", { ev: "setup-required" });
  }
  return currentConfig;
}

ipcMain.handle("workspace:choose", async () => {
  if (!mainWindow) return currentConfig;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return currentConfig;
  return openWorkspace(result.filePaths[0]);
});

ipcMain.handle("workspace:open", (_evt, workspace) => {
  if (typeof workspace !== "string" || !workspace) return currentConfig;
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    // A recent folder that no longer exists: drop it and tell the renderer.
    currentConfig = {
      ...currentConfig,
      recentWorkspaces: (currentConfig.recentWorkspaces || []).filter((p) => p !== workspace),
    };
    writeConfig(currentConfig);
    sendToRenderer("workspace:recent", currentConfig.recentWorkspaces);
    return currentConfig;
  }
  return openWorkspace(workspace);
});

ipcMain.on("engine:send", (_evt, frame) => {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") {
    logEvent("sys", { ev: "invalid-frame" });
    return;
  }
  writeToEngine(frame);
});

ipcMain.on("engine:setModes", (_evt, activeIds) => {
  writeToEngine({ type: "set_modes", active: activeIds });
});

ipcMain.on("engine:interrupt", () => {
  writeToEngine({ type: "interrupt" });
});

// Restart after a crash — the failure banner's way back without re-running setup.
ipcMain.on("engine:restart", () => {
  if (!currentConfig.workspace) return;
  startEngine(currentConfig.workspace, currentConfig.model);
  sendToRenderer("engine:restarted", { model: currentConfig.model });
});

ipcMain.on("engine:permission", (_evt, { id, decision }) => {
  writeToEngine({ type: "permission_response", id, decision });
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
  contents.on("will-navigate", (event) => {
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

async function checkForUpdates() {
  if (!app.isPackaged) return;
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
  stopEngine();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopEngine();
});

app.on("will-quit", () => {
  flushLog();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
