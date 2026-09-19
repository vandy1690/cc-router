#!/usr/bin/env node
// SessionStart + PostModelSwitch hook: remember which model this session is on.
//
//   SessionStart     may carry `model` (Claude Code omits it after /clear and
//                    on some restores, so its absence is normal)
//   PostModelSwitch  carries `to_model` (Claude Code 2.1.251+)
//
// Prints nothing. A hook that fails must never get in the session's way, so
// every path exits 0.

const { readInput, readSession, writeSession, prune } = require("./state");

(async () => {
  const input = await readInput();
  const id = input.session_id;
  if (!id) return;

  const model =
    input.hook_event_name === "PostModelSwitch" ? input.to_model : input.model;

  if (input.hook_event_name === "SessionStart") prune();
  if (!model) return;

  const state = readSession(id);
  state.model = String(model);
  state.at = Date.now();
  writeSession(id, state);
})().catch(() => {}).finally(() => process.exit(0));
