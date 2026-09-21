#!/usr/bin/env node
// npm run check — does this install actually work on this machine?
//
// Run it after setup, or any time the app behaves oddly. It touches nothing:
// no files are written, no sessions are started, and the only network call is
// the free usage endpoint. It answers four questions in order of how much they
// would ruin your day:
//
//   1. Does the code parse, and does the router still make the calls it should?
//   2. Is the `claude` command on the PATH, and is it new enough for the models
//      in the catalog?
//   3. Can the terminal component load? (node-pty is native and must be built
//      against Electron; a mismatch is the usual reason sessions do not start.)
//   4. Are the three things this app reads that nobody promised it still there?
//      See src/diagnostics.js.

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
const add = (state, name, detail) => results.push({ state, name, detail });
const MARK = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };

// 1. Every source file parses, and the routing rules still hold.
async function checkCode() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  };
  walk(ROOT);
  const broken = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    } catch (e) {
      broken.push(path.relative(ROOT, f));
    }
  }
  if (broken.length) add("fail", "Source files parse", `${broken.length} did not: ${broken.join(", ")}`);
  else add("ok", "Source files parse", `${files.length} JavaScript files.`);

  try {
    const { stdout } = await execFile(process.execPath, [path.join(ROOT, "src", "cli.js"), "--selftest"]);
    const lines = stdout.trim().split("\n").filter((l) => /passed|FAIL/.test(l));
    const failed = /FAIL/.test(stdout);
    add(failed ? "fail" : "ok", "Routing rules", lines.join(" "));
  } catch (e) {
    add("fail", "Routing rules", "The self-test did not finish: " + String(e.message).slice(0, 120));
  }
}

// 2. The command every session runs.
async function checkCli() {
  const { MIN_CLI, cmpVersion, MODELS } = require(path.join(ROOT, "src", "models.js"));
  const shell = process.env.SHELL || "/bin/zsh";
  let out = "";
  try {
    // An interactive login shell, the same one the app asks for its PATH.
    ({ stdout: out } = await execFile(shell, ["-ilc", "claude --version"], { timeout: 20000 }));
  } catch (e) {
    out = (e && e.stdout) || "";
  }
  const m = out.match(/(\d+\.\d+\.\d+)/);
  if (!m) {
    add("fail", "Claude Code on your PATH", "`claude --version` did not answer. Install Claude Code, or check that it is on the PATH your shell sets up.");
    return;
  }
  const v = m[1];
  if (cmpVersion(v, MIN_CLI) >= 0) {
    add("ok", "Claude Code on your PATH", `Version ${v}, which covers every model in the catalog.`);
  } else {
    const behind = Object.values(MODELS)
      .filter((x) => x.minCli && cmpVersion(v, x.minCli) < 0)
      .map((x) => x.label);
    add("warn", "Claude Code on your PATH", `Version ${v}. ${behind.join(" and ")} need ${MIN_CLI} or newer: run \`claude update\`.`);
  }
}

// 3. The native module the embedded terminals are built on.
function checkPty() {
  const electronVersion = require(path.join(ROOT, "node_modules/electron/package.json")).version;
  const bin = path.join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (!fs.existsSync(bin)) {
    add("fail", "Terminal component", "Electron is not installed. Run `npm install`.");
    return;
  }
  try {
    execFileSync(bin, ["-e", "require('node-pty')"], {
      stdio: "pipe",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    add("ok", "Terminal component", `node-pty loads under Electron ${electronVersion}.`);
  } catch (e) {
    add("fail", "Terminal component", "node-pty will not load under Electron, so sessions cannot start. Run `npm run rebuild`.");
  }
}

// 4. The three surfaces nobody promised.
async function checkSurfaces() {
  const { runDiagnostics } = require(path.join(ROOT, "src", "diagnostics.js"));
  const d = await runDiagnostics();
  const LABEL = { keychain: "Your Claude Code login", recall: "Chat history", usage: "Plan usage" };
  for (const [key, c] of Object.entries(d.checks)) add(c.state, LABEL[key] || key, c.summary + ". " + c.detail);
}

const wrap = (s, width = 92, indent = "        ") =>
  String(s)
    .split(" ")
    .reduce((lines, word) => {
      const last = lines[lines.length - 1];
      if ((last + " " + word).trim().length > width) lines.push(word);
      else lines[lines.length - 1] = (last + " " + word).trim();
      return lines;
    }, [""])
    .join("\n" + indent);

(async () => {
  console.log("\ncc-router check\n");
  await checkCode();
  await checkCli();
  checkPty();
  await checkSurfaces();

  for (const r of results) {
    console.log(`[${MARK[r.state]}] ${r.name}`);
    if (r.detail) console.log("        " + wrap(r.detail));
  }
  const failed = results.filter((r) => r.state === "fail").length;
  const warned = results.filter((r) => r.state === "warn").length;
  console.log(
    `\n${results.length - failed - warned} passed, ${warned} warning${warned === 1 ? "" : "s"}, ${failed} failure${failed === 1 ? "" : "s"}.\n`
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("The check itself failed: " + (e && e.message ? e.message : e));
  process.exit(1);
});
