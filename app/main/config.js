"use strict";

// App config: the persisted window/model/workspace preferences that live outside
// any workspace (recent folders, chosen model). Pure I/O over one JSON file —
// no Electron window or engine state leaks in here.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { app } = require("electron");

const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

// The endpoint the engine falls back to when a workspace configures no base URL
// (mirrors DEFAULT_OPENAI_BASE_URL in engine/core/src/config/settings.ts — the
// app cannot import from the engine, which ships as a bundled child process).
// Any OpenAI-compatible server works; the wizard writes whichever one the user
// picks, so this value is only ever a fallback.
const DEFAULT_BASE_URL = "https://api.deepinfra.com/v1/openai";

// The env var name the app writes into a workspace .env and the engine reads
// back. The endpoint behind it is the user's choice, so the name is neutral.
const DEFAULT_API_KEY_ENV = "MAGENTRA_API_KEY";

// Names earlier builds wrote instead. The engine still reads them, and saving a
// connection rewrites them to DEFAULT_API_KEY_ENV, so an existing workspace
// keeps working with or without a re-save.
const LEGACY_API_KEY_ENV_VARS = ["DEEPINFRA_API_KEY"];

// The vision endpoint's key (mirrors VISION_API_KEY_ENV in
// engine/core/src/config/settings.ts). Its OWN variable, never the main one:
// the two endpoints are usually different services, and one name for two keys
// is how a key gets sent to the wrong host.
const VISION_API_KEY_ENV = "MAGENTRA_VISION_API_KEY";

// The renderer owns the theme choice (it lives in localStorage with the rest of
// the UI settings), but main needs the *name* one launch early: the window's
// pre-paint backgroundColor and the native titlebar overlay are both set before
// the renderer runs. Mirroring the name here is what stops a dark frame from
// flashing ahead of a light UI — the one frame the renderer cannot repaint.
// Order matches renderer/modules/state.js THEMES; the first entry is the default.
const THEMES = ["light", "workbench", "matrix"];
const DEFAULT_THEME = THEMES[0];

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

/**
 * The env var a connection's key is stored under, by provider. The single
 * mapping — the wizard, the .env writer, the reveal button and the saved-key
 * lookup all ask here, so none of them can pick the other provider's variable.
 */
function apiKeyEnvVarFor(provider) {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : DEFAULT_API_KEY_ENV;
}

/**
 * Write JSON with write-then-rename, so a crash or a SIGKILL mid-write can never
 * leave a truncated file behind. Every reader in the app treats a missing file as
 * "defaults", and a half-written one would instead read as "no connection
 * configured" — which is how a working workspace loses its endpoint.
 *
 * `mode` applies to the temporary file, so the renamed result carries it even
 * when the destination already existed (Node's writeFileSync mode is create-only).
 * Throws on failure; callers decide whether that is fatal.
 */
function writeJsonAtomic(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse rename-over-existing (EPERM/EEXIST); narrow the race to
    // a missing-file window every reader already treats as "absent".
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
  if (mode !== undefined) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      // best-effort — never fail a write over permissions polish (no-op on Windows)
    }
  }
}

/** A workspace's own settings file — the engine's project layer. */
function workspaceSettingsPath(workspace) {
  return path.join(workspace, ".magentra", "settings.json");
}

/** The engine's global settings file (~/.magentra/settings.json), the layer every
 *  workspace inherits from. */
function globalSettingsPath() {
  return path.join(os.homedir(), ".magentra", "settings.json");
}

/**
 * A workspace's saved settings as a plain object; `{}` when the file is missing,
 * unreadable, or not an object. Every caller used to inline this readFileSync +
 * JSON.parse + shape-check, and each copy had its own idea of what a malformed
 * file meant.
 */
function readWorkspaceSettings(workspace) {
  return readSettingsFile(workspace ? workspaceSettingsPath(workspace) : "");
}

/** The global settings layer as a plain object; `{}` when absent or malformed. */
function readGlobalSettings() {
  return readSettingsFile(globalSettingsPath());
}

/**
 * What the engine will actually see for this workspace: the global layer with
 * the project layer merged over it, exactly the precedence loadSettings applies.
 * Shallow by design — every key the app reasons about (provider, baseUrl,
 * apiKey, apiKeyEnv, model, contextWindow) is a scalar at the top level.
 */
function readEffectiveWorkspaceSettings(workspace) {
  return { ...readGlobalSettings(), ...readWorkspaceSettings(workspace) };
}

function readSettingsFile(file) {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // missing or unparseable — the engine's own defaults apply
  }
  return {};
}

/**
 * Read-modify-write a workspace's settings through one atomic write. `mutate`
 * receives the parsed settings and edits them in place.
 *
 * The engine writes this same file (/settings, set_model), so two processes have
 * it open: an atomic write keeps a reader from ever seeing a partial one. It
 * cannot prevent a lost update, and does not try — the last writer wins, which
 * is what a user changing a setting expects.
 *
 * Returns null on success, or an error message the caller can surface.
 */
