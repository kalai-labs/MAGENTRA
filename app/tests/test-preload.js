"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const api = (name, ...args) => ipcRenderer.invoke("test:api", { name, args });
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
  undoChanges: (relPath, diffs) => api("undoChanges", relPath, diffs),
  setModel: (model) => api("setModel", model),
  send: (frame) => ipcRenderer.send("test:frame", frame),
  setModes: (activeIds) => ipcRenderer.send("test:modes", activeIds),
  interrupt: () => ipcRenderer.send("test:interrupt"),
  restartEngine: () => ipcRenderer.send("test:restart"),
  respondPermission: (id, decision) => ipcRenderer.send("test:permission", { id, decision }),
  addDoc: (agentId, filePath) => api("addDoc", agentId, filePath),
  createTeamTemplate: () => api("createTeamTemplate"),
  reloadTeam: () => ipcRenderer.send("test:reloadTeam"),
  removeAgent: (agentId) => api("removeAgent", agentId),
  editAgent: (agentId) => api("editAgent", agentId),
  pickDoc: (agentId) => api("pickDoc", agentId),
  writeEnv: (payload) => api("writeEnv", payload),
  testConnection: (payload) => api("testConnection", payload),
  getWebSearch: () => api("getWebSearch"),
  setWebSearch: (enabled) => api("setWebSearch", enabled),
  getAppInfo: () => api("getAppInfo"),
  openExternal: (url) => ipcRenderer.send("test:external", url),
  openLogs: () => api("openLogs"),
  connectionInfo: () => api("connectionInfo"),
  setTitleBarTheme: (theme) => ipcRenderer.send("test:titlebar", theme),
  revealKey: () => api("revealKey"),
  getPathForFile: () => null,
  onEvent: (callback) => listen("test:engine-event", callback),
  onRestarted: (callback) => listen("test:restarted", callback),
  onSetupRequired: (callback) => listen("test:setup-required", callback),
  onRecentWorkspaces: (callback) => listen("test:recent", callback),
});
