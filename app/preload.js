"use strict";

const { contextBridge, ipcRenderer, webUtils, webFrame } = require("electron");

contextBridge.exposeInMainWorld("magentra", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openWorkspace: (workspace) => ipcRenderer.invoke("workspace:open", workspace),
  openWorkspaceFile: (relPath) => ipcRenderer.invoke("workspace:openFile", relPath),
  undoChanges: (relPath, diffs) => ipcRenderer.invoke("changes:undo", { relPath, diffs }),
  setModel: (model) => ipcRenderer.invoke("config:setModel", model),
  send: (frame) => ipcRenderer.send("engine:send", frame),
  setModes: (activeIds) => ipcRenderer.send("engine:setModes", activeIds),
  interrupt: () => ipcRenderer.send("engine:interrupt"),
  restartEngine: () => ipcRenderer.send("engine:restart"),
  respondPermission: (id, decision, message) =>
    ipcRenderer.send("engine:permission", message ? { id, decision, message } : { id, decision }),
  addDoc: (agentId, filePath) => ipcRenderer.invoke("team:addDoc", { agentId, filePath }),
  createTeamTemplate: () => ipcRenderer.invoke("team:createTemplate"),
  reloadTeam: () => ipcRenderer.send("team:reload"),
  removeAgent: (agentId) => ipcRenderer.invoke("team:removeAgent", agentId),
  editAgent: (agentId) => ipcRenderer.invoke("team:editAgent", agentId),
  pickDoc: (agentId) => ipcRenderer.invoke("team:pickDoc", agentId),
  writeEnv: (payload) => ipcRenderer.invoke("setup:writeEnv", payload),
  testConnection: (payload) => ipcRenderer.invoke("setup:testConnection", payload),
  // Which local model servers (Ollama, LM Studio) are present on this machine.
  detectLocalServers: () => ipcRenderer.invoke("connections:detectLocal"),
  // Global connection profiles (reusable across workspaces).
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (payload) => ipcRenderer.invoke("profiles:save", payload),
  deleteProfile: (id) => ipcRenderer.invoke("profiles:delete", id),
  applyProfile: (id) => ipcRenderer.invoke("profiles:apply", { id }),
  getWebSearch: () => ipcRenderer.invoke("settings:getWebSearch"),
  setWebSearch: (enabled) => ipcRenderer.invoke("settings:setWebSearch", enabled),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  openExternal: (url) => ipcRenderer.send("app:openExternal", url),
  openLogs: () => ipcRenderer.invoke("app:openLogs"),
  connectionInfo: () => ipcRenderer.invoke("connection:info"),
  setTitleBarTheme: (theme) => ipcRenderer.send("app:titleBarTheme", theme),
  // Whole-interface scale. Page zoom rather than a font-size multiplier: the
  // layout tokens (--sidebar-w, --topbar-h, radii, borders) are hard pixels,
  // so only zoom moves the chrome along with the text.
  setZoom: (factor) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch {
      // A frame that cannot zoom just stays at 1.0 — never fatal.
    }
  },
  getZoom: () => {
    try {
      return webFrame.getZoomFactor();
    } catch {
      return 1;
    }
  },
  revealKey: () => ipcRenderer.invoke("connection:revealKey"),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  onEvent: (cb) => {
    const listener = (_evt, event) => cb(event);
    ipcRenderer.on("engine:event", listener);
    return () => ipcRenderer.removeListener("engine:event", listener);
  },
  onRestarted: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("engine:restarted", listener);
    return () => ipcRenderer.removeListener("engine:restarted", listener);
  },
  onSetupRequired: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("setup:required", listener);
    return () => ipcRenderer.removeListener("setup:required", listener);
  },
  onRecentWorkspaces: (cb) => {
    const listener = (_evt, list) => cb(list);
    ipcRenderer.on("workspace:recent", listener);
    return () => ipcRenderer.removeListener("workspace:recent", listener);
  },
});
