// A clean environment for the `claude` processes this app starts.
//
// When the app itself is launched from inside a Claude Code session (a
// terminal tab, the Cursor extension, an agent), it inherits that session's
// markers. Passed on, they make the new session think it is a child of the old
// one: Claude Code turns transcript saving off ("inherited
// CLAUDE_CODE_CHILD_SESSION marker"), so the chat never shows up in recall, and
// the messaging socket and effort variables point at the parent session.
//
// Only these parent-session markers are removed. Anything a person sets on
// purpose (CLAUDE_CONFIG_DIR, provider settings, and so on) passes through.
const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
];

function sessionEnv(base = process.env) {
  const env = { ...base };
  for (const k of PARENT_SESSION_VARS) delete env[k];
  return env;
}

module.exports = { sessionEnv, PARENT_SESSION_VARS };
