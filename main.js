// Electron main process. Owns the window, the F19 global hotkey, and the IPC
// bridge to the three engines (router, sessions, usage). The handoff opens
// Terminal running an interactive Claude Code session on the chosen model.

const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const pty = require("node-pty");

const { route } = require("./src/router");
const { allProjects } = require("./src/sessions");
const { computeUsage, saveSync, applyLive } = require("./src/usage");
const { getLiveUsage } = require("./src/live-usage");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#F0EEE9",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => {
    ptyKillAll();
    win = null;
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.whenReady().then(() => {
  createWindow();

  // F19 summons/focuses the window from anywhere.
  const ok = globalShortcut.register("F19", showWindow);
  if (!ok) console.warn("Could not register F19 global hotkey.");

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  ptyKillAll();
});

// Keep the app alive when the window closes so the hotkey still works (mac norm).
app.on("window-all-closed", () => {
  /* stay resident; quit via Cmd+Q */
});

// --- IPC: engines ---

ipcMain.handle("route", (_e, prompt) => route(prompt));
ipcMain.handle("projects", () => allProjects({ limit: 12 }));
ipcMain.handle("usage", async () => {
  const base = await computeUsage();
  const live = await getLiveUsage();
  return applyLive(base, live);
});
// Force a fresh keychain read (re-triggers the macOS permission prompt).
ipcMain.handle("usage:enableLive", async () => {
  const live = await getLiveUsage(0);
  return { ok: live.ok, reason: live.reason };
});
ipcMain.handle("saveSync", (_e, pcts) => saveSync(pcts));
ipcMain.handle("launch", (_e, opts) => launch(opts));
ipcMain.handle("openFinder", (_e, cwd) => openFinder(cwd));
ipcMain.handle("focusWindow", () => showWindow());
ipcMain.handle("pins:get", () => loadPins());
ipcMain.handle("pins:toggle", (_e, cwd) => togglePin(cwd));
ipcMain.handle("prefs:get", () => loadPrefs());
ipcMain.handle("prefs:set", (_e, { cwd, model }) => setPref(cwd, model));

// --- Embedded Claude Code: multiple PTYs (one per session tab), keyed by id ---
ipcMain.handle("pty:start", (_e, opts) => ptyStart(opts));
ipcMain.on("pty:input", (_e, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});
ipcMain.on("pty:resize", (_e, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.resize(cols, rows);
    } catch (_) {}
  }
});
ipcMain.on("pty:kill", (_e, { id }) => ptyKill(id));

// --- Handoff: open Terminal on the chosen model ---
//
// We write a temp .command file and `open` it with Terminal. This needs no
// Automation/Apple-Events permission (unlike osascript), and the `#!/bin/zsh -l`
// login shell loads the user's profile so `claude` is on PATH.

function launch({ prompt, model, cwd, sessionId }) {
  const dir = cwd || os.homedir();
  const cmd = sessionId
    ? `claude --resume ${shQuote(sessionId)} --model ${shQuote(model)}`
    : `claude --model ${shQuote(model)} ${shQuote(prompt || "")}`;
  const body = `#!/bin/zsh -l\ncd ${shQuote(dir)} || exit 1\nexec ${cmd}\n`;
  const file = path.join(os.tmpdir(), `cc-router-${Date.now()}.command`);
  return new Promise((resolve, reject) => {
    try {
      fs.writeFileSync(file, body, { mode: 0o755 });
    } catch (e) {
      return reject(new Error("could not write launch script: " + e.message));
    }
    execFile("open", ["-a", "Terminal", file], (err) =>
      err ? reject(new Error(err.message)) : resolve({ ok: true })
    );
  });
}

// Each session tab is a login shell that execs `claude` (login shell => PATH has
// claude). Output/exit events carry the session id so the renderer routes them.
const ptys = new Map();
let ptySeq = 0;

function ptyStart(opts) {
  const id = "s" + ++ptySeq;
  const dir = opts.cwd || os.homedir();
  const base = `claude --model ${shQuote(opts.model)}`;
  const inner = opts.sessionId
    ? `claude --resume ${shQuote(opts.sessionId)} --model ${shQuote(opts.model)}`
    : opts.prompt
    ? `${base} ${shQuote(opts.prompt)}`
    : base;
  const full = `cd ${shQuote(dir)} && exec ${inner}`;
  let p;
  try {
    p = pty.spawn(process.env.SHELL || "/bin/zsh", ["-l", "-c", full], {
      name: "xterm-256color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: dir,
      env: process.env,
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  ptys.set(id, p);
  p.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send("pty:data", { id, data });
  });
  p.onExit(() => {
    if (win && !win.isDestroyed()) win.webContents.send("pty:exit", { id });
    ptys.delete(id);
  });
  return { ok: true, id };
}

function ptyKill(id) {
  const p = ptys.get(id);
  if (p) {
    try {
      p.kill();
    } catch (_) {}
    ptys.delete(id);
  }
}

function ptyKillAll() {
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch (_) {}
  }
  ptys.clear();
}

// Pinned projects (cwd paths) persist next to the sync anchors.
const PINS_FILE = path.join(os.homedir(), ".cc-router", "pins.json");

function loadPins() {
  try {
    return JSON.parse(fs.readFileSync(PINS_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function togglePin(cwd) {
  const a = loadPins();
  const i = a.indexOf(cwd);
  if (i >= 0) a.splice(i, 1);
  else a.push(cwd);
  try {
    fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
    fs.writeFileSync(PINS_FILE, JSON.stringify(a));
  } catch (_) {}
  return a;
}

// Per-project default model (modelKey), learned from your overrides.
const PREFS_FILE = path.join(os.homedir(), ".cc-router", "prefs.json");

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function setPref(cwd, model) {
  const p = loadPrefs();
  if (!cwd) return p;
  if (model) p[cwd] = model;
  else delete p[cwd];
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(p));
  } catch (_) {}
  return p;
}

// Reveal a directory in Finder.
function openFinder(cwd) {
  return new Promise((resolve, reject) => {
    execFile("open", [cwd], (err) =>
      err ? reject(new Error(err.message)) : resolve({ ok: true })
    );
  });
}

// Single-quote for the shell; close/escape/reopen any embedded single quote.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
