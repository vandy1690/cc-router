#!/usr/bin/env node
// Test harness for the router. Usage:
//   node src/cli.js "your prompt here"
//   node src/cli.js --no-classifier "your prompt"   (rules only, no network)
//   node src/cli.js --selftest                       (assert the rules; free, no network)
//   node src/cli.js --selftest --live                (also run the classifier cases; uses your plan)
//   node src/cli.js --rubric                         (print the tier table; the plugin's /route skill reads this)

const { route, ruleDecision, effortFor } = require("./router");
const { MODELS, ORDER, EFFORTS } = require("./models");

// Rules-only expectations. `null` means "the rules must stay out of it and
// hand the prompt to the classifier". The second block is the regression list:
// every one of these used to route confidently to the wrong model because the
// signals were matched as substrings ("export to" contains "port to").
const RULE_CASES = [
  ["fix the typo in the header comment", "haiku"],
  ["rename the variable userId to accountId in this function", "haiku"],
  ["reformat this file with prettier", "haiku"],
  ["migrate our Express routes to Fastify across the whole repo", "fable"],
  ["port the dashboard to Svelte", "fable"],
  ["rename getUser to fetchUser everywhere", "fable"],
  ["why is this useEffect causing an infinite render loop?", "opus"],
  ["design the caching architecture for a multi-region API", "opus"],
  ["update the button hover color in Button.tsx and Card.tsx and Nav.tsx and Modal.tsx", "opus"],
  ["add a dark mode toggle to the settings component", null],
  ["can you look at this and make it better", null],

  ["add an export to csv button on the orders page", null], // was Fable
  ["support toggling dark mode in settings", null], // was Fable
  ["change the server port to 3000", null], // was Fable
  ["improve the wording of the README intro", null], // was Opus
  ["approve the pending PR comments and tidy the copy", null], // was Opus
  ["what information does the users table hold", null], // was Haiku
  ["write a transformation helper for dates", null], // was Haiku
  ["add a migration for the new users table column", null], // DB migration, not a codebase move
  ["fix the typo in every file", null], // small word + big word: a contradiction
];

// Recommended --effort per rule that fires. Max is never recommended.
const EFFORT_CASES = [
  ["fix the typo in the header comment", "low"],
  ["migrate our Express routes to Fastify across the whole repo", "xhigh"],
  ["why is this useEffect causing an infinite render loop?", "high"],
  ["update the button hover color in Button.tsx and Card.tsx and Nav.tsx and Modal.tsx", "high"],
];

// Ambiguous prompts worth eyeballing against the live classifier.
const LIVE_CASES = [
  "add a dark mode toggle to the settings component",
  "can you look at this and make it better",
];

function fmt(prompt, d) {
  const conf = Math.round(d.confidence * 100);
  const flag = d.needsConfirm ? "  ⚠ ASK USER" : "";
  return [
    `> ${prompt}`,
    `  -> ${d.label} (${d.model})`,
    `     ${conf}% via ${d.source}${flag}`,
    `     reason: ${d.reason}`,
  ].join("\n");
}

async function selftest(live) {
  let failed = 0;
  for (const [prompt, want] of RULE_CASES) {
    const d = ruleDecision(prompt);
    const got = d ? d.modelKey : null;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${String(got || "classifier").padEnd(10)} ${prompt}${ok ? "" : `   (wanted ${want || "classifier"})`}`);
  }
  console.log(`\n${RULE_CASES.length - failed}/${RULE_CASES.length} rule cases passed.`);

  // Effort: the rule-driven levels, then every model's baseline (what the
  // classifier path uses) must be a value `claude --effort` accepts, and never max.
  let effFailed = 0;
  for (const [prompt, want] of EFFORT_CASES) {
    const got = ruleDecision(prompt).effort;
    const ok = got === want;
    if (!ok) effFailed++;
    console.log(`${ok ? "PASS" : "FAIL"}  effort ${String(got).padEnd(6)} ${prompt}${ok ? "" : `   (wanted ${want})`}`);
  }
  for (const k of ORDER) {
    const e = effortFor(k, null);
    const ok = EFFORTS.includes(e) && e !== "max";
    if (!ok) effFailed++;
    console.log(`${ok ? "PASS" : "FAIL"}  effort ${String(e).padEnd(6)} ${MODELS[k].label} baseline`);
  }
  const effTotal = EFFORT_CASES.length + ORDER.length;
  console.log(`\n${effTotal - effFailed}/${effTotal} effort cases passed.`);
  failed += effFailed;
  if (live) {
    console.log("\nLive classifier cases:\n");
    for (const p of LIVE_CASES) console.log(fmt(p, await route(p)) + "\n");
  }
  if (failed) process.exit(1);
}

// The tiers as the catalog describes them, cheapest first. Takes no user input,
// so a skill can run it inline without any shell-quoting risk.
function rubric() {
  const cmd = { haiku: "quick", sonnet: "build", opus: "deep", fable: "max" };
  for (const k of ORDER) {
    const m = MODELS[k];
    console.log(`- ${m.label} ${m.cost}  ->  /cc-router:${cmd[k]}  |  ${m.blurb}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--rubric")) return rubric();
  if (args.includes("--selftest")) return selftest(args.includes("--live"));

  const allowClassifier = !args.includes("--no-classifier");
  const prompt = args.filter((a) => a !== "--no-classifier").join(" ").trim();
  if (!prompt) {
    console.error('Usage: node src/cli.js "your prompt"   (add --no-classifier or --selftest)');
    process.exit(1);
  }
  const d = await route(prompt, { allowClassifier });
  console.log(fmt(prompt, d));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
