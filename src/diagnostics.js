// Diagnostics: check the three things this app reads that nobody promised it.
//
// Three of its best features stand on private ground:
//
//   1. The Keychain item Claude Code stores its login in, by name.
//   2. The shape of the transcript files Claude Code writes, which is how
//      recall knows a chat's title, its model, and what it spent.
//   3. The usage endpoint the plan meter reads, which is not a published API.
//
// None of that can be made safe. What it can be is loud. Each check below says
// what it looked for and what it found, so a Claude Code release that moves one
// of them turns into a sentence you can act on instead of an empty list or a
// number that is quietly wrong.
//
// Every check is read-only and costs nothing.

const { execFile } = require("child_process");
const { listProjects, sessionFiles, readSessionMeta } = require("./sessions");
const { getLiveUsage, usageState } = require("./live-usage");
const { priceFor } = require("./models");

const KEYCHAIN_SERVICE = "Claude Code-credentials";

const ok = (summary, detail) => ({ state: "ok", summary, detail });
const warn = (summary, detail) => ({ state: "warn", summary, detail });
const fail = (summary, detail) => ({ state: "fail", summary, detail });

// --- 1. The login ---
//
// Reading the password needs your permission and pops a macOS prompt. Reading
// the item's attributes does not. Asking in that order separates "you said no"
// from "the item is not there any more", which look identical otherwise.
function checkKeychain() {
  const find = (args) =>
    new Promise((resolve) =>
      execFile("security", args, { timeout: 15000 }, (err, stdout) => resolve({ err, stdout }))
    );
  return (async () => {
    const exists = await find(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
    if (exists.err) {
      return fail(
        "Claude Code's login is not in your keychain",
        `Looked for a keychain item named “${KEYCHAIN_SERVICE}”. It is not there. Either you are signed out of Claude Code, or it has started storing the login somewhere else. Usage falls back to an estimate from your transcripts.`
      );
    }
    const secret = await find(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (secret.err) {
      return warn(
        "The login is there, but this app cannot read it",
        `The keychain item “${KEYCHAIN_SERVICE}” exists and macOS refused to hand it over, which means permission was denied. Open Usage in the app and press “Turn on auto usage”, then choose Always Allow.`
      );
    }
    return ok("Claude Code's login is readable", `Found the keychain item “${KEYCHAIN_SERVICE}”. The token is used only in the request header and is never stored or logged.`);
  })();
}

// --- 2. The transcripts ---
//
// Read a small sample and confirm each field recall depends on is still there.
// Silence is the failure mode worth catching: a format change shows up as an
// empty chat list, which reads like "you have no history".
async function checkRecall(sample = 6) {
  const dirs = listProjects();
  if (!dirs.length) {
    return ok(
      "No chat history to read yet",
      "Found no project folders under ~/.claude/projects. That is normal on a new machine; recall fills in after your first session."
    );
  }
  let files = [];
  for (const d of dirs) {
    try {
      files = files.concat(sessionFiles(d));
    } catch (_) {}
  }
  if (!files.length) {
    return warn(
      "Project folders exist, but no transcripts inside them",
      `Found ${dirs.length} project folder${dirs.length === 1 ? "" : "s"} under ~/.claude/projects with no .jsonl files in them.`
    );
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = { cwd: 0, title: 0, model: 0, usage: 0 };
  const looked = files.slice(0, sample);
  for (const f of looked) {
    try {
      const meta = await readSessionMeta(f.file);
      if (meta.cwd) seen.cwd++;
      if (meta.title) seen.title++;
      if (meta.model) seen.model++;
      if (priceFor(meta.model)) seen.usage++;
    } catch (_) {}
  }
  const missing = [];
  if (!seen.cwd) missing.push("the folder a chat ran in");
  if (!seen.title) missing.push("chat titles");
  if (!seen.model) missing.push("which model a chat used");
  if (seen.model && !seen.usage) missing.push("a model name this app recognises");
  const where = `Read the ${looked.length} newest of ${files.length} transcripts across ${dirs.length} project folder${dirs.length === 1 ? "" : "s"}.`;
  if (missing.length) {
    return fail(
      "Claude Code's transcript format has changed",
      `${where} Could not find ${missing.join(", ")}. Recall reads a file layout Claude Code does not promise to keep, and this is what a change to it looks like. Chats may be missing, untitled, or unbadged until this app is updated.`
    );
  }
  return ok("Chat history reads correctly", `${where} Found the folder, title, model, and token counts each app feature depends on.`);
}

// --- 3. The usage numbers ---
//
// Which of the three sources answered, in as many words. A silent drop from the
// endpoint to the headers loses the Fable meter; a drop to the estimate loses
// everything outside Claude Code, which for a Cowork week is most of it.
const USAGE_SOURCE = {
  usage: ok("Live usage, from Anthropic's own numbers", "The plan meter is reading the same endpoint Claude Code's /usage screen uses: session, week, and the weekly Fable limit, each with its real reset time. It costs no tokens."),
  headers: warn("Live usage, but the detailed source is gone", "The usage endpoint did not answer, so the meter fell back to the rate-limit headers on a one-token request. Session and week are real; the Fable meter is an estimate from your transcripts, and there is no weekly breakdown."),
};

const mins = (ms) => Math.max(1, Math.round(ms / 60000));

async function checkUsage() {
  // Deliberately not a forced read: the endpoint rate-limits, and a diagnostic
  // that trips the limit it is checking for is worse than useless.
  const live = await getLiveUsage(30000);
  const state = usageState();
  if (live.ok && live.stale) {
    return warn(
      "Live usage, held from a few minutes ago",
      `The last good numbers are ${mins(live.staleMs)} minute${mins(live.staleMs) === 1 ? "" : "s"} old and are being shown while the endpoint is unavailable (${live.staleReason}). They refresh on their own${state.retryAt ? ` after ${new Date(state.retryAt).toLocaleTimeString()}` : ""}.`
    );
  }
  if (live.ok) return USAGE_SOURCE[live.source] || ok("Live usage", "Reading live numbers.");
  if (live.reason === "rate_limited") {
    return warn(
      "Anthropic is rate-limiting the usage endpoint",
      `Too many requests in a short window, which is temporary and not a sign that anything broke. Nothing will be asked of it${state.retryAt ? ` until ${new Date(state.retryAt).toLocaleTimeString()}` : " for a few minutes"}, so no tokens are spent retrying. Until then the meter estimates from your transcripts.`
    );
  }
  const why =
    live.reason === "no_token"
      ? "the login could not be read"
      : live.reason === "network"
      ? "the network did not answer"
      : live.reason === "http_401"
      ? "the login was refused, which usually means it expired; open any Claude Code session and it refreshes itself"
      : live.reason === "bad_body" || live.reason === "no_limits"
      ? "it answered with something this app did not recognise, which is what a change to that endpoint looks like"
      : `the request came back as ${live.reason}`;
  return fail(
    "No live usage: the meter is estimating",
    `Tried the usage endpoint and then the rate-limit headers, and ${why}. The meter is now a weighted guess from your local transcripts, which cannot see anything you did outside Claude Code, and it is only as good as the ceilings set in src/usage.js.`
  );
}

// Run all three. cliVersion is recorded so the app can notice when Claude Code
// updates and check again on its own.
async function runDiagnostics(cliVersion = null) {
  const [keychain, recall, usage] = await Promise.all([checkKeychain(), checkRecall(), checkUsage()]);
  const checks = { keychain, recall, usage };
  const worst = Object.values(checks).some((c) => c.state === "fail")
    ? "fail"
    : Object.values(checks).some((c) => c.state === "warn")
    ? "warn"
    : "ok";
  return { checks, worst, cliVersion, checkedAt: new Date().toISOString() };
}

module.exports = { runDiagnostics, checkKeychain, checkRecall, checkUsage };
