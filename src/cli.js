#!/usr/bin/env node
// Test harness for the router. Usage:
//   node src/cli.js "your prompt here"
//   node src/cli.js --no-classifier "your prompt"   (rules only, no network)
//   node src/cli.js --selftest                       (run the built-in cases)

const { route } = require("./router");

const SELFTEST = [
  "fix the typo in the header comment",
  "migrate our Express routes to Fastify across the whole repo",
  "why is this useEffect causing an infinite render loop?",
  "add a dark mode toggle to the settings component",
  "rename the variable userId to accountId in this function",
  "design the caching architecture for a multi-region API",
  "update the button hover color in Button.tsx and Card.tsx and Nav.tsx and Modal.tsx",
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

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    const allowClassifier = !args.includes("--no-classifier");
    for (const p of SELFTEST) {
      const d = await route(p, { allowClassifier });
      console.log(fmt(p, d) + "\n");
    }
    return;
  }

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
