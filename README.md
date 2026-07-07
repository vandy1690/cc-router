# cc-router

A standalone Mac desktop app that sits in front of Claude Code. You type a prompt,
it picks the right Claude model, asks you when it is unsure, then opens a real,
interactive Claude Code session in an embedded terminal. It tracks your token usage
against your plan, and it recalls your previous chats, grouped by project.

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

## Decisions locked

- **Standalone desktop app** (full window), Electron, styled in the Steven Design Co
  system (off-white `#F0EEE9`, slate-blue `#4A6FA8`). Global hotkey: **F19**.
- **Routing**: always show the chosen model with one-tap override; reasoning is
  viewable on demand; each model carries a cost cue.
- **Usage**: local weighted meter matched to the Max (5x) plan buckets, green→red
  as it fills, with an over-limit confirmation before launching.

## Status

- **Router core** — rules + Haiku fallback classifier (`src/router.js`, `src/models.js`).
- **Project / chat recall** — folder browser over `~/.claude/projects`, resume any session, Open in Finder (`src/sessions.js`).
- **Usage meter** — weighted proxy + manual panel sync, editable session reset time (`src/usage.js`).
- **Electron desktop UI** — 12-column grid, embedded Claude Code terminals, tabbed multi-session.

## Usage meter

Reads real per-message token counts from the transcripts, weights them by each
model's price, and tracks three buckets against calibratable ceilings: rolling
5-hour session, weekly all-models, weekly Fable. Green below 60%, amber 60–85%,
red above. It is a close proxy for Anthropic's official %, not a byte-for-byte
copy — nudge the ceilings in `src/usage.js` to match the desktop Usage panel.

```bash
npm run usage      # show the meter from your real history
```

## How routing works

1. Cheap **local rules** handle the obvious prompts instantly, no network, no cost
   (a migration → Fable, a typo → Haiku, an architecture question → Opus).
2. Only **ambiguous** prompts fall back to a quick **Haiku** classifier call
   that returns `{ model, confidence, reason }`.
3. If confidence is below `CONFIRM_THRESHOLD` (0.75), the app **asks you** and
   offers one-step-lighter / one-step-heavier alternatives.

Models (full IDs, required by `claude --model`):

| Tier | Model            | Use for                                             |
|------|------------------|-----------------------------------------------------|
| 1    | claude-haiku-4-5 | trivial edits, questions, formatting                |
| 2    | claude-sonnet-5  | everyday single-file coding, bug fixes, reviews     |
| 3    | claude-opus-4-8  | hard reasoning, architecture, tricky debugging      |
| 4    | claude-fable-5   | big multi-file migrations, long autonomous runs     |

## How chat recall works

Claude Code already stores history per project under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. This app reads that
(read-only), lists past chats with titles + timestamps, and reopens any chat with
`claude --resume <session-id> --model <chosen-model>` in the project's directory.
Nothing is copied or stored by this app.

## Try the core now

```bash
npm run route -- "migrate our Express routes to Fastify across the repo"
npm run route -- "fix the typo in the header"
npm run route:test          # run the built-in routing cases
npm run projects            # list your projects and recent chats
```

Add `--no-classifier` to route with local rules only (no network call).
