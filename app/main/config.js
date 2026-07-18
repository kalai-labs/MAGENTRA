"use strict";

// App config: the persisted window/model/workspace preferences that live outside
// any workspace (recent folders, chosen model). Pure I/O over one JSON file —
// no Electron window or engine state leaks in here.

const path = require("node:path");
const fs = require("node:fs");
const { app } = require("electron");

const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

const MAX_RECENT_WORKSPACES = 10;

/** Every launch opens maximized — the full-screen workbench is the product's
 * default posture. Saved bounds still matter: they are what the window
 * restores to when the user un-maximizes during the session. */
function shouldStartMaximized() {
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
      recentWorkspaces: recent.slice(0, MAX_RECENT_WORKSPACES),
      ...(windowState ? { window: windowState } : {}),
    };
  } catch {
    return { workspace: null, model: DEFAULT_MODEL, recentWorkspaces: [] };
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
 *  a longer connect budget than a hosted API. */
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
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must never leave a truncated
    // config.json that readConfig() would silently reset to defaults.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows can refuse rename-over-existing (EPERM); narrow the race to
      // a missing-file window readConfig() already treats as defaults.
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    console.error("Failed to persist config:", err);
  }
}

module.exports = {
  DEFAULT_MODEL,
  MAX_RECENT_WORKSPACES,
  configPath,
  readConfig,
  writeConfig,
  rememberWorkspace,
  isLocalBaseUrl,
  normalizeBaseUrl,
  shouldStartMaximized,
};
