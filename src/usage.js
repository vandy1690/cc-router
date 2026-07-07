// Usage meter. Reads real token spend from Claude Code transcripts and weights
// it by each model's price, so the numbers track your plan the way the plan
// itself does (Fable counts heavily, Haiku barely). Mirrors the three buckets
// the Max plan shows: a rolling 5-hour session, weekly all-models, weekly Fable.
//
// Honest caveat: this is a close proxy, not Anthropic's exact %. The ceilings
// below are yours to calibrate against what the desktop Usage panel shows.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { listProjects } = require("./sessions");
const { byId, MODELS } = require("./models");

// Manual-sync anchors persist here. Each anchor pins a bucket to the official %
// you read off the desktop Usage panel, plus the local Claude Code spend at that
// moment — so between syncs the meter shows official% + your Claude Code deltas.
const CONFIG_DIR = path.join(os.homedir(), ".cc-router");
const SYNC_FILE = path.join(CONFIG_DIR, "sync.json");

function loadSync() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function writeSync(obj) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SYNC_FILE, JSON.stringify(obj, null, 2));
  } catch (_) {
    /* best effort */
  }
}

// --- Ceilings you calibrate to match your plan (USD of weighted spend) ---
// Watch the desktop Usage panel for a week and nudge these so the app's % lines
// up with Anthropic's. Defaults are rough Max (5x) starting points.
// Calibrated to Steve's Max (5x) baseline on 2026-07-06: at $26.89 weighted
// Claude Code spend the official panel read 23% weekly all-models, so ceiling
// ≈ $117. Note: these measure CLAUDE CODE usage only — Fable spent in the
// Claude apps (Cowork/Chat) is invisible here, so weeklyFable will read low.
const CEILINGS = {
  session5h: 200, // rolling 5-hour session bucket (approximate — see note above)
  weeklyAll: 117, // weekly all-models bucket (calibrated)
  weeklyFable: 60, // weekly Fable-only bucket (Claude Code Fable only)
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Weighted cost of one assistant message, in USD. Cache reads are ~0.1x input
// price; cache writes ~1.25x. Matches how spend actually accrues.
function messageCost(model, usage) {
  const m = byId(model);
  if (!m || !usage) return 0;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const weightedInput = input + cacheRead * 0.1 + cacheWrite * 1.25;
  return (weightedInput * m.priceIn + output * m.priceOut) / 1_000_000;
}

// Most recent Saturday 12:00 local time at or before `now`.
function lastWeeklyReset(now) {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  // getDay(): Sat = 6. Step back to the most recent Saturday noon.
  let back = (d.getDay() - 6 + 7) % 7;
  if (back === 0 && d.getTime() > now) back = 7; // it's Sat before noon
  d.setTime(d.getTime() - back * DAY);
  if (d.getTime() > now) d.setTime(d.getTime() - 7 * DAY);
  return d.getTime();
}

// Walk every transcript once, summing weighted Claude Code cost per bucket.
async function computeLocal(now = Date.now()) {
  const weekStart = lastWeeklyReset(now);
  const sessionStart = now - 5 * HOUR;
  const scanFrom = Math.min(weekStart, sessionStart);

  const buckets = { session5h: 0, weeklyAll: 0, weeklyFable: 0 };

  for (const projectDir of listProjects()) {
    let files;
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      const full = path.join(projectDir, f);
      // Skip transcripts untouched since the earliest window start.
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (_) {
        continue;
      }
      if (mtime < scanFrom) continue;
      await accumulateFile(full, now, weekStart, sessionStart, buckets);
    }
  }

  return { buckets, weekStart, sessionStart };
}

// Public: display meters, with manual-sync anchors applied when present.
async function computeUsage(now = Date.now()) {
  const { buckets, weekStart, sessionStart } = await computeLocal(now);
  const sync = loadSync();
  const weeklyReset = weekStart + 7 * DAY;
  // The 5-hour session reset time isn't knowable locally (it shifts with the
  // window start); assume a fresh window as a fallback, overridden by a synced
  // reset time when the user provides one.
  const sessionReset = now + 5 * HOUR;
  return {
    now,
    session: bucketMeter(buckets.session5h, CEILINGS.session5h, sessionReset, sync.session, sessionStart, now),
    weeklyAll: bucketMeter(buckets.weeklyAll, CEILINGS.weeklyAll, weeklyReset, sync.weeklyAll, weekStart, now),
    weeklyFable: bucketMeter(buckets.weeklyFable, CEILINGS.weeklyFable, weeklyReset, sync.weeklyFable, weekStart, now),
  };
}

