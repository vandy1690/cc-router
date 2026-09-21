// Routing: decide which model a prompt should use.
//
// Strategy: cheap local rules first. If the rules give a clear, confident
// answer, use it (no network, no cost). Only genuinely ambiguous prompts fall
// back to a Haiku classifier call. When nothing is confident, we return
// needsConfirm=true so the UI can ask the user.
//
// The rules half of this file is pure (no I/O). The Claude Code plugin's prompt
// hook requires it directly, so the desktop app and the plugin always agree.

const { execFile } = require("child_process");
const os = require("os");
const { MODELS, ORDER, CLASSIFIER_MODEL } = require("./models");
const { sessionEnv } = require("./env");

// --- Signals -----------------------------------------------------------------
//
// Every signal is a regex with word boundaries. They used to be plain
// substrings, which misfired badly: "export to" contains "port to" (-> Fable),
// "improve" contains "prove" (-> Opus), "information" contains "format"
// (-> Haiku). A confident wrong answer is the worst thing a router can do, so
// anything ambiguous is left out and handed to the classifier instead.

// Unmistakable whole-codebase scale -> the top tier.
const HEAVY = [
  /\bacross (?:the |our |this )?(?:whole |entire )?(?:codebase|repo|repository|monorepo|project)\b/,
  /\b(?:whole|entire) (?:codebase|repo|repository|monorepo|project)\b/,
  /\bacross (?:all |the |multiple |many )?files\b/,
  /\b(?:every|all(?: the| of the)?) files?\b/,
  /\b(?:codebase|repo|project)[- ]wide\b/,
  /\brename\b.{0,40}\beverywhere\b/,
  /\blarge[- ]scale\b/,
  /\bupgrade (?:the |our )?framework\b/,
  /\bframework upgrade\b/,
  /\brefactor across\b/,
  // "port X to Y" as a verb. Not "change the server port to 3000".
  /(?<!\b(?:the|a|this|that|server|http|https|tcp|udp|default|local|dev|which|what) )\bport(?:ing)? (?:\w+ ){0,4}to\b/,
];

// "Migrate" means a codebase move unless it is a database migration, which is
// usually one small file. With DB words nearby the rules stay out of it.
const MIGRATE = /\bmigrat(?:e|es|ed|ing|ion|ions)\b/;
const DB_CONTEXT = /\b(?:database|db|schema|table|tables|column|columns|sql|postgres|mysql|sqlite|prisma|drizzle|knex|alembic|sequelize|typeorm|rails|django|supabase)\b/;

// Hard reasoning, not necessarily big.
const HARD = [
  /\barchitecture\b/,
  /\bdesign a system\b/,
  /\bwhy is this\b/,
  /\broot cause\b/,
  /\brace condition\b/,
  /\bdeadlocks?\b/,
  /\bprove\b/,
  /\balgorithms?\b/,
  /\boptimi[sz]e the\b/,
  /\bconcurrency\b/,
  /\bdebug why\b/,
  /\btrade-?offs?\b/,
  /\breason about\b/,
];

// Small, mechanical, low-stakes.
const LIGHT = [
  /\btypos?\b/,
  /\brename (?:this|the|a) (?:variable|function|constant|const|prop|param|parameter|class|file)\b/,
  /\b(?:re)?format(?:ting)?\b/,
  /\bprettier\b/,
  /\badd a comment\b/,
  /\bwhat does this\b/,
  /\bexplain this line\b/,
  /\bquick question\b/,
  /\bone-?liner\b/,
  /\bbump (?:the )?version\b/,
  /\bupdate the readme\b/,
  /\bfix the imports?\b/,
];

