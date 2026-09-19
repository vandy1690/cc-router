// Shared by the hook scripts: where per-session state lives and how to read it.
//
// A prompt hook is not told which model the session is on. SessionStart can
// carry `model`, and PostModelSwitch carries `to_model`, so track-model.js
// writes the latest value here and nudge.js reads it back.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Claude Code passes ${CLAUDE_PLUGIN_DATA} on the command line (argv[2]). The
// env var and the ~/.cc-router fallback cover running the scripts by hand.
function dataDir() {
  const fromArg = process.argv[2] && !process.argv[2].startsWith("${") ? process.argv[2] : null;
  return fromArg || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".cc-router", "plugin");
}

function sessionFile(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(dataDir(), "sessions", safe + ".json");
}

function readSession(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function writeSession(sessionId, state) {
  const file = sessionFile(sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (_) {
    /* best effort: a hook must never break the session */
  }
}

// Drop state for sessions untouched for two weeks.
function prune(maxAgeMs = 14 * 24 * 3600 * 1000) {
  const dir = path.join(dataDir(), "sessions");
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full);
    }
  } catch (_) {}
}

// Read all of stdin as JSON. Hooks receive their input this way.
function readInput() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (_) {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

module.exports = { dataDir, readSession, writeSession, prune, readInput };
