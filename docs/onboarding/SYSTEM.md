# SYSTEM.md — the Falaq working system, for your agent to install

**Audience:** the teammate's AI agent, after finishing `INSTALL.md`. This sets up *how we work*: global instructions, session logs, memory, and the gate habit. Everything below is a generic template — adapt the `<PLACEHOLDER>` values to your own accounts and paths.

## 1. Install the global instructions template

Merge the template below into the user's `~/.claude/CLAUDE.md`. If the file exists, **merge, don't clobber**: keep their existing content, add missing sections. Replace every `<PLACEHOLDER>` after asking your human for their preference (offer the defaults shown).

```markdown
# Falaq — Working Instructions

## Session Protocol
### Start
- Read the latest session log in <SESSIONS_DIR, default ~/Documents/Claude Sessions/>YYYY-MM/ for context and exact file paths from last time.
- For coding tasks: `git status` is the source of truth for the active project path.
### End (every session, automatic — don't ask)
- Write a session log to <SESSIONS_DIR>/YYYY-MM/YYYY-MM-DD-<topic>.md: what was done, exact file paths, commits, what's open, and a one-line "Resume:" prompt.
### Low context
- Save the session log early and tell me exactly what to say to continue.

## Work Rules
### 1. Plan Mode First — Always
- Enter plan mode before ANY new work. Confirm file paths and outline steps before touching code.
- Resuming already-planned work: pick up from the session log; don't re-plan.
- Hit the same problem twice → STOP, write down what's failing, re-plan from scratch.
### 2. Correct File Path — Always
- Never assume file paths. Latest session log first; `git status` to verify.
### 3. Model Routing & Efficiency
- Main conversation (planning/review/coordination): strongest model. Execution agents: mid-tier (Sonnet). Search/exploration agents: small tier (Haiku). Review agents: strongest.
- Tool-first, agent-second. Background agents for non-blocking work. Worktrees for parallel coding. Cascade, don't serialize.
### 4. Handoff & review — coordinate, implement, review
- **Coordinate/implement split (optional but recommended):** the strongest model plans the work and writes a handoff (file paths, exact changes, acceptance criteria); an implementer (e.g. Codex) writes the code; the coordinator reviews. If you work solo, still separate the hats.
- **Independent review before "done":** non-trivial changes get a review pass with the *author excluded* — a second model or a fresh agent. A blocking finding pauses the merge.
- **Verify end-to-end:** never claim "done" without exercising the change (run it, click it, or test it). Say exactly what was and wasn't verified.
### 5. Gates — Never Idle on a Human
- Work blocked on a human-only action (merge to prod, OAuth/2FA login, secrets, payments)? Record a gate: title starting `🔒 GATE:` with the exact action, exact command/link, one line of context, and the risk if delayed. <GATE_TARGET, default: a GATES.md in the repo — or a task in your PM tool if its MCP is connected>. Then switch to the next workstream or close the session cleanly. Never sit idle waiting.

## Falaq Cockpit
- Dashboard at http://localhost:3847/live (sessions, approvals, controlled chats) and /chat (friendly view). Installed per ~/falaq-cockpit/docs/onboarding/INSTALL.md. Update with `cd ~/falaq-cockpit && git pull && ./deploy.sh`.
```

**Verify:** re-read `~/.claude/CLAUDE.md` and confirm the user's pre-existing content is intact and the new sections are present.

## 2. Bootstrap memory

Claude Code keeps per-project auto-memory under `~/.claude/projects/<project>/memory/`. Seed the habit:

1. Ensure the memory directory for the user's main working directory exists (Claude Code creates it on first use — nothing to do if present).
2. Create `MEMORY.md` there if absent, with a starter index:
   ```markdown
   # Claude Memory
   ## Preferences
   ## Projects
   ## References
   ```
3. The rule to follow from now on: durable facts (who the user is, project state, hard-won gotchas, tool quirks) get their own memory file + one index line. Session-specific detail goes in session logs, not memory.

## 3. Session logs — the habit that makes everything resumable

Create the folder now: `mkdir -p <SESSIONS_DIR>/$(date +%Y-%m)`. Every session ends with a log (see template above). The log is the contract between sessions: next session starts by reading it. This is not optional ceremony — the cockpit's "Wrap & Save" button injects exactly this protocol into controlled chats.

## 4. Optional integrations (set up only what you actually use)

The working system pairs well with a few external tools, but none are required — the cockpit and the core workflow run without any of them. Wire up only what fits your setup:

| Piece | What it is | Your action |
|---|---|---|
| A knowledge/notes tool (e.g. NotebookLM, a wiki) | Long-term memory of sessions/decisions across chats | Optional — point your session logs at it, or skip |
| A PM / task tracker (via its MCP, if it has one) | Where GATE tasks and work items live | Optional — use it as your `GATE_TARGET`; otherwise a `GATES.md` in the repo works |
| A private "agents" repo | Role-specialized subagent definitions + routing | Optional — only if your team maintains one |
| Token-proxy / mail / review CLIs | Local dev conveniences | Optional; the system works without them |
| A notes vault | Where session logs live | Use any directory as your `<SESSIONS_DIR>` |

## 5. Done

Report to your human: CLAUDE.md merged (what was added), memory seeded, sessions folder at <SESSIONS_DIR>, gates target chosen, cockpit URLs. Then write your first session log — this setup session is session one.