function updateWorkspaceSettings(workspace, mutate) {
  if (!workspace) return "no workspace";
  try {
    const settings = readWorkspaceSettings(workspace);
    mutate(settings);
    writeJsonAtomic(workspaceSettingsPath(workspace), settings);
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

const MAX_RECENT_WORKSPACES = 10;

/** Every launch opens full screen — the full-screen workbench is the product's
 * default posture. Saved bounds still matter: they are what the window
 * restores to when the user leaves full screen during the session. */
function shouldStartFullScreen() {
  return true;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    const workspace = typeof parsed.workspace === "string" ? parsed.workspace : null;
    let recent = Array.isArray(parsed.recentWorkspaces)
      ? parsed.recentWorkspaces.filter((p) => typeof p === "string")
      : [];
    // Migrate a legacy single `workspace` into the recent list once. No
    // workspace is active until the user opens one from the start page.
    if (workspace && !recent.includes(workspace)) recent = [workspace, ...recent];
    // Window state: validated loosely here; createWindow re-clamps to a live
    // display before applying, so a stale multi-monitor layout can't hide the app.
    const win = parsed.window;
    const windowState =
      win && typeof win === "object" &&
      Number.isFinite(win.width) && Number.isFinite(win.height)
        ? {
            width: Math.max(700, Math.round(win.width)),
            height: Math.max(480, Math.round(win.height)),
            ...(Number.isFinite(win.x) && Number.isFinite(win.y)
              ? { x: Math.round(win.x), y: Math.round(win.y) }
              : {}),
            maximized: win.maximized === true,
          }
        : null;
    return {
      workspace: null,
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_MODEL,
      theme: THEMES.includes(parsed.theme) ? parsed.theme : DEFAULT_THEME,
      recentWorkspaces: recent.slice(0, MAX_RECENT_WORKSPACES),
      // Background update checking. On unless a user turned it off explicitly,
      // which is the shape every other optional key here uses.
      updateCheck: parsed.updateCheck !== false,
      ...(windowState ? { window: windowState } : {}),
    };
  } catch {
    return {
      workspace: null,
      model: DEFAULT_MODEL,
      theme: DEFAULT_THEME,
      recentWorkspaces: [],
      updateCheck: true,
    };
  }
}

/**
 * Move a workspace to the front of the recent list (deduped, capped), returning
 * the new config. Pure — this module holds no mutable state, so the live config
 * has exactly one owner (main.js) rather than two copies that can drift.
 */
function rememberWorkspace(config, workspace) {
  const rest = (config.recentWorkspaces || []).filter((p) => p !== workspace);
  return { ...config, recentWorkspaces: [workspace, ...rest].slice(0, MAX_RECENT_WORKSPACES) };
}

/** True for a local/LAN OpenAI-compatible endpoint (Ollama, LM Studio, a
 *  llama.cpp box on the home network, …), which needs no API key and deserves
 *  a longer connect budget than a hosted API.
 *
 *  MIRRORED in engine/core/src/config/providerFactory.ts, which decides the same
 *  question on the engine side (may this connection boot without a key?). The
 *  app cannot import from the engine — it ships as a bundled child process — so
 *  the two must be changed together; app/tests/connection.test.js and
 *  .claude/skills/bigboycoding/connection-check.mjs assert they agree.
 *  When they disagreed, the app accepted a keyless LAN endpoint and the engine
 *  then refused to start on it. */
function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "0.0.0.0" || host === "host.docker.internal") return true;
    if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
    const m = /^172\.(\d{1,3})\./.exec(host);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Cleans a user-entered base URL: trims, drops trailing slashes, and strips an
 * accidentally pasted endpoint path. People paste the URL their script calls —
 * "http://host:1234/v1/chat/completions" — into a field asking for the base;
 * without this, TEST probes ".../chat/completions/models" and fails.
 */
function normalizeBaseUrl(raw) {
  let url = String(raw ?? "").trim();
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  return url.replace(/\/+$/, "");
}

function writeConfig(config) {
  try {
    // Write-then-rename: a crash mid-write must never leave a truncated
    // config.json that readConfig() would silently reset to defaults.
    writeJsonAtomic(configPath(), config);
  } catch (err) {
    console.error("Failed to persist config:", err);
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_API_KEY_ENV,
  LEGACY_API_KEY_ENV_VARS,
  VISION_API_KEY_ENV,
  DEFAULT_THEME,
  THEMES,
  MAX_RECENT_WORKSPACES,
  configPath,
  readConfig,
  writeConfig,
  writeJsonAtomic,
  rememberWorkspace,
  isLocalBaseUrl,
  normalizeBaseUrl,
  apiKeyEnvVarFor,
  workspaceSettingsPath,
  globalSettingsPath,
  readWorkspaceSettings,
  readGlobalSettings,
  readEffectiveWorkspaceSettings,
  updateWorkspaceSettings,
  shouldStartFullScreen,
};
