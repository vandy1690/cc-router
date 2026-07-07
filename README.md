# cc-router

**Claude Code Router** — a standalone macOS desktop app that sits in front of Claude
Code. You type a prompt, it routes it to the right Claude model, asks you when it's
unsure, then opens a real, interactive Claude Code session in an embedded terminal.
It tracks your plan usage live and recalls your past sessions, grouped by project.

> Copyright © 2026 Steven Vanden Heuvel. All rights reserved. Proprietary — see
> [LICENSE](LICENSE). This is not open-source software.

## What it does

- **Smart model routing** — local rules pick the obvious cases instantly (a
  migration → Fable, a typo → Haiku); a cheap Haiku classifier handles the
  ambiguous ones. The decision shows as a thinking-block: **green** when the
  router chose, **yellow** when it's your call. One-tap override, and it can
  **learn a default model per project** from your overrides.
- **Embedded Claude Code** — launches real, interactive `claude` sessions inside
  the app (node-pty + xterm), with **tabs** for multiple concurrent sessions,
  **desktop notifications** when a background session finishes or waits on you,
  and keyboard shortcuts (⌘T new, ⌘1–9 switch, ⌘Enter launch).
- **Live usage meter** — reads your real Max-plan usage from Anthropic's unified
  rate-limit headers (via the Claude Code login already in your Keychain), with
  the session as a countdown and weekly as a clock time. Falls back to a manual
  panel-sync if headers aren't available; Fable stays on manual sync.
- **Session recall** — a folder browser over your Claude Code history with
  Claude's own AI-generated titles, a model badge per chat, search, pinned
  projects, resume-any-session, and Open in Finder.

## How it compares — in plain English

Model routers already exist, and they're good. **OpenRouter**, **Not Diamond**,
and **Martian** all pick the best model for a prompt (OpenRouter's "Auto" router
is powered by Not Diamond). **LiteLLM**, **Portkey**, and the **Vercel AI
Gateway** add routing, fallback, and cost tracking across many providers. So the
"pick a model" part of cc-router isn't new — and that's fine; it's a small part.

What those tools don't do is the thing cc-router is built around:

- **They bill per token through their own API. cc-router runs on your Claude
  subscription.** Using Fable through OpenRouter costs full API price on top of
  the Max plan you already pay for. cc-router opens real Claude Code sessions on
  your plan — no second bill.
- **They're a hosted endpoint. cc-router is a local app that runs real Claude
  Code** — interactive sessions, tabs, and all of Claude Code's tools, on your
  machine.
- **They don't know your plan usage. cc-router shows it live**, reading your true
  5-hour and weekly limits straight from Anthropic and warning you before you run
  out.
- **They don't remember your work. cc-router recalls it** — your past Claude Code
  sessions, by project, with titles, models, search, and pinning.

Short version: the router is the commodity; the value is a **subscription-native
launcher for Claude Code** with live usage and session recall — which nothing
off the shelf replaces.

## Requirements

- macOS, Node.js 18+, and the `claude` CLI on your PATH (Claude Code).
- A Claude subscription (built around Max; sessions run on your plan, not the API).

## Setup

`node_modules` is not committed, and `node-pty` is a native module that must be
built for Electron:

```bash
npm install
npx electron-rebuild -f -w node-pty   # build node-pty against Electron's ABI
npm start                             # launch the app
```

The core engines also run headless without the UI:

```bash
npm run route -- "migrate our API across the repo"   # routing
npm run projects                                     # recent chats by project
npm run usage                                        # usage meter
```

## How routing works

1. Cheap **local rules** handle the obvious prompts instantly, no network, no cost.
2. **Ambiguous** prompts fall back to a quick **Haiku** classifier that returns
   `{ model, confidence, reason }`.
3. Below `CONFIRM_THRESHOLD` (0.75) the app **asks you** (yellow thinking-block)
   and offers all four models as one-tap overrides.

| Tier | Model              | Use for                                          |
|------|--------------------|--------------------------------------------------|
| 1    | `claude-haiku-4-5` | trivial edits, questions, formatting             |
| 2    | `claude-sonnet-4-6`| everyday single-file coding, bug fixes, reviews  |
| 3    | `claude-opus-4-8`  | hard reasoning, architecture, tricky debugging   |
| 4    | `claude-fable-5`   | big multi-file migrations, long autonomous runs  |

## How usage tracking works

The meter prefers **live** numbers: one tiny (~1-token) authenticated request
returns Anthropic's `anthropic-ratelimit-unified-5h-*` and `-7d-*` headers —
the same real utilization and reset times the desktop Usage panel shows. The
Claude Code OAuth token is read from the macOS Keychain, used only in the
request header, and never logged. If that's unavailable, the meter falls back to
a weighted proxy from your local transcripts plus a manual panel-sync. Fable's
weekly bucket has no live header, so it stays on manual sync.

## How chat recall works

Claude Code stores history per project under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. This app reads that
(read-only), lists past chats with Claude's own `ai-title` and the model used,
and reopens any chat with `claude --resume <id> --model <model>` in the project
directory. App state (pins, prefs, manual sync) lives in `~/.cc-router/`.

## License & ownership

This software and its source code are the proprietary and confidential property
of Steven Vanden Heuvel. All rights reserved. No permission is granted to use,
copy, modify, distribute, or claim this software or any part of it without prior
written permission. See [LICENSE](LICENSE).
