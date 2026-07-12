# CODEX.md — for teammates whose primary agent is Codex (or anything non-Claude)

The cockpit is agent-agnostic for *viewing*, but its deepest integrations are Claude Code-specific. Here is the honest capability matrix so you know what you get.

## What works with Codex alone

- **Workers row on `/live`:** the cockpit polls `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (read-only, mtime-freshness) and shows your active Codex tasks — id, cwd, client label — with zero setup beyond `./install.sh`. No hooks needed.
- Everything server-side that doesn't depend on session hooks: `/live` itself, usage gauges (via `ccusage`, which reads Claude usage — see below), watchers (if you configure them).

## What needs Claude Code installed

| Feature | Why |
|---|---|
| Session cards (RUNNING / NEEDS-YOU, context bars, approval buttons) | Fed by Claude Code hooks (`session-hook.js`) — there is no Codex hook equivalent; Codex visibility is the rollout poller above |
| Controlled chats (New Chat, live terminal, keyboard passthrough) | The launcher spawns `claude` in tmux |
| `/chat` friendly view + safe-mode chats | Renders Claude session transcripts; safe mode is a Claude `--settings` permission profile |
| Usage gauges | `ccusage` reads Claude Code usage data |

## Recommended setup for a Codex-primary teammate

1. Run `docs/onboarding/INSTALL.md` anyway — the server + Workers row give you value immediately.
2. **Also install Claude Code** (free tier is enough to start) and merge the hooks. Even if Codex writes your code, a Claude session as your coordinator gets you: cards, approvals-on-card, the friendly `/chat`, and safe-mode chats for non-dev tasks. This mirrors how the team works anyway (Claude coordinates/reviews, Codex implements — see the "Handoff & review" work rule in `docs/onboarding/SYSTEM.md`).
3. If you will *never* run Claude Code: expect `/live` to show only the Workers row and any chats other tools create; session cards will stay empty. That's a supported, if thin, configuration.

## Other agents (Gemini CLI, etc.)

Not integrated today. The pattern to add one is `src/codex.js` — a read-only poller over the tool's on-disk session artifacts. PRs welcome; keep it read-only and fail-soft.
