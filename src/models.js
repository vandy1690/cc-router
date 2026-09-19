// Model catalog — the ONE place model IDs, labels, and prices live.
//
// Everything else reads from here: the router, the usage meter, the CLIs, and
// the renderer (over IPC, via catalogForRenderer). Updating to a new model
// generation means editing this file and nothing else.
//
// IDs are pinned on purpose. `claude --model` also accepts aliases ("sonnet",
// "opus", "fable"), but an alias resolves to whatever the installed CLI thinks
// is latest, so an old CLI would silently launch an old model. Full IDs make
// the launch deterministic; MIN_CLI below catches a CLI too old to know them.
//
// tier ranks cost/capability low -> high so the router can step up/down.
// priceIn / priceOut are USD per 1M tokens (Claude pricing, 2026-09). The usage
// meter uses them to weight token spend the way the plan does. cacheReadMult is
// the cache-read price as a fraction of priceIn (0.1 unless a model differs).

const MODELS = {
  haiku: {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    family: "haiku",
    tier: 1,
    cost: "$",
    effort: "low", // the router's starting point for this model
    priceIn: 1,
    priceOut: 5,
    blurb: "Fast and cheap. Small edits, questions, quick lookups, formatting.",
  },
  sonnet: {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    family: "sonnet",
    tier: 2,
    cost: "$$",
    effort: "medium", // the router's starting point for this model
    priceIn: 2,
    priceOut: 10,
    minCli: "2.1.197",
    blurb: "Everyday coding default. Features, bug fixes, reviews, routine multi-file work.",
  },
  opus: {
    id: "claude-opus-5",
    label: "Opus 5",
    family: "opus",
    tier: 3,
    cost: "$$$",
    effort: "high", // the router's starting point for this model
    priceIn: 5,
    priceOut: 25,
    minCli: "2.1.219",
    blurb: "Hard reasoning and long agentic work. Architecture, tricky debugging, big multi-file changes.",
  },
  fable: {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    family: "fable",
    tier: 4,
    cost: "$$$$",
    effort: "high", // the router's starting point for this model
    priceIn: 10,
    priceOut: 50,
    cacheReadMult: 0.025, // $0.25 per 1M cache-read tokens, a quarter of Fable 5's
    minCli: "2.1.260",
    blurb: "The most demanding jobs. Repo-wide migrations, long autonomous runs. Most expensive.",
  },
};

// Low -> high. The override chips and the step-up/step-down neighbors use this.
const ORDER = ["haiku", "sonnet", "opus", "fable"];

// Values `claude --effort` accepts, low -> high. Higher effort thinks longer and
// spends more of the plan per turn. Each model's `effort` above is where the
// router starts; the router moves it for clearly light or heavy prompts.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Models the router no longer launches but that still appear in transcripts.
// Without these, the usage meter would price last week's sessions at $0 the
// moment the catalog moves to a new generation.
const LEGACY = {
  "claude-fable-5": { family: "fable", priceIn: 10, priceOut: 50 },
  "claude-opus-4-8": { family: "opus", priceIn: 5, priceOut: 25 },
  "claude-opus-4-7": { family: "opus", priceIn: 5, priceOut: 25 },
  "claude-opus-4-6": { family: "opus", priceIn: 5, priceOut: 25 },
  "claude-sonnet-4-6": { family: "sonnet", priceIn: 3, priceOut: 15 },
};

// Last resort for an ID we have never seen (a future release, a dated snapshot
// such as claude-haiku-4-5-20251001): price it like the current model of the
// same family, so new usage is approximated instead of silently dropped.
const FAMILY_FALLBACK = { haiku: "haiku", sonnet: "sonnet", opus: "opus", fable: "fable", mythos: "fable" };

function familyOf(id) {
  if (!id) return null;
  const s = String(id).toLowerCase();
  return Object.keys(FAMILY_FALLBACK).find((f) => s.includes(f)) || null;
}

// Catalog key ("haiku" | "sonnet" | "opus" | "fable") for any model ID, by
// family. An older Opus, a dated snapshot, and a Mythos ID all resolve.
function keyForId(id) {
  const fam = familyOf(id);
  return fam ? FAMILY_FALLBACK[fam] : null;
}

// Look up a catalog entry by its exact model ID (as recorded in transcripts).
function byId(id) {
  return Object.values(MODELS).find((m) => m.id === id) || null;
}

function byKey(key) {
  return MODELS[key] || null;
}

// Pricing for ANY model ID: current catalog, then legacy, then family fallback.
// Returns null only for IDs that are not Claude models at all ("<synthetic>").
function priceFor(id) {
  const cur = byId(id);
  if (cur) return pick(cur, cur.family);
  if (LEGACY[id]) return pick(LEGACY[id], LEGACY[id].family);
  const fam = familyOf(id);
  if (!fam) return null;
  const m = MODELS[FAMILY_FALLBACK[fam]];
  return pick(m, m.family);
}

function pick(m, family) {
  return {
    family,
    priceIn: m.priceIn,
    priceOut: m.priceOut,
    cacheReadMult: m.cacheReadMult == null ? 0.1 : m.cacheReadMult,
  };
}

// True for any Fable-tier model, current or past. The plan meters Fable in its
// own weekly bucket, and 5 and 5.1 share that pool.
function isFable(id) {
  const p = priceFor(id);
  return !!p && p.family === "fable";
}

// Short family name for a chat's model badge ("Opus", "Fable", ...).
function shortName(id) {
  const fam = familyOf(id);
  if (!fam) return id || "";
  return fam.charAt(0).toUpperCase() + fam.slice(1);
}

// Model used for the ambiguous-case classifier. Cheapest capable model.
const CLASSIFIER_MODEL = MODELS.haiku.id;

// Each model's minCli is the oldest Claude Code CLI that handles it well, from
// the Claude Code changelog: Sonnet 5 arrived in 2.1.197, Opus 5 in 2.1.219,
// Fable 5.1 in 2.1.257, and 2.1.260 fixed Fable 5.1 prompt caching (before it,
// context was re-sent uncached on every tool call, which burns plan usage).
// An older CLI still passes the ID through, but knows nothing about the model.
// The app compares `claude --version` against these and warns before launching.
function cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Newest of the per-model minimums: the version that unlocks the whole catalog.
const MIN_CLI = Object.values(MODELS)
  .map((m) => m.minCli)
  .filter(Boolean)
  .sort(cmpVersion)
  .pop();

// The slice of the catalog the renderer needs. No prices: the UI shows the
// cost glyph, and the meter math stays in the main process.
function catalogForRenderer() {
  const models = {};
  for (const key of ORDER) {
    const m = MODELS[key];
    models[key] = { key, id: m.id, label: m.label, cost: m.cost, blurb: m.blurb, tier: m.tier, effort: m.effort, minCli: m.minCli || null };
  }
  return { models, order: ORDER.slice(), efforts: EFFORTS.slice(), minCli: MIN_CLI };
}

module.exports = {
  MODELS,
  ORDER,
  EFFORTS,
  LEGACY,
  CLASSIFIER_MODEL,
  MIN_CLI,
  cmpVersion,
  byKey,
  byId,
  priceFor,
  isFable,
  familyOf,
  keyForId,
  shortName,
  catalogForRenderer,
};
