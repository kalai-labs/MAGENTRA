"use strict";

// Global, named connection profiles — the reusable layer above per-workspace
// credentials. One JSON file in the user's home ~/.magentra, so a profile built
// once is offered in every workspace afterwards. Pure I/O over that file — no
// Electron window and no engine state, so the setup wizard and the tests can
// drive it directly.
//
// The API key lives IN this file (owner-only, 0600) rather than only in each
// workspace .env — that is the whole point of a profile: pick it and you are
// connected, no re-entry. It is the same protection the workspace .env already
// relies on, one directory up and shared across workspaces.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./config.js");

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
  // Owner-only (0600): this file holds API keys. The atomic writer handles the
  // rename dance and the chmod — one implementation, shared with config.json,
  // so the crash-safety of both can never drift apart.
  writeJsonAtomic(profilesPath(), list, 0o600);
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

/**
 * Delete a profile — and clear it from any profile that named it as its vision
 * model. A dangling pointer would otherwise survive here and fail much later,
 * at connect time, as "the chosen vision model is no longer saved" on a profile
 * the user never edited.
 */
function deleteProfile(id) {
  const list = readProfiles()
    .filter((p) => p.id !== id)
    .map((p) => (p.visionProfileId === id ? { ...p, visionProfileId: undefined } : p));
  writeProfiles(list);
  return list;
}

function findProfile(id) {
  return readProfiles().find((p) => p.id === id) || null;
}

/** The renderer never needs the raw key — only whether one is stored. Strip it
 * everywhere a profile crosses the IPC boundary toward the UI.
 *
 * `visionModel` is resolved here rather than in the renderer: the pointer is an
 * id, and every surface that shows a profile wants the model NAME behind it. */
function sanitizeProfile(p, all) {
  const vision = p.visionProfileId ? (all ?? readProfiles()).find((x) => x.id === p.visionProfileId) : null;
  return {
    id: p.id,
    name: p.name,
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
    model: typeof p.model === "string" ? p.model : "",
    provider: p.provider === "anthropic" ? "anthropic" : "openai-compat",
    contextWindow: p.contextWindow !== undefined && p.contextWindow !== null ? String(p.contextWindow) : "",
    allowInsecureTls: p.insecureTls === true,
    hasKey: typeof p.apiKey === "string" && p.apiKey.trim() !== "",
    // The vision model this profile connects alongside itself: the id it points
    // at, and the name/model of that profile for display. Empty when it names
    // none — then this connection simply cannot look at images.
    visionProfileId: vision ? vision.id : "",
    visionName: vision ? vision.name : "",
    visionModel: vision && typeof vision.model === "string" ? vision.model : "",
  };
}

/** Every profile, sanitized, with vision pointers resolved against one read of
 *  the store rather than one read per row. */
function sanitizeProfiles(list) {
  const all = list ?? readProfiles();
  return all.map((p) => sanitizeProfile(p, all));
}

module.exports = {
  profilesPath,
  readProfiles,
  upsertProfile,
  deleteProfile,
  findProfile,
  sanitizeProfiles,
};
