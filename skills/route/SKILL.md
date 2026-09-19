---
name: route
description: "Say which model tier a task belongs on, and why, without starting the work. Runs on Haiku so the question itself costs almost nothing."
argument-hint: "[task]"
model: haiku
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --rubric)
---

You are sizing a task, not doing it. Do not read files, run tools, or start the work.

The tiers, cheapest first:

!`node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --rubric`

Pick the cheapest tier that can do the task well. Sonnet is the default for ordinary coding. Step up only when the task needs it, and step down when it is small and mechanical.

Answer in exactly this shape, and nothing else:

1. The tier and the command to run, for example: **Sonnet 5**, send it as `/cc-router:build <task>`
2. One sentence on why that tier fits.
3. If it is a close call, one sentence naming the other tier and what would tip it.

Task: $ARGUMENTS
