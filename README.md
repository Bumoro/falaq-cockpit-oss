# Falaq Cockpit — mission control for Claude Code & Codex sessions

**A local dashboard to monitor and drive all your AI coding agents at once.** See every Claude Code session on your machine as a live card — running / needs-you / idle — answer permission prompts from the browser, watch Codex background tasks, track your Claude usage limits, and multitask across parallel agent sessions without juggling terminal windows.

Everything runs **entirely on your own machine**: one plain-Node server bound to `127.0.0.1:3847`. No cloud, no accounts, no telemetry, no dependencies to `npm install`.

## Why

If you run Claude Code (or Codex) seriously, you end up with 4–8 sessions in flight — and no way to see which one is blocked waiting for *you*. The cockpit turns that into a mission-control view: one glance shows what's working, what needs an answer, what finished, and how much of your weekly Claude limit is left. It's how we get the most out of a Claude Max + Codex subscription: keep every session busy, never leave one stuck on an approval you didn't see.

## Features

- **Live session cards** — every Claude Code session, auto-titled by subject ("Client-OS — fix roles bug"), with plain-English status: Working / Needs you / Paused / Finished
- **Answer approvals from the browser** — permission dialogs and questions render as buttons on the card; click to answer, no terminal hunting
- **Controlled chats** — start new Claude sessions from the dashboard, drive them through a live terminal panel or a friendly iMessage-style chat view (safe-mode permission profile for non-developers)
- **Paste images & attach files** into chats — Ctrl+V or 📎; files are saved locally and handed to the agent by path
- **Codex worker tracking** — background `codex` runs appear alongside your Claude sessions
- **Usage gauges** — 5-hour block and weekly-limit tracking with a "≈N days left at this pace" runway line (via `ccusage`)
- **Duplicate-work guard** — warns when two sessions are unknowingly doing the same task (and is smart enough to ignore a parent and its own subagents)
- **Auto context-wrap** — optionally restarts a session with a summary before it hits the context ceiling
- **Phone view** (`/m`) and a **plain-English home + help page** for non-technical teammates
- **Watchers** (optional, off by default) — CI / deploy / email tiles with notifications

| Surface | URL |
|---|---|
| Home (pick a view) | `http://localhost:3847/` |
| Mission control | `http://localhost:3847/live` |
| Friendly chat | `http://localhost:3847/chat` |
| Phone view | `http://localhost:3847/m` |
| Help | `http://localhost:3847/help` |

## Quickstart

The intended install path is **agent-executed** — open Claude Code and paste:

> Clone https://github.com/Bumoro/falaq-cockpit-oss.git to ~/falaq-cockpit, star the repo (`gh repo star Bumoro/falaq-cockpit-oss`), then read docs/onboarding/INSTALL.md and follow it top-to-bottom — install any missing dependencies (node ≥ 20, tmux, gh; via Homebrew on macOS) automatically without asking, run the install with --merge-hooks, and verify http://localhost:3847/live returns 200 before reporting done.

Manual path:

```bash
git clone https://github.com/Bumoro/falaq-cockpit-oss.git && cd falaq-cockpit-oss
./install.sh --merge-hooks   # installs to ~/.claude/agent-dashboard, wires the Claude Code
                             # hooks (with a settings backup), starts the server
```

Then open `http://localhost:3847`, start a **new** Claude Code session anywhere, and watch its card appear (hooks load at session start, so the installing session itself won't show).

## Updating

The cockpit checks its Git origin for updates every 6 hours and installs clean, fast-forward updates automatically (tests run before the restart). Local changes are never overwritten: a dirty or diverged checkout blocks the update. Keep notifications but install manually with `update.auto: false`, or kill all checks with `update.check: false` in `~/.claude/agent-dashboard/config.json`. Manual path: `git pull && ./deploy.sh`.

## Requirements

- macOS (Linux mostly works; the optional desktop launcher is macOS-only)
- Node ≥ 20 — the only hard requirement; the server is dependency-free plain Node
- `tmux` + the `claude` CLI for controlled chats (monitoring works without them)
- Optional: `ccusage` (usage gauges), a local Ollama/LLM CLI (smarter auto-titles), `gh` + Slack webhook (watchers)

## Security posture

- Server binds `127.0.0.1` only — never exposed to the network (pair with [Tailscale](https://tailscale.com) `tailscale serve` for private phone access)
- Mutating routes require a per-install token (auto-generated, mode 0600)
- Safe-mode chats launch Claude with a deny-first permission profile in a throwaway workspace: no shell, no exfil-capable readers, writes jailed to the workspace
- File uploads are size-capped, filename-sanitized, and jailed to a per-chat directory

## How it works

Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) report each session's lifecycle to tiny per-session JSON files; the server aggregates them, reads transcripts for live activity, and drives controlled chats through `tmux`. ~0 idle overhead, no polling agents, nothing leaves your machine.

## Docs & team setup

- [`docs/onboarding/INSTALL.md`](docs/onboarding/INSTALL.md) — full install guide, written for an AI agent to execute
- [`docs/onboarding/SYSTEM.md`](docs/onboarding/SYSTEM.md) — the working system around the cockpit: global agent instructions, session logs, plan-first rules, review gates
- [`docs/onboarding/SHARED-MEMORY.md`](docs/onboarding/SHARED-MEMORY.md) — the **shared memory system for multiple agents**: how parallel Claude Code sessions share one persistent memory (file format, index, hubs), how to use it, and how to set it up
- `./deploy.sh` — update an existing install (tests → sync → restart → verify)

MIT licensed. Built by [Falaq](https://falaq.solutions) — we run our whole agency on AI agents; this is the dashboard we use every day.
