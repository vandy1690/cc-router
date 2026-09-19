// Electron main process. Owns the window, the global summon hotkey, and the IPC
// bridge to the engines (models, router, sessions, usage). Sessions run as real
// interactive `claude` processes in embedded terminals, on the chosen model.

const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const pty = require("node-pty");

const { route, ruleDecision } = require("./src/router");
const { catalogForRenderer, cmpVersion, EFFORTS, MIN_CLI } = require("./src/models");
const { allProjects } = require("./src/sessions");
const { computeUsage, saveSync, applyLive, fromLive } = require("./src/usage");
const { getLiveUsage } = require("./src/live-usage");
const { sessionEnv } = require("./src/env");

let win = null;

// --- PATH repair ---
//
// A Mac app started from the Dock or Finder gets a bare PATH, and so does any
// child it spawns. `claude` usually lives in ~/.local/bin, which most people add
// in ~/.zshrc. A login shell (`-l`) never reads ~/.zshrc; only an interactive
// one does. So the app used to find `claude` only when it was started from a
// Terminal that already had the right PATH, and failed everywhere else: the
// version check, every session, and the classifier.
//
// Ask an interactive login shell for the PATH you actually use, once, and adopt
// it. Startup files can print anything (compinit warnings, banners), so the
// value is fenced with markers. Well-known install locations are appended as a
// safety net in case the shell is slow or unusual. Everything that runs
// `claude` waits on pathReady.
const pathReady = new Promise((resolve) => {
  const MARK = "__CCR_PATH__";
  const shell = process.env.SHELL || "/bin/zsh";
  const done = (fromShell) => {
    const home = os.homedir();
    const fallbacks = [
      path.join(home, ".local", "bin"), // Claude Code's native installer
      path.join(home, ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    const all = [...fromShell, ...(process.env.PATH || "").split(":"), ...fallbacks].filter(Boolean);
    process.env.PATH = Array.from(new Set(all)).join(":");
    resolve();
  };
  try {
    execFile(
      shell,
      ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      { timeout: 6000, env: { ...process.env, TERM: process.env.TERM || "dumb" } },
      (_err, stdout) => {
        const m = String(stdout || "").match(new RegExp(MARK + "([\\s\\S]*?)" + MARK));
        done(m ? m[1].split(":") : []);
      }
    );
  } catch (_) {
    done([]);
  }
});

// Page grounds from the Steven Design Co. tokens (--bg), so the window paints
// the right colour before the stylesheet loads. Light is the shipped default.
const GROUND = { light: "#F0EEE9", dark: "#000000" };

// --- Global summon hotkey ---
//
// A global shortcut takes its key away from every other app, so the choice is
// about what it costs elsewhere. F6 is the default: macOS leaves it alone and in
// Cursor / VS Code it is only "focus next pane". Avoided on purpose: F11 (macOS
// Show Desktop), F12 (Go to Definition), F5 (run / refresh), F1 and F2 (help and
// rename nearly everywhere). Set "hotkey" in ~/.cc-router/ui.json to override;
// if a key cannot be registered the next candidate is tried. F19 only exists on
// extended keyboards, which is why it was replaced.
const HOTKEY_CANDIDATES = ["F6", "F7", "F8", "F9", "F10", "F4", "F3"];
let hotkey = null; // the key that actually registered, shown in the header

function registerHotkey() {
  const wanted = String(loadUi().hotkey || "").trim();
  const order = wanted ? [wanted, ...HOTKEY_CANDIDATES.filter((k) => k !== wanted)] : HOTKEY_CANDIDATES;
  for (const key of order) {
    try {
      if (globalShortcut.register(key, showWindow)) return key;
    } catch (_) {
      /* not a valid accelerator; try the next one */
    }
  }
  return null;
}

function createWindow() {
  const theme = loadUi().theme === "dark" ? "dark" : "light";
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: GROUND[theme],
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The preload reads these: the theme is set before first paint, and the
      // header shows whichever hotkey actually registered.
      additionalArguments: ["--cc-theme=" + theme, "--cc-hotkey=" + (hotkey || "")],
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
  // Run unpackaged, the Dock would show Electron's icon. build/icon.png is the
  // CC mark (Nickel Gothic, ink #2D3436 on paper #F0EEE9, the light theme);
  // build/icon.icns is the same art for a packaged build.
  const icon = path.join(__dirname, "build", "icon.png");
  if (process.platform === "darwin" && app.dock && fs.existsSync(icon)) app.dock.setIcon(icon);
  // Register first, so the window can show the key that worked.
  hotkey = registerHotkey();
  if (!hotkey) console.warn("Could not register a global summon hotkey.");
  createWindow();

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

ipcMain.handle("models", () => catalogForRenderer());
ipcMain.handle("cli:check", () => checkCli());
ipcMain.handle("ui:setTheme", (_e, theme) => setTheme(theme));
// The local rules alone: instant, free, no process spawned. The renderer asks
// this first so it can show an answer, or a "picking a model" state, at once.
ipcMain.handle("route:rules", (_e, prompt) => ruleDecision(String(prompt || "").trim()));

// The full route, which may run the classifier (several seconds). A newer
// request kills the older classifier call instead of letting it run to the end.
let routeAbort = null;
ipcMain.handle("route", async (_e, prompt) => {
  await pathReady; // the classifier runs `claude`
  if (routeAbort) routeAbort.abort();
  routeAbort = new AbortController();
  return route(prompt, { signal: routeAbort.signal });
});
ipcMain.handle("projects", () => allProjects({ limit: 12 }));
// Live first. The transcript scan (a week of JSONL) only runs when the live
// numbers are missing or incomplete, as the fallback estimate.
ipcMain.handle("usage", async () => {
  const live = await getLiveUsage();
  const whole = fromLive(live);
  if (whole) return whole;
  return applyLive(await computeUsage(), live);
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
ipcMain.handle("pty:start", async (_e, opts) => {
  await pathReady;
  return ptyStart(opts);
});
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

function launch({ prompt, model, cwd, sessionId, effort }) {
  const dir = cwd || os.homedir();
  const cmd = sessionId
    ? `claude --resume ${shQuote(sessionId)} --model ${shQuote(model)}`
    : `claude --model ${shQuote(model)}${effortFlag(effort)} ${shQuote(prompt || "")}`;
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
  const base = `claude --model ${shQuote(opts.model)}${effortFlag(opts.effort)}`;
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
      env: sessionEnv(), // no parent-session markers: see src/env.js
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

// --- Claude Code CLI preflight ---
//
// Sessions launch whatever `claude` the login shell finds, and that binary only
// updates itself when it runs. Leave the app alone for a few weeks and the CLI
// can predate the models in the catalog: it will pass the ID through, but knows
// nothing about the model. Ask the same login shell the sessions use.
// Set by checkCli. False until proven, so an unchecked CLI never gets the flag.
let cliEffort = false;

// " --effort high" when the CLI supports it and the value is one it accepts.
function effortFlag(effort) {
  return cliEffort && EFFORTS.includes(effort) ? ` --effort ${effort}` : "";
}

async function checkCli() {
  await pathReady;
  return new Promise((resolve) => {
    execFile(
      process.env.SHELL || "/bin/zsh",
      // --help also tells us whether this CLI takes --effort. An older one would
      // refuse to start on an unknown flag, so the app only passes it when listed.
      ["-l", "-c", "claude --version; claude --help 2>/dev/null | grep -q -- --effort && echo EFFORT"],
      { timeout: 15000 },
      (err, stdout) => {
        const m = String(stdout || "").match(/(\d+\.\d+\.\d+)/);
        if (err || !m) return resolve({ ok: false, found: false, version: null, min: MIN_CLI, effort: false });
        const version = m[1];
        cliEffort = /\bEFFORT\b/.test(stdout);
        resolve({ ok: cmpVersion(version, MIN_CLI) >= 0, found: true, version, min: MIN_CLI, effort: cliEffort });
      }
    );
  });
}

// UI preferences (theme) persist next to the sync anchors, in the main process,
// so the window can open on the right ground colour.
const UI_FILE = path.join(os.homedir(), ".cc-router", "ui.json");

function loadUi() {
  try {
    return JSON.parse(fs.readFileSync(UI_FILE, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function setTheme(theme) {
  const ui = loadUi();
  ui.theme = theme === "dark" ? "dark" : "light";
  try {
    fs.mkdirSync(path.dirname(UI_FILE), { recursive: true });
    fs.writeFileSync(UI_FILE, JSON.stringify(ui));
  } catch (_) {}
  if (win && !win.isDestroyed()) win.setBackgroundColor(GROUND[ui.theme]);
  return ui.theme;
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
