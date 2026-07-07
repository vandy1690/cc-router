// Safe bridge between the renderer and the main-process engines.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cc", {
  route: (prompt) => ipcRenderer.invoke("route", prompt),
  projects: () => ipcRenderer.invoke("projects"),
  usage: () => ipcRenderer.invoke("usage"),
  enableLive: () => ipcRenderer.invoke("usage:enableLive"),
  saveSync: (pcts) => ipcRenderer.invoke("saveSync", pcts),
  launch: (opts) => ipcRenderer.invoke("launch", opts),
  openFinder: (cwd) => ipcRenderer.invoke("openFinder", cwd),
  focusWindow: () => ipcRenderer.invoke("focusWindow"),
  pinsGet: () => ipcRenderer.invoke("pins:get"),
  pinsToggle: (cwd) => ipcRenderer.invoke("pins:toggle", cwd),
  prefsGet: () => ipcRenderer.invoke("prefs:get"),
  prefsSet: (cwd, model) => ipcRenderer.invoke("prefs:set", { cwd, model }),
  ptyStart: (opts) => ipcRenderer.invoke("pty:start", opts),
  ptyInput: (id, data) => ipcRenderer.send("pty:input", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send("pty:resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send("pty:kill", { id }),
  onPtyData: (cb) => ipcRenderer.on("pty:data", (_e, msg) => cb(msg)),
  onPtyExit: (cb) => ipcRenderer.on("pty:exit", (_e, msg) => cb(msg)),
});
