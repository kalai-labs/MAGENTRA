"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const {
  DEFAULT_MODEL,
  configPath,
  readConfig,
  writeConfig,
  rememberWorkspace,
  isLocalBaseUrl,
} = require("./main/config.js");
const { logEvent, setLogWorkspace, flushLog } = require("./main/logging.js");

const SMOKE = process.argv.includes("--smoke");

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

function stopEngine() {
  if (engineChild) {
    logEvent("sys", { ev: "kill", pid: engineChild.pid });
    try {
      engineChild.stdin.end();
    } catch {
      // ignore
    }
    try {
      engineChild.kill();
    } catch {
      // ignore
    }
    engineChild = null;
  }
  engineStdoutBuffer = "";
  engineStderrBuffer = "";
}

function writeToEngine(frame) {
  if (engineChild && engineChild.stdin.writable) {
    engineChild.stdin.write(JSON.stringify(frame) + "\n");
    logEvent("ui", frame);
  }
}

const API_KEY_ENV_LINE_RE = /^\s*(?:export\s+)?[A-Z0-9_]*API_KEY\s*=\s*\S/;

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

  const entry = engineEntryPoint();
  const args = [...entry.args, "--serve", "--dangerously-bypass", "--cwd", workspace];

  const env = {
    ...process.env,
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

  child.on("exit", (code) => {
    logEvent("sys", { ev: "exit", pid: child.pid, code });
    flushLog();
    sendToRenderer("engine:event", { type: "engine_exit", code });
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    backgroundColor: "#050805",
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
  if (typeof apiKey !== "string" || (apiKey.length === 0 && !local)) {
    return { ok: false, error: "apiKey is required" };
  }
  if (apiKey.length > 4096) {
    return { ok: false, error: "apiKey is too long" };
  }
  if (/[\r\n]/.test(apiKey)) {
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
    apiKey,
    model: resolvedModel,
    provider: resolvedProvider,
    baseUrl: resolvedBaseUrl,
    contextWindow: resolvedContextWindow,
  };
}

ipcMain.handle("setup:writeEnv", async (_evt, payload) => {
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
      fs.writeFileSync(envPath, keptLines.join("\n") + "\n", "utf8");
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
    if (contextWindow !== undefined) {
      settings.contextWindow = contextWindow;
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

ipcMain.handle("setup:testConnection", async (_evt, payload) => {
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
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const message =
      err && err.name === "AbortError" ? "timed out" : err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle("app:info", () => ({ version: app.getVersion() }));

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
  setLogWorkspace(workspace);
  logEvent("sys", { ev: "workspace-changed", workspace });
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

app.whenReady().then(createWindow);

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
