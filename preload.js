// Safe bridge between the renderer and the main-process engines.
const { contextBridge, ipcRenderer } = require("electron");

// The main process passes the saved theme on the command line so it is known
// synchronously, before first paint. Light is the shipped default.
const themeArg = process.argv.find((a) => a.startsWith("--cc-theme="));
const initialTheme = themeArg && themeArg.split("=")[1] === "dark" ? "dark" : "light";
const hotkeyArg = process.argv.find((a) => a.startsWith("--cc-hotkey="));
const hotkey = hotkeyArg ? hotkeyArg.split("=")[1] || null : null;

contextBridge.exposeInMainWorld("cc", {
  initialTheme,
  hotkey, // the global summon key that registered, or null
  setTheme: (theme) => ipcRenderer.invoke("ui:setTheme", theme),
  models: () => ipcRenderer.invoke("models"),
  checkCli: () => ipcRenderer.invoke("cli:check"),
  routeRules: (prompt) => ipcRenderer.invoke("route:rules", prompt),
  route: (prompt) => ipcRenderer.invoke("route", prompt),
  projects: () => ipcRenderer.invoke("projects"),
  usage: () => ipcRenderer.invoke("usage"),
  enableLive: () => ipcRenderer.invoke("usage:enableLive"),
  saveSync: (pcts) => ipcRenderer.invoke("saveSync", pcts),
  openFinder: (cwd) => ipcRenderer.invoke("openFinder", cwd),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  focusWindow: () => ipcRenderer.invoke("focusWindow"),
  pinsGet: () => ipcRenderer.invoke("pins:get"),
  pinsToggle: (cwd) => ipcRenderer.invoke("pins:toggle", cwd),
  prefsGet: () => ipcRenderer.invoke("prefs:get"),
  prefsSet: (cwd, model) => ipcRenderer.invoke("prefs:set", { cwd, model }),
  prefsClear: () => ipcRenderer.invoke("prefs:clear"),
  diagnostics: () => ipcRenderer.invoke("diagnostics:run"),
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSet: (patch) => ipcRenderer.invoke("settings:set", patch),
  pickFolder: () => ipcRenderer.invoke("settings:pickFolder"),
  folderAdd: () => ipcRenderer.invoke("folders:add"),
  folderRemove: (dir) => ipcRenderer.invoke("folders:remove", dir),
  onOpenSettings: (cb) => ipcRenderer.on("menu:settings", () => cb()),
  ptyStart: (opts) => ipcRenderer.invoke("pty:start", opts),
  ptyInput: (id, data) => ipcRenderer.send("pty:input", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send("pty:resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send("pty:kill", { id }),
  onPtyData: (cb) => ipcRenderer.on("pty:data", (_e, msg) => cb(msg)),
  onPtyExit: (cb) => ipcRenderer.on("pty:exit", (_e, msg) => cb(msg)),
});
