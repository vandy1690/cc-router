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
const { priceFor, isFable } = require("./models");

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
//
// 2026-09: spend is now counted once per message (it was ~2.2x high) and now
// includes Opus 5 / Fable 5.1 sessions (they priced at $0 before). Both change
// the scale, so treat the numbers below as placeholders until you re-sync from
// the panel. With live usage on, only the Fable bucket depends on them.
const CEILINGS = {
  session5h: 200, // rolling 5-hour session bucket (approximate — see note above)
  weeklyAll: 117, // weekly all-models bucket (calibrated)
  weeklyFable: 60, // weekly Fable-only bucket (Claude Code Fable only)
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Weighted cost of one assistant message, in USD. Cache reads are ~0.1x input
// price (0.025x on Fable 5.1); cache writes ~1.25x. Matches how spend accrues.
//
// priceFor() knows current models, the previous generation, and falls back by
// family for anything newer, so a transcript never prices at $0 just because
// the catalog moved on. (It used to: Opus 5 and Fable 5.1 sessions counted for
// nothing while the catalog still listed Opus 4.8 and Fable 5.)
function messageCost(model, usage) {
  const m = priceFor(model);
  if (!m || !usage) return 0;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const weightedInput = input + cacheRead * m.cacheReadMult + cacheWrite * 1.25;
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
  // message id -> { ts, model, cost }. Claude Code writes one transcript line
  // per content block (thinking, text, each tool call), and every line repeats
  // the whole message's usage. Summing lines counted each message about 2.2x.
  // Resumed sessions also copy history into a new file, so this is keyed across
  // files, not per file.
  const seen = new Map();

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
      await accumulateFile(full, weekStart, sessionStart, seen);
    }
  }

  for (const { ts, model, cost } of seen.values()) {
    if (ts >= weekStart) {
      buckets.weeklyAll += cost;
      // Any Fable-tier model: 5 and 5.1 draw from the same weekly pool.
      if (isFable(model)) buckets.weeklyFable += cost;
    }
    if (ts >= sessionStart) buckets.session5h += cost;
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

let anon = 0; // key for the rare assistant line with no message id

function accumulateFile(file, weekStart, sessionStart, seen) {
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
      const id = o.message.id || "anon-" + ++anon;
      const prev = seen.get(id);
      // Later lines of one message can carry a larger output count; keep the max.
      if (!prev || cost > prev.cost) seen.set(id, { ts, model: o.message.model, cost });
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
    color: colorFor(pct), // ok -> warn -> over as it fills
    resetAt: new Date(resetAt).toISOString(),
  };
}

// Severity, not a colour: the stylesheet decides what each state looks like.
// Normal below 60%, warn 60-85%, over above.
function colorFor(pct) {
  if (pct >= 85) return "over";
  if (pct >= 60) return "warn";
  return "ok";
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

// Overlay live numbers onto the local estimate. With the usage endpoint all
// three buckets are live; on the header fallback Fable stays on the estimate.
function applyLive(base, live) {
  if (!live || !live.ok) {
    base.liveError = live ? live.reason : "unknown";
    return base;
  }
  if (live.session) base.session = liveMeter(live.session.pct, live.session.resetAt);
  if (live.weekly) base.weeklyAll = liveMeter(live.weekly.pct, live.weekly.resetAt);
  if (live.fable) {
    base.weeklyFable = liveMeter(live.fable.pct, live.fable.resetAt);
    base.fableLabel = live.fable.label || "Fable";
  }
  base.breakdown = live.breakdown || [];
  base.liveSource = live.source || null;
  base.live = true;
  // A number a few minutes old, kept while the endpoint is rate-limited.
  if (live.stale) {
    base.liveStale = true;
    base.staleMs = live.staleMs || null;
  }
  // True when nothing on screen is an estimate, so the manual sync has no job.
  base.allLive = !!(live.session && live.weekly && live.fable);
  return base;
}

// When every bucket is live there is no reason to read a week of transcripts
// just to throw the result away. Build the snapshot from the live data alone.
function fromLive(live, now = Date.now()) {
  if (!live || !live.ok || !(live.session && live.weekly && live.fable)) return null;
  return applyLive({ now }, live);
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
  fromLive,
  CEILINGS,
  messageCost,
  lastWeeklyReset,
  overLimitFor,
};
