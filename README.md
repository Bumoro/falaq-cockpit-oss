# Falaq Cockpit

A local mission-control dashboard for AI-agent work. It watches every Claude Code session on your machine (live state, context usage, pending approvals), shows Codex background work, and lets you start and drive **controlled chats** — including a safe-mode, non-dev-friendly chat view — all from a browser tab.

Everything runs **on your own machine**: a small plain-Node server bound to `127.0.0.1:3847`. No cloud, no external services required.

## What you get

| Surface | URL | What it is |
|---|---|---|
| Mission control | `http://localhost:3847/live` | One card per Claude Code session: RUNNING / NEEDS-YOU / IDLE states, context bars, approval buttons on the card, controlled-chat panel with live terminal + full transcript |
| Friendly chat | `http://localhost:3847/chat` | A Claude-app-style chat view (no terminal, no dev affordances). New chats here run in **safe mode** — a hardened permission profile |
| Workers row | on `/live` | Codex background tasks (read from `~/.codex/sessions` rollouts) + live subagents |

## Quickstart

The intended install path is **agent-executed**: open Claude Code on your machine and tell it:

> Read docs/onboarding/INSTALL.md in this repo and follow it.

Manual path, if you prefer:

```bash
git clone https://github.com/Bumoro/falaq-cockpit-oss.git && cd falaq-cockpit
./install.sh --merge-hooks   # installs to ~/.claude/agent-dashboard, seeds config, wires the
                             # Claude Code hooks (with a backup of your settings), starts the server
```

Session cards only appear once the hooks are wired, so `--merge-hooks` is the normal first install. (Plain `./install.sh` installs and starts the server but only *prints* the hook block for you to merge yourself — use it if you'd rather not touch `settings.json` automatically.)

Then open `http://localhost:3847/live`, start a **new** Claude Code session anywhere, and watch its card appear (the session you ran the install from won't show — hooks load at session start).

- **Install / onboarding:** `docs/onboarding/INSTALL.md` (written for your AI agent to execute)
- **The team working system (CLAUDE.md conventions, memory, session logs):** `docs/onboarding/SYSTEM.md`
- **Codex-primary users:** `docs/onboarding/CODEX.md`
- **Updating an existing install:** `./deploy.sh` (tests → sync → restart → verify)

## Requirements

macOS (Linux mostly works; the optional desktop launcher is macOS-only). Node ≥ 20. `tmux` + the `claude` CLI for controlled chats (monitoring works without them). Optional extras: `ccusage` (usage gauges), `gh` + a Slack incoming webhook (watchers/notifications — disabled by default).

## Security posture

- Server binds `127.0.0.1` only — never exposed to the network.
- Mutating routes require a per-install token (`~/.claude/agent-dashboard/.token`, mode 0600, auto-generated).
- Safe-mode chats launch Claude with a deny-first permission profile (`src/nondev-profile.json`) in a fresh throwaway workspace: no shell, no exfil-capable readers, writes jailed to the workspace. Deny floors resolve to **your** home at launch time.

## License & contributing

MIT — see [LICENSE](LICENSE). Built by [Falaq](https://falaq.solutions) and open-sourced because it might be useful to others running fleets of AI-agent sessions. Issues and PRs welcome; keep additions self-contained (plain Node, no new runtime deps) and fail-soft. If you find it useful, a star helps others find it.
