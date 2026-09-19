---
name: quick
description: "Run one task on Haiku, the fast and cheap tier, then return to the session's model. For small, mechanical work: typos, renames, formatting, quick lookups, one-line fixes."
argument-hint: "[task]"
model: haiku
disable-model-invocation: true
---

Do this task now. It was sent to the fast tier on purpose, so keep it tight: make the change, check it, and report in a sentence or two.

If it turns out to need real design judgment or to touch many files, stop and say so in one line instead of pushing on. The user can resend it with `/cc-router:build` or `/cc-router:deep`.

Task: $ARGUMENTS