function countHits(text, patterns) {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

// Rough scale signal: lots of named files, or a long detailed prompt, nudges
// toward the heavier tiers.
function scaleSignal(text) {
  const fileMentions = (text.match(/\b[\w./-]+\.(?:js|ts|tsx|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|css|scss|html|json|md|astro|vue|svelte)\b/gi) || []).length;
  const longPrompt = text.length > 600;
  return { fileMentions, longPrompt };
}

// --- Rule pass. Returns a decision or null (meaning: ask the classifier). ---

function ruleDecision(prompt) {
  const text = String(prompt || "").toLowerCase();
  let heavy = countHits(text, HEAVY);
  if (MIGRATE.test(text) && !DB_CONTEXT.test(text)) heavy += 1;
  const hard = countHits(text, HARD);
  const light = countHits(text, LIGHT);
  const { fileMentions, longPrompt } = scaleSignal(text);

  // A small-task word next to a big-task word is a contradiction the rules
  // should not settle ("fix the typo in every file").
  if (light >= 1 && (heavy >= 1 || hard >= 1)) return null;

  // Unmistakable whole-codebase scale -> Fable.
  if (heavy >= 1) {
    return decide("fable", 0.9, reasonFor("whole-codebase / migration signal", { heavy, fileMentions }), "rules", "heavy");
  }

  // Several named files, no codebase-wide language -> Opus. It is built for
  // multi-file agentic work at half of Fable's price.
  if (fileMentions >= 4) {
    return decide("opus", 0.8, reasonFor("several files named", { fileMentions, hard }), "rules", "files");
  }

  // Clear hard-reasoning signal, not a big sweep -> Opus.
  if (hard >= 1) {
    return decide("opus", 0.82, reasonFor("hard-reasoning signal", { hard }), "rules", "hard");
  }

  // Clear trivial signal, short prompt, nothing conflicting -> Haiku.
  if (light >= 1 && !longPrompt && fileMentions <= 1) {
    return decide("haiku", 0.85, reasonFor("small/trivial task signal", { light }), "rules", "light");
  }

  // Nothing pulled hard in any direction. Let the classifier decide.
  return null;
}

const CONFIRM_THRESHOLD = 0.75; // below this, ask the user

// kind names which rule fired ("heavy" | "files" | "hard" | "light"), so other
// surfaces (the plugin's nudge) can describe it in plain words.
function decide(key, confidence, reason, source = "rules", kind = null) {
  const m = MODELS[key];
  return {
    kind,
    modelKey: key,
    model: m.id,
    label: m.label,
    blurb: m.blurb,
    tier: m.tier,
    confidence,
    reason,
    source,
    effort: effortFor(key, kind),
    needsConfirm: confidence < CONFIRM_THRESHOLD,
    // Handy alternatives for the "ask me" UI: one step lighter, one heavier.
    alternatives: neighbors(key),
  };
}

// Recommended `--effort`. Start from the model's baseline in the catalog, then
// follow the rule that fired: a clearly small task does not need long thinking,
// and a whole-codebase sweep earns more. Never max: it is the costliest setting
// and nothing a rule can see justifies it, so it stays a manual choice.
const EFFORT_BY_KIND = { light: "low", hard: "high", files: "high", heavy: "xhigh" };

function effortFor(key, kind) {
  return EFFORT_BY_KIND[kind] || MODELS[key].effort;
}

function neighbors(key) {
  const i = ORDER.indexOf(key);
  return [ORDER[i - 1], ORDER[i + 1]].filter(Boolean).map((k) => ({
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

// The tier descriptions come from the catalog, so they follow a model update.
function classifierSystemPrompt() {
  const lines = ORDER.map((k) => `- ${k} (${MODELS[k].label}): ${MODELS[k].blurb}`);
  return (
    "You are a routing classifier for coding prompts. Choose the cheapest model " +
    "that can do the job well. Options, cheapest first:\n" +
    lines.join("\n") +
    "\nSonnet is the default for ordinary coding. Step up only when the task needs it.\n" +
    `Respond with ONLY a JSON object: {"model":"${ORDER.join("|")}","confidence":0..1,"reason":"short"}.`
  );
}

// The classifier needs none of Claude Code's machinery, and by default every
// `claude -p` call carries all of it: the full system prompt, every built-in
// tool, every MCP server, the skills list. These flags strip the call down to
// the routing question while still using the Claude Code login (unlike --bare,
// which skips OAuth and the Keychain entirely).
//   --no-session-persistence also keeps these calls out of ~/.claude/projects,
//   so they never show up as chats in the recall list.
//   --setting-sources "" skips the user's settings files, so hooks and plugins
//   do not run and a personal CLAUDE.md is not sent along with a routing question.
// Thinking stays ON. Turning it off (MAX_THINKING_TOKENS=0) halves the wait, but
// in testing Haiku then called a real feature "haiku" at 95% confidence, and a
// confident wrong answer is the one thing a router must not produce.
const SLIM_FLAGS = ["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--setting-sources", ""];

function runClassifier(prompt, { slim, timeoutMs, signal }) {
  const system = classifierSystemPrompt();
  const user = `PROMPT TO ROUTE:\n"""\n${prompt}\n"""`;
  const args = slim
    ? ["-p", "--model", CLASSIFIER_MODEL, "--output-format", "json", "--system-prompt", system, ...SLIM_FLAGS, user]
    : ["-p", "--model", CLASSIFIER_MODEL, "--output-format", "json", `${system}\n\n${user}`];
  return new Promise((resolve) => {
    // signal lets the caller kill a call the user has already typed past.
    // cwd is pinned: an app opened from the Dock starts in "/", and the
    // classifier should behave the same however the app was launched.
    execFile("claude", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal, env: sessionEnv(), cwd: os.homedir() }, (err, stdout) =>
      resolve({ err, stdout })
    );
  });
}

async function classifyWithHaiku(prompt, { timeoutMs = 20000, signal } = {}) {
  const cancelled = () => !!(signal && signal.aborted);
  // Slim first. If this CLI rejects a flag, fall back to the plain call once.
  let r = await runClassifier(prompt, { slim: true, timeoutMs, signal });
  if (cancelled()) return fallbackSonnet("cancelled: the prompt changed");
  if (r.err && !extractClassification(r.stdout || "")) {
    r = await runClassifier(prompt, { slim: false, timeoutMs, signal });
    if (cancelled()) return fallbackSonnet("cancelled: the prompt changed");
  }
  if (r.err && !r.stdout) return fallbackSonnet("classifier call failed: " + r.err.message);
  const parsed = extractClassification(r.stdout || "");
  if (!parsed) return fallbackSonnet("could not parse classifier output");
  const key = ORDER.includes(parsed.model) ? parsed.model : "sonnet";
  const conf = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
  return decide(key, conf, parsed.reason || "classifier decision", "classifier");
}

// `claude -p --output-format json` wraps the assistant text in a JSON envelope
// (usually a `result` field). We pull that out, then find the inner JSON.
function extractClassification(stdout) {
  let text = stdout;
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === "string") text = env.result;
    else if (env && env.model && ORDER.includes(env.model)) return env; // already the shape we want
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

// Identical prompts get identical answers, so remember recent classifier
// results. The UI re-routes on every typing pause; without this, retyping or
// pausing twice on the same text pays for the same call twice.
const cache = new Map();
const CACHE_MAX = 50;

async function route(prompt, { allowClassifier = true, signal } = {}) {
  const trimmed = (prompt || "").trim();
  if (!trimmed) {
    return decide("sonnet", 0.4, "empty prompt; defaulting", "fallback");
  }
  const ruled = ruleDecision(trimmed);
  if (ruled) return ruled;
  if (!allowClassifier) return fallbackSonnet("ambiguous; classifier disabled");

  if (cache.has(trimmed)) return cache.get(trimmed);
  const d = await classifyWithHaiku(trimmed, { signal });
  if (d.source === "classifier") {
    cache.set(trimmed, d);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return d;
}

module.exports = { route, CONFIRM_THRESHOLD, effortFor, ruleDecision, classifyWithHaiku, classifierSystemPrompt };
