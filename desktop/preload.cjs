// Minimal, explicit bridge: the page can read desktop facts and request a pinned tool install. Nothing else.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("paiDesktop", {
  info: () => ipcRenderer.invoke("pai:desktop"),
  installTool: kind => ipcRenderer.invoke("pai:install-tool", kind),
});
