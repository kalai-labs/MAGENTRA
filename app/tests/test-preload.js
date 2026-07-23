"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

const api = (name, ...args) => ipcRenderer.invoke("test:api", { name, args });

// Pin the theme as an explicit saved choice: first-launch theme follows the
// host OS (prefers-color-scheme), which would make these tests
// environment-dependent. A saved theme always wins over OS detection.
try {
  if (!localStorage.getItem("magentra-ui")) {
    localStorage.setItem("magentra-ui", JSON.stringify({ theme: "workbench" }));
  }
} catch {
  // storage unavailable — the suite will surface it as theme drift
}
const listen = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("magentra", {
  getConfig: () => api("getConfig"),
  chooseWorkspace: () => api("chooseWorkspace"),
  openWorkspace: (workspace) => api("openWorkspace", workspace),
  openWorkspaceFile: (relPath) => api("openWorkspaceFile", relPath),
  pickContextFiles: (opts) => api("pickContextFiles", opts),
  pickMissionDeliverable: (defaultRel) => api("pickMissionDeliverable", defaultRel),
  undoChanges: (relPath, diffs) => api("undoChanges", relPath, diffs),
  setModel: (model) => api("setModel", model),
  send: (frame) => ipcRenderer.send("test:frame", frame),
  setModes: (activeIds) => ipcRenderer.send("test:modes", activeIds),
  interrupt: () => ipcRenderer.send("test:interrupt"),
  restartEngine: () => ipcRenderer.send("test:restart"),
  respondPermission: (id, decision, message) =>
    ipcRenderer.send("test:permission", message ? { id, decision, message } : { id, decision }),
  addDoc: (agentId, filePath) => api("addDoc", agentId, filePath),
  createTeamTemplate: () => api("createTeamTemplate"),
  reloadTeam: () => ipcRenderer.send("test:reloadTeam"),
  removeAgent: (agentId) => api("removeAgent", agentId),
  editAgent: (agentId) => api("editAgent", agentId),
  pickDoc: (agentId) => api("pickDoc", agentId),
  writeEnv: (payload) => api("writeEnv", payload),
  testConnection: (payload) => api("testConnection", payload),
  detectLocalServers: () => api("detectLocalServers"),
  generateSkill: (payload) => api("generateSkill", payload),
  saveSkillExport: (payload) => api("saveSkillExport", payload),
  listProfiles: () => api("listProfiles"),
  saveProfile: (payload) => api("saveProfile", payload),
  deleteProfile: (id) => api("deleteProfile", id),
  applyProfile: (id) => api("applyProfile", id),
  getWebSearch: () => api("getWebSearch"),
  setWebSearch: (enabled) => api("setWebSearch", enabled),
  getAppInfo: () => api("getAppInfo"),
  openExternal: (url) => ipcRenderer.send("test:external", url),
  openLogs: () => api("openLogs"),
  connectionInfo: () => api("connectionInfo"),
  setTitleBarTheme: (theme) => ipcRenderer.send("test:titlebar", theme),
  // The real zoom, not a stub — the suite asserts the layout actually scales.
  setZoom: (factor) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch {
      // matches preload.js: a frame that cannot zoom stays at 1.0
    }
  },
  getZoom: () => {
    try {
      return webFrame.getZoomFactor();
    } catch {
      return 1;
    }
  },
  revealKey: () => api("revealKey"),
  getPathForFile: () => null,
  onEvent: (callback) => listen("test:engine-event", callback),
  onRestarted: (callback) => listen("test:restarted", callback),
  onSetupRequired: (callback) => listen("test:setup-required", callback),
  onRecentWorkspaces: (callback) => listen("test:recent", callback),
  // Concurrent workspace tabs — the suite drives the tab lifecycle directly.
  focusTab: (tabId) => ipcRenderer.send("test:tab-focus", tabId),
  closeTab: (tabId) => ipcRenderer.send("test:tab-close", tabId),
  onTabOpened: (callback) => listen("test:tab-opened", callback),
  onTabFocused: (callback) => listen("test:tab-focused", callback),
  onTabClosed: (callback) => listen("test:tab-closed", callback),
  onTabCap: (callback) => listen("test:tab-cap", callback),
});
