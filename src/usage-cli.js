#!/usr/bin/env node
// Shows the usage meter built from your real transcripts. Usage:
//   node src/usage-cli.js

const { computeUsage, CEILINGS } = require("./usage");

function bar(pct) {
  const width = 24;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function line(name, m) {
  const reset = m.resetAt.slice(0, 16).replace("T", " ");
  const flag = m.over ? "  ⚠ OVER LIMIT" : "";
  return [
    `${name}`,
    `  ${bar(m.pct)} ${m.pct}% (${m.color})   $${m.spent} of $${m.ceiling}${flag}`,
    `  resets ${reset}`,
  ].join("\n");
}

(async () => {
  const u = await computeUsage();
  console.log("USAGE METER (weighted spend vs calibratable ceilings)\n");
  console.log(line("Current session (rolling 5h)", u.session));
  console.log("");
  console.log(line("Weekly — all models", u.weeklyAll));
  console.log("");
  console.log(line("Weekly — Fable only", u.weeklyFable));
  console.log("");
  console.log(
    `Ceilings (edit in src/usage.js to match your plan): session $${CEILINGS.session5h}, weekly $${CEILINGS.weeklyAll}, Fable $${CEILINGS.weeklyFable}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
