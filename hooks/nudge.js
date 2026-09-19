#!/usr/bin/env node
// UserPromptSubmit hook: tell you when a prompt is clearly over- or
// under-powered for the model the session is on.
//
// What it can and cannot do. A hook cannot change a session's model; nothing a
// plugin ships can. So this is advice, shown to you as a one-line message, and
// the prompt carries on untouched. Acting on it is one command: resend the
// prompt through a tier skill (/cc-router:quick and friends pin a model for
// that one turn), or switch with /model.
//
// It is built to stay quiet:
//   - local rules only, the same engine the desktop app uses. No classifier
//     call, no network, no tokens, a few milliseconds.
//   - silent whenever the rules are unsure, the session's model is unknown, or
//     the tier already fits.
//   - going down, it only speaks up from Opus or Fable, where the saving is real.
//   - at most three nudges in each direction per session.
//
// A hook that fails must never get in the session's way: every path exits 0,
// and nothing is printed unless there is a nudge.

const fs = require("fs");
const path = require("path");
const { readInput, readSession, writeSession } = require("./state");
const { ruleDecision } = require(path.join(__dirname, "..", "src", "router"));
const { MODELS, keyForId } = require(path.join(__dirname, "..", "src", "models"));

const MAX_PER_DIRECTION = 3;
const SKILL = { haiku: "quick", sonnet: "build", opus: "deep", fable: "max" };
const WHY = {
  light: "a small, mechanical edit",
  hard: "hard reasoning",
  files: "a change across several files",
  heavy: "a whole-codebase change",
};

// Fallback when no model was recorded for this session: the last assistant
// message in the transcript names the model that wrote it. Reads only the tail.
function modelFromTranscript(file) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const hits = buf.toString("utf8").match(/"model":"(claude-[a-z0-9.-]+)"/g);
    if (!hits || !hits.length) return null;
    return hits[hits.length - 1].slice(9, -1);
  } catch (_) {
    return null;
  }
}

function nudgeFor(input) {
  if (input.agent_id) return null; // inside a subagent: not your prompt
  const prompt = String(input.prompt || "").trim();
  if (prompt.length < 12) return null;
  if (/^[/!#]/.test(prompt)) return null; // slash commands (including ours), bash mode, memory notes

  const want = ruleDecision(prompt);
  if (!want) return null; // the rules are unsure: say nothing

  const state = readSession(input.session_id);
  const curId = state.model || modelFromTranscript(input.transcript_path);
  const curKey = keyForId(curId);
  if (!curKey) return null;

  const cur = MODELS[curKey];
  const to = MODELS[want.modelKey];
  if (to.tier === cur.tier) return null;

  const down = to.tier < cur.tier;
  if (down && cur.tier < 3) return null; // Sonnet -> Haiku saves too little to interrupt for

  const dir = down ? "down" : "up";
  const counts = state.nudges || { down: 0, up: 0 };
  if ((counts[dir] || 0) >= MAX_PER_DIRECTION) return null;
  counts[dir] = (counts[dir] || 0) + 1;
  writeSession(input.session_id, { ...state, nudges: counts });

  const why = WHY[want.kind] || "a different size of task";
  const skill = `/cc-router:${SKILL[want.modelKey]}`;
  const lead = down
    ? `cc-router: this reads as ${why}, which ${to.label} ${to.cost} handles well. You are on ${cur.label} ${cur.cost}.`
    : `cc-router: this reads as ${why}, which is ${to.label} ${to.cost} territory. You are on ${cur.label} ${cur.cost}.`;
  return `${lead} To run one prompt on ${to.label}, send it as ${skill} <prompt>. To switch the session, use /model ${want.modelKey}.`;
}

if (require.main === module) {
  (async () => {
    const input = await readInput();
    const message = nudgeFor(input);
    if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
  })().catch(() => {}).finally(() => process.exit(0));
}

module.exports = { nudgeFor };
