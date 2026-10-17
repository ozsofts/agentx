const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  restoreWorkspace: () => ipcRenderer.invoke("workspace:restore"),
  getDesktopSettings: () => ipcRenderer.invoke("desktop-settings:read"),
  saveDesktopSettings: (patch) => ipcRenderer.invoke("desktop-settings:write", patch),
  listTools: () => ipcRenderer.invoke("tools:list"),
  chooseAttachments: (options) => ipcRenderer.invoke("attachments:choose", options),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  chooseProjectFolder: () => ipcRenderer.invoke("projects:choose-folder"),
  openProjectFolder: () => ipcRenderer.invoke("projects:open-folder"),
  projectCommand: (command) => ipcRenderer.invoke("projects:command", command),
  chooseSkillFolder: () => ipcRenderer.invoke("skills:choose-folder"),
  command: (command) => ipcRenderer.invoke("agent:command", command),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
});
