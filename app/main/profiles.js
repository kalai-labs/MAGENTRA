"use strict";

// Global, named connection profiles — the reusable layer above per-workspace
// credentials. One JSON file in the user's home ~/.magentra, so a profile built
// once is offered in every workspace afterwards. Pure I/O, no Electron or engine
// state, so the setup wizard and the tests can drive it directly.
//
// The API key lives IN this file (owner-only, 0600) rather than only in each
// workspace .env — that is the whole point of a profile: pick it and you are
// connected, no re-entry. It is the same protection the workspace .env already
// relies on, one directory up and shared across workspaces.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

function profilesDir() {
  return path.join(os.homedir(), ".magentra");
}

function profilesPath() {
  return path.join(profilesDir(), "profiles.json");
}

/** One stored profile is a connection payload (wizard vocabulary:
 * provider "openai-compat" | "anthropic") plus an id and a display name. */
function isProfileShape(p) {
  return p && typeof p === "object" && !Array.isArray(p) && typeof p.id === "string" && typeof p.name === "string";
}

/** All saved profiles, newest-first as written. A missing or corrupt file reads
 * as an empty list rather than throwing — a hand-mangled profiles.json must not
 * brick the wizard. */
function readProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(profilesPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProfileShape);
  } catch {
    return [];
  }
}

function writeProfiles(list) {
  const dir = profilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = profilesPath();
  const tmp = `${file}.tmp`;
  // Owner-only: the file holds API keys. mode applies on create; the explicit
  // chmod fixes up a pre-existing looser file too (no-op on Windows).
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse rename-over-existing; narrow the race to a missing
    // window that readProfiles() already treats as an empty list.
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort — never fail the write over permissions polish
  }
  return list;
}

/** Insert or replace a profile by id, keeping the rest in place. A profile with
 * no id (or an unknown one) is treated as new and lands at the front. Returns
 * the full list. */
function upsertProfile(profile) {
  const list = readProfiles();
  const id = typeof profile.id === "string" && profile.id ? profile.id : crypto.randomUUID();
  const record = { ...profile, id };
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  writeProfiles(list);
  return { list, id };
}

function deleteProfile(id) {
  const list = readProfiles().filter((p) => p.id !== id);
  writeProfiles(list);
  return list;
}

function findProfile(id) {
  return readProfiles().find((p) => p.id === id) || null;
}

/** The renderer never needs the raw key — only whether one is stored. Strip it
 * everywhere a profile crosses the IPC boundary toward the UI. */
function sanitizeProfile(p) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
    model: typeof p.model === "string" ? p.model : "",
    provider: p.provider === "anthropic" ? "anthropic" : "openai-compat",
    contextWindow: p.contextWindow !== undefined && p.contextWindow !== null ? String(p.contextWindow) : "",
    allowInsecureTls: p.insecureTls === true,
    hasKey: typeof p.apiKey === "string" && p.apiKey.trim() !== "",
  };
}

module.exports = {
  profilesPath,
  readProfiles,
  upsertProfile,
  deleteProfile,
  findProfile,
  sanitizeProfile,
};
