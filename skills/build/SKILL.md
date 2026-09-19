---
name: build
description: "Run one task on Sonnet, the everyday coding tier, then return to the session's model. For features, bug fixes, reviews, and routine multi-file work."
argument-hint: "[task]"
model: sonnet
disable-model-invocation: true
---

Do this task now, the way you would any ordinary piece of engineering work: read what you need, make the change, verify it, and report what you did.

If it turns out to hinge on hard reasoning you are not sure of (a subtle concurrency bug, an architecture call), say so in one line. The user can resend it with `/cc-router:deep`.

Task: $ARGUMENTS
