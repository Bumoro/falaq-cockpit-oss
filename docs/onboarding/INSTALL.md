# INSTALL.md — Cockpit setup, written for your AI agent

**Audience:** the Claude Code (or other agent) session that a Falaq teammate has opened on their own machine and pointed at this file. Execute it top-to-bottom. Every step has a verification — do not skip verifications, and report each ✅/❌ to your human as you go.

**What you are installing:** a local dashboard server (plain Node, binds `127.0.0.1:3847`) plus Claude Code hooks that report session state to it. Nothing leaves the machine.

---

## 0. Prerequisites — check, don't assume

Run each check; install what's missing before continuing.

```bash
sw_vers 2>/dev/null || uname -a        # macOS expected (Linux mostly works; no desktop launcher)
node --version                          # need ≥ 20; install: brew install node
tmux -V                                 # need ≥ 3.4; install: brew install tmux  (controlled chats only)
claude --version                        # Claude Code CLI, logged in (controlled chats only)
git --version
```

- `node` is **required**. `tmux` + `claude` are needed only for controlled "New Chat" sessions — monitoring works without them; warn your human and continue if absent.
- The repo is public — no access request needed to clone.

## 1. Clone and install

```bash
git clone https://github.com/Bumoro/falaq-cockpit-oss.git ~/falaq-cockpit
cd ~/falaq-cockpit
./install.sh
```

`install.sh` is idempotent and never overwrites existing config/state. It will: create `~/.claude/agent-dashboard/` (the "mirror" — the deployed copy the server runs from), sync the runtime files, seed `config.json` + `watchers/watcher-config.json` from templates **only if absent**, generate the hook-wiring block at `~/.claude/agent-dashboard/generated-hooks.json`, and start the server.

**Verify:**
```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3847/live    # → 200
```

## 2. Wire the Claude Code hooks

The dashboard learns about sessions from Claude Code hooks. Two options:

**Option A (recommended) — let the installer merge them, with a backup:**
```bash
./install.sh --merge-hooks
```
This backs up `~/.claude/settings.json` to `settings.json.bak-cockpit-<timestamp>` and appends the cockpit hook entries idempotently (running it twice changes nothing).

**Option B — merge yourself:** read `~/.claude/agent-dashboard/generated-hooks.json` and merge each event's entries into the `hooks` section of `~/.claude/settings.json`, preserving everything already there.

**Verify:**
```bash
node ~/falaq-cockpit/src/install-hooks.js --check && echo HOOKS-OK
```

⚠️ Hooks are read **at session start** — this very session will not appear on the dashboard. That's expected.

## 3. End-to-end verification

1. Open `http://localhost:3847/live` in the browser.
2. Start a **new** Claude Code session in any project (`claude` in a repo, say "hi", let it respond).
3. Within ~5s a card for that session appears on `/live`. Also confirm via API:
   ```bash
   curl -s http://127.0.0.1:3847/api/sessions | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(s.length+" session(s):",s.map(x=>x.client+" "+x.state).join(", "))})'
   ```
4. If `tmux` + `claude` are installed: on `/live` click **New Chat**, create one (any title), confirm the chat panel shows the live Claude screen. Then open `http://localhost:3847/chat`, pick it, send a message, get a reply.
5. Safe mode: from `/chat` press **+ New chat** — this launches a hardened, deny-first profile in a throwaway workspace. Ask it to run a shell command → it must ask for approval (buttons appear on its card in `/live`), not run silently.

All green → tell your human the cockpit is live and where: `http://localhost:3847/live` (dev view) and `/chat` (friendly view).

## 4. Personalize

Edit `~/.claude/agent-dashboard/config.json` → `clientMap`: map repo **directory names** to display names, e.g. `"acme-shop": "ACME"`. Cards are labeled by matching the session's cwd against these keys. Re-edit anytime; no restart needed.

Optional extras (all off/absent by default — skip freely):
- **Usage gauges** (5h/weekly token cost on `/live`): `npm i -g ccusage`.
- **Watchers** (CI/deploy/email tiles): depend on external tools (`gh`, a mail CLI, a Slack webhook). They ship **disabled** (`watchers/watcher-config.json` → `"enabled": false`). Only enable after configuring your own repos/accounts there.
- **Desktop launcher:** macOS-only AppleScript app; optional and finicky (see gotchas in `docs/plans/`). The server autostarts via the SessionStart hook anyway.

## 5. The team working system

Now read **`docs/onboarding/SYSTEM.md`** and set up the Falaq working conventions (global CLAUDE.md template, session logs, memory). That file is also written for you, the agent.

## 6. Updating later

```bash
cd ~/falaq-cockpit && git pull && ./deploy.sh
```
`deploy.sh` runs the test suite, syncs the runtime files atomically, restarts the true listener, and verifies. Never edit files in `~/.claude/agent-dashboard/` directly — they get overwritten; change the repo and deploy.

---

## Troubleshooting (learned the hard way)

| Symptom | Cause / fix |
|---|---|
| `install.sh`: "Cockpit already running on port 3847 — use ./deploy.sh" | Our cockpit already holds the port (install curl'd `/live` and got 200). Expected on re-installs. To update code: `./deploy.sh`. |
| `install.sh`: "port 3847 is held by another process" | Something that isn't the cockpit is squatting the port. Free it (`lsof -nP -iTCP:3847 -sTCP:LISTEN`) or install on another port (see the custom-port note below). Install exits non-zero here rather than falsely reporting success. |
| `/live` 200 but new sessions show no card | Hooks not merged, or session started before merging. `node src/install-hooks.js --check`; start a fresh session. Also check `~/.claude/agent-dashboard/error.log`. |
| EADDRINUSE in error.log / server won't start | Find the real listener: `lsof -nP -iTCP:3847 -sTCP:LISTEN`. Kill stray `agent-dashboard/server.js` pids with plain `kill <pid>` (never `kill -9`/`pkill`), then `node ~/.claude/agent-dashboard/start.js`. |
| New Chat fails: "tmux new-session failed" | `tmux` missing or too old (`brew install tmux`; need ≥3.4 for `-e`). |
| New Chat opens but never types the prompt | The `claude` CLI isn't logged in, or the first-run trust dialog changed wording (the launcher auto-accepts known variants). Attach to inspect: `tmux attach -t ck-<name>`. |
| Chat panel screen is blank for ~10s after creation | Normal — tmux window renames during Claude startup; capture returns transiently empty. |
| Watcher tiles show `error` | Expected if you enabled watchers without the underlying tools (`gh`, `gmailx`). Disable again or configure them. |
| Usage gauges blank | `ccusage` not installed — optional. |
| Port conflict with something else on 3847 | **Prefer freeing 3847** — a custom port is not fully persistent. `AGENT_DASHBOARD_PORT=<port> ./install.sh` starts the server there *now*, but the SessionStart hook runs `start.js` with no port, so the next Claude session autostarts on the default 3847. To make a custom port stick you must export `AGENT_DASHBOARD_PORT` in your shell profile so every session's hook inherits it (and the `/live` UI still assumes 3847). Freeing 3847 avoids all of this. |

Anything else: `~/.claude/agent-dashboard/error.log` first, then the docs in `docs/plans/` (design history, including every gotcha and why the code is shaped the way it is).
