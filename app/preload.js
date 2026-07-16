"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("magentra", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openWorkspace: (workspace) => ipcRenderer.invoke("workspace:open", workspace),
  setModel: (model) => ipcRenderer.invoke("config:setModel", model),
  send: (frame) => ipcRenderer.send("engine:send", frame),
  setModes: (activeIds) => ipcRenderer.send("engine:setModes", activeIds),
  interrupt: () => ipcRenderer.send("engine:interrupt"),
  restartEngine: () => ipcRenderer.send("engine:restart"),
  respondPermission: (id, decision) => ipcRenderer.send("engine:permission", { id, decision }),
  addDoc: (agentId, filePath) => ipcRenderer.invoke("team:addDoc", { agentId, filePath }),
  createTeamTemplate: () => ipcRenderer.invoke("team:createTemplate"),
  reloadTeam: () => ipcRenderer.send("team:reload"),
  removeAgent: (agentId) => ipcRenderer.invoke("team:removeAgent", agentId),
  editAgent: (agentId) => ipcRenderer.invoke("team:editAgent", agentId),
  pickDoc: (agentId) => ipcRenderer.invoke("team:pickDoc", agentId),
  writeEnv: (payload) => ipcRenderer.invoke("setup:writeEnv", payload),
  testConnection: (payload) => ipcRenderer.invoke("setup:testConnection", payload),
  getWebSearch: () => ipcRenderer.invoke("settings:getWebSearch"),
  setWebSearch: (enabled) => ipcRenderer.invoke("settings:setWebSearch", enabled),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
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
