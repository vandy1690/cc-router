// Routing: decide which model a prompt should use.
//
// Strategy: cheap local rules first. If the rules give a clear, confident
// answer, use it (no network, no cost). Only genuinely ambiguous prompts fall
// back to a Haiku classifier call. When nothing is confident, we return
// needsConfirm=true so the UI can ask the user.

const { execFile } = require("child_process");
const { MODELS, CLASSIFIER_MODEL } = require("./models");

// --- Signal words. Kept small and honest; easy to tune later. ---

const HEAVY = [
  "migrate", "migration", "refactor across", "across the codebase", "across files",
  "every file", "all files", "rename everywhere", "codebase-wide", "port to",
  "upgrade the framework", "rewrite the", "large-scale", "whole repo", "entire repo",
];

const HARD = [
  "architecture", "design a system", "why is this", "root cause", "race condition",
  "deadlock", "prove", "algorithm", "optimize the", "concurrency", "debug why",
  "trade-off", "tradeoff", "reason about",
];

const LIGHT = [
  "typo", "rename this variable", "format", "prettier", "add a comment",
  "what does this", "explain this line", "quick question", "one-liner",
  "bump version", "update the readme", "fix the import",
];

function countHits(text, words) {
  const t = text.toLowerCase();
  return words.reduce((n, w) => (t.includes(w) ? n + 1 : n), 0);
}

// Rough scale signal: lots of mentions of files, or a long detailed prompt,
// nudges toward the heavier tiers.
function scaleSignal(text) {
  const fileMentions = (text.match(/\b[\w./-]+\.(js|ts|tsx|jsx|py|rs|go|java|css|html|json|md|astro|vue|svelte)\b/gi) || []).length;
  const longPrompt = text.length > 600;
  return { fileMentions, longPrompt };
}

// --- Rule pass. Returns a decision or null (meaning: ask the classifier). ---

function ruleDecision(prompt) {
  const heavy = countHits(prompt, HEAVY);
  const hard = countHits(prompt, HARD);
  const light = countHits(prompt, LIGHT);
  const { fileMentions, longPrompt } = scaleSignal(prompt);

  // Strong heavy signal -> Fable.
  if (heavy >= 1 || fileMentions >= 4) {
    return decide("fable", 0.9, reasonFor("large multi-file / migration signal", { heavy, fileMentions }));
  }

  // Clear hard-reasoning signal, not a big sweep -> Opus.
  if (hard >= 1 && heavy === 0) {
    return decide("opus", 0.82, reasonFor("hard-reasoning signal", { hard }));
  }

  // Clear trivial signal, short prompt, no conflicting signals -> Haiku.
  if (light >= 1 && hard === 0 && heavy === 0 && !longPrompt && fileMentions <= 1) {
    return decide("haiku", 0.85, reasonFor("small/trivial task signal", { light }));
  }

  // Nothing pulled hard in any direction. Let the classifier decide.
  return null;
}

function decide(key, confidence, reason, source = "rules") {
  const m = MODELS[key];
  return {
    modelKey: key,
    model: m.id,
    label: m.label,
    blurb: m.blurb,
    confidence,
    reason,
    source,
    needsConfirm: confidence < CONFIRM_THRESHOLD,
    // Handy alternatives for the "ask me" UI: one step lighter, one heavier.
    alternatives: neighbors(key),
  };
}

const CONFIRM_THRESHOLD = 0.75; // below this, ask the user

function neighbors(key) {
  const order = ["haiku", "sonnet", "opus", "fable"];
  const i = order.indexOf(key);
  return [order[i - 1], order[i + 1]].filter(Boolean).map((k) => ({
    modelKey: k,
    model: MODELS[k].id,
    label: MODELS[k].label,
    blurb: MODELS[k].blurb,
  }));
}

function reasonFor(headline, hits) {
  const parts = Object.entries(hits)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`);
  return parts.length ? `${headline} (${parts.join(", ")})` : headline;
}

// --- Classifier fallback. Uses `claude -p` with the cheap model. ---

function classifyWithHaiku(prompt, { timeoutMs = 20000 } = {}) {
  const system =
    "You are a routing classifier for coding prompts. Choose the cheapest model " +
    "that can do the job well. Options and when to use them:\n" +
    "- haiku: trivial edits, questions, formatting.\n" +
    "- sonnet: everyday single-file coding, bug fixes, reviews.\n" +
    "- opus: hard reasoning, architecture, tricky debugging.\n" +
    "- fable: large multi-file migrations, big renames, long autonomous runs.\n" +
    'Respond with ONLY a JSON object: {"model":"haiku|sonnet|opus|fable","confidence":0..1,"reason":"short"}.';

  const fullPrompt = `${system}\n\nPROMPT TO ROUTE:\n"""\n${prompt}\n"""`;

  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", "--model", CLASSIFIER_MODEL, "--output-format", "json", fullPrompt],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(fallbackSonnet("classifier call failed: " + err.message));
        const parsed = extractClassification(stdout);
        if (!parsed) return resolve(fallbackSonnet("could not parse classifier output"));
        const key = ["haiku", "sonnet", "opus", "fable"].includes(parsed.model) ? parsed.model : "sonnet";
        const conf = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
        resolve(decide(key, conf, parsed.reason || "classifier decision", "classifier"));
      }
    );
  });
}

// `claude -p --output-format json` wraps the assistant text in a JSON envelope
// (usually a `result` field). We pull that out, then find the inner JSON.
function extractClassification(stdout) {
  let text = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === "string") text = env.result;
    else if (env && env.model) return env; // already the shape we want
  } catch (_) {
    // stdout wasn't a clean envelope; fall through and scan raw text
  }
  const match = text.match(/\{[\s\S]*?"model"[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function fallbackSonnet(reason) {
  // Safe default when the classifier is unavailable: everyday coding model,
  // flagged for confirmation so the user stays in control.
  return decide("sonnet", 0.5, reason, "fallback");
}

// --- Public entry point. ---

async function route(prompt, { allowClassifier = true } = {}) {
  const trimmed = (prompt || "").trim();
  if (!trimmed) {
    return decide("sonnet", 0.4, "empty prompt; defaulting", "fallback");
  }
  const ruled = ruleDecision(trimmed);
  if (ruled) return ruled;
  if (!allowClassifier) return fallbackSonnet("ambiguous; classifier disabled");
  return classifyWithHaiku(trimmed);
}

module.exports = { route, CONFIRM_THRESHOLD, ruleDecision, classifyWithHaiku };
