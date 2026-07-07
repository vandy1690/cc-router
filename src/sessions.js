// Reads Claude Code's own per-project conversation history so the app can list
// and reopen previous chats. We do not store anything ourselves — this is a
// read-only view over ~/.claude/projects, and reopening just runs
// `claude --resume <id>` in the project's directory.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// How many lines to scan per session file when hunting for cwd + a title.
// Titles live near the top; no need to read multi-MB transcripts fully.
const SCAN_LINES = 400;

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(PROJECTS_DIR, d.name));
}

function sessionFiles(projectDir) {
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = path.join(projectDir, f);
      return { id: f.replace(/\.jsonl$/, ""), file: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // most recent first
}

// Scan the head of a transcript for cwd, title, and model. Claude Code writes
// its own AI-generated `ai-title` entries — the best source — so we prefer the
// latest one seen, falling back to the first genuine user message. The model
// comes from the latest assistant message in the window.
function readSessionMeta(file) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    let n = 0;
    let cwd = null;
    let aiTitle = null;
    let userTitle = null;
    let model = null;
    rl.on("line", (line) => {
      n++;
      if (n > SCAN_LINES) {
        rl.close();
        return;
      }
      try {
        const o = JSON.parse(line);
        if (!cwd && o.cwd) cwd = o.cwd;
        if (o.type === "ai-title" && o.aiTitle) aiTitle = o.aiTitle;
        if (o.type === "assistant" && o.message && o.message.model) model = o.message.model;
        if (!userTitle && o.type === "user" && o.message) {
          const c = o.message.content;
          let txt =
            typeof c === "string"
              ? c
              : Array.isArray(c)
              ? c.map((p) => p.text || "").join(" ")
              : "";
          txt = txt.trim();
          if (isRealTitle(txt)) userTitle = txt.slice(0, 100);
        }
      } catch (_) {
        /* skip malformed lines */
      }
    });
    rl.on("close", () => resolve({ cwd, title: aiTitle || userTitle, model }));
    rl.on("error", () => resolve({ cwd: null, title: null, model: null }));
  });
}

function isRealTitle(txt) {
  if (!txt) return false;
  if (txt.startsWith("<")) return false; // system-reminder / tool wrappers
  if (txt.startsWith("You are a routing classifier")) return false; // our own calls
  if (txt.startsWith("Caveat:")) return false;
  return true;
}

// Full picture for one project: its real path and recent chats with titles.
async function projectSummary(projectDir, { limit = 25 } = {}) {
  const files = sessionFiles(projectDir).slice(0, limit);
  let cwd = null;
  const chats = [];
  for (const s of files) {
    const meta = await readSessionMeta(s.file);
    if (!cwd && meta.cwd) cwd = meta.cwd;
    chats.push({
      id: s.id,
      title: meta.title || "(untitled chat)",
      updated: new Date(s.mtime).toISOString(),
      updatedMs: s.mtime,
      model: meta.model || null,
    });
  }
  return {
    dir: projectDir,
    cwd: cwd || decodeDirName(path.basename(projectDir)),
    name: cwd ? path.basename(cwd) : path.basename(projectDir),
    chats,
  };
}

// Fallback only. The encoded dir name replaces "/" with "-", which is lossy for
// folders that contain hyphens — so we prefer the cwd read from the transcript.
function decodeDirName(name) {
  return name.replace(/^-/, "/").replace(/-/g, "/");
}

async function allProjects({ limit = 25 } = {}) {
  const dirs = listProjects();
  const out = [];
  for (const d of dirs) {
    try {
      out.push(await projectSummary(d, { limit }));
    } catch (_) {
      /* skip unreadable project dirs */
    }
  }
  // Most recently touched project first.
  out.sort((a, b) => (b.chats[0]?.updatedMs || 0) - (a.chats[0]?.updatedMs || 0));
  return out;
}

// The command to reopen a past chat, optionally forcing a model. Runs in the
// project's cwd so Claude Code resolves the right session history.
function resumeCommand(cwd, sessionId, modelId) {
  const args = ["--resume", sessionId];
  if (modelId) args.push("--model", modelId);
  return { cmd: "claude", args, cwd };
}

module.exports = {
  PROJECTS_DIR,
  listProjects,
  sessionFiles,
  readSessionMeta,
  projectSummary,
  allProjects,
  resumeCommand,
};
