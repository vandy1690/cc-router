// Model catalog. Full IDs are required by `claude --model` (no opus/sonnet aliases).
// tier ranks cost/capability low -> high so the router can compare and step up/down.
// priceIn / priceOut are USD per 1M tokens (from the Claude pricing catalog),
// used by the usage meter to weight token spend the way the plan does.

const MODELS = {
  haiku: {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    tier: 1,
    priceIn: 1,
    priceOut: 5,
    blurb: "Fast and cheap. Small edits, questions, quick lookups, formatting.",
  },
  sonnet: {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    tier: 2,
    priceIn: 3,
    priceOut: 15,
    blurb: "Everyday coding default. Single-file features, bug fixes, reviews.",
  },
  opus: {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    tier: 3,
    priceIn: 5,
    priceOut: 25,
    blurb: "Hard reasoning. Architecture, tricky debugging, dense logic.",
  },
  fable: {
    id: "claude-fable-5",
    label: "Fable 5",
    tier: 4,
    priceIn: 10,
    priceOut: 50,
    blurb: "Big autonomous jobs. Multi-file migrations, large renames, long runs. Most expensive.",
  },
};

// Look up a model entry by its full model ID (as recorded in transcripts).
function byId(id) {
  return Object.values(MODELS).find((m) => m.id === id) || null;
}

// Model used for the ambiguous-case classifier. Cheapest capable model.
const CLASSIFIER_MODEL = MODELS.haiku.id;

function byKey(key) {
  return MODELS[key] || null;
}

module.exports = { MODELS, CLASSIFIER_MODEL, byKey, byId };