// Record the official %s you read off the desktop panel. We stamp each with the
// current local spend so future reads add only the Claude Code delta since sync.
async function saveSync(pcts, now = Date.now()) {
  const { buckets } = await computeLocal(now);
  const cur = loadSync();
  const set = (key, localSpent) => {
    const v = pcts && pcts[key];
    if (v === undefined || v === null || v === "" || Number.isNaN(Number(v))) return;
    const anchor = { pct: Number(v), atLocalSpent: localSpent, atMs: now };
    // Carry a session reset time (minutes-until-reset from the panel) if given.
    if (key === "session" && pcts.sessionResetMin != null && pcts.sessionResetMin !== "") {
      const mins = Number(pcts.sessionResetMin);
      if (!Number.isNaN(mins) && mins > 0) anchor.resetAt = now + mins * 60000;
    }
    cur[key] = anchor;
  };
  set("session", buckets.session5h);
  set("weeklyAll", buckets.weeklyAll);
  set("weeklyFable", buckets.weeklyFable);
  writeSync(cur);
  return computeUsage(now);
}

// An anchor is honored only while it's still inside the current window (a reset
// makes it stale). When honored: shown = official% of ceiling + local delta.
function bucketMeter(localSpent, ceiling, computedResetAt, anchor, windowStart, now) {
  let spent = localSpent;
  let synced = false;
  let syncedAt = null;
  let resetAt = computedResetAt;

  // A user-set reset time (entered from the panel) wins until it passes.
  const resetPassed = anchor && anchor.resetAt && now > anchor.resetAt;
  const resetUserSet = !!(anchor && anchor.resetAt && !resetPassed);
  if (resetUserSet) resetAt = anchor.resetAt;

  // Honor the synced % + local delta, unless its window rolled or reset passed.
  if (anchor && anchor.atMs >= windowStart && !resetPassed) {
    const delta = Math.max(0, localSpent - anchor.atLocalSpent);
    spent = (anchor.pct / 100) * ceiling + delta;
    synced = true;
    syncedAt = new Date(anchor.atMs).toISOString();
  }

  const m = meter(spent, ceiling, resetAt);
  m.synced = synced;
  m.syncedAt = syncedAt;
  m.resetUserSet = resetUserSet;
  return m;
}

function accumulateFile(file, now, weekStart, sessionStart, buckets) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    rl.on("line", (line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (o.type !== "assistant" || !o.message || !o.message.usage) return;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (Number.isNaN(ts) || ts < sessionStart && ts < weekStart) return;
      const cost = messageCost(o.message.model, o.message.usage);
      if (cost <= 0) return;
      if (ts >= weekStart) {
        buckets.weeklyAll += cost;
        if (o.message.model === MODELS.fable.id) buckets.weeklyFable += cost;
      }
      if (ts >= sessionStart) buckets.session5h += cost;
    });
    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

function meter(spent, ceiling, resetAt) {
  const pct = ceiling > 0 ? Math.min(999, (spent / ceiling) * 100) : 0;
  return {
    spent: round(spent),
    ceiling,
    pct: Math.round(pct),
    over: spent > ceiling,
    color: colorFor(pct), // green -> amber -> red as it fills
    resetAt: new Date(resetAt).toISOString(),
  };
}

// Green below 60%, amber 60-85%, red above — matches the requested cue.
function colorFor(pct) {
  if (pct >= 85) return "red";
  if (pct >= 60) return "amber";
  return "green";
}

// Build a meter from authoritative live numbers (no $ — % + real reset only).
function liveMeter(livePct, resetAtMs) {
  const pct = Math.round(livePct);
  return {
    spent: null,
    ceiling: null,
    pct,
    over: pct >= 100,
    color: colorFor(pct),
    resetAt: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    synced: false,
    syncedAt: null,
    resetUserSet: false,
    live: true,
  };
}

// Overlay live session + weekly-all-models numbers onto the proxy/manual meters.
// Fable has no live header, so it stays on the proxy/manual path.
function applyLive(base, live) {
  if (!live || !live.ok) {
    base.liveError = live ? live.reason : "unknown";
    return base;
  }
  if (live.session) base.session = liveMeter(live.session.pct, live.session.resetAt);
  if (live.weekly) base.weeklyAll = liveMeter(live.weekly.pct, live.weekly.resetAt);
  base.live = true;
  return base;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Given a routing decision, should the app warn before launching? True when the
// chosen model's weekly bucket is already over ceiling.
function overLimitFor(modelKey, usage) {
  if (modelKey === "fable") return usage.weeklyFable.over;
  return usage.weeklyAll.over;
}

module.exports = {
  computeUsage,
  saveSync,
  applyLive,
  CEILINGS,
  messageCost,
  lastWeeklyReset,
  overLimitFor,
};
