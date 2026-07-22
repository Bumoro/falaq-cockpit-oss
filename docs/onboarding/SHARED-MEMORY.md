# SHARED-MEMORY.md — a persistent, shared memory system for multiple AI agents

This is the memory architecture we run alongside the cockpit. It gives every Claude Code (or Codex) session on a machine the **same durable memory**, so parallel agents don't re-learn, contradict, or duplicate each other's knowledge. It's plain Markdown files — no database, no service, works with Claude Code's built-in auto-memory.

## How it looks

```
~/.claude/projects/<project-slug>/memory/
├── MEMORY.md                        ← the INDEX — one line per memory, loaded every session
├── user_preferences.md              ← who the user is, how they like to work
├── project_billing_revamp.md        ← one ongoing project = one file
├── reference_deploy_pipeline.md     ← one durable fact/runbook = one file
├── feedback_verify_before_done.md   ← one correction the user gave = one file
└── hub_payments.md                  ← a topic hub indexing many related memories
```

Every memory file is **one fact**, with frontmatter:

```markdown
---
name: reference-deploy-pipeline
description: One-line summary used to decide relevance during recall
metadata:
  type: user | feedback | project | reference
---

The fact itself. Keep it dense and factual. Convert relative dates ("last week")
to absolute ones. Link related memories with [[their-name]].

**Why:** (for feedback/project types) the reason behind the rule.
**How to apply:** what an agent should actually do differently.
```

`MEMORY.md` is the only file loaded into every session's context automatically, so it stays an index — **one line per memory, never content**:

```markdown
# Claude Memory
## Preferences
- [Practical, action-oriented output](user_preferences.md) — automate over manual
## Projects
- [Billing revamp](project_billing_revamp.md) — phase 2 open; resume: "Continue billing phase 2"
## References
- [Deploy pipeline](reference_deploy_pipeline.md) — CI gates prod; red trunk = deploys skip
## Feedback
- [Verify before "done"](feedback_verify_before_done.md) — never claim done without running it
```

When a topic accumulates 8+ memories, create a `hub_<topic>.md` that indexes them and collapse the MEMORY.md lines into one hub line. This keeps the always-loaded index small while deep context stays one hop away.

## How multiple agents share it

- **Same machine, same files.** Every session (and every subagent) for a project reads and writes the same memory directory. Agent A's hard-won gotcha at 10am is in Agent B's context at 2pm — the cockpit shows you they're separate sessions, the memory makes them one brain.
- **Session logs are the short-term handoff.** Durable facts go to memory; *state* ("where I stopped, exact file paths, what's next, one-line resume prompt") goes to a dated session log (`~/Documents/Claude Sessions/YYYY-MM/YYYY-MM-DD.md`). Next session — any agent — starts by reading the latest log. The cockpit's controlled chats inject this protocol automatically.
- **Write rules that keep it trustworthy:**
  - Before saving, check whether an existing memory covers it — **update instead of duplicating**; delete memories that turn out wrong.
  - Don't store what the repo already records (code structure, git history) or what only matters to this conversation.
  - After merging work, prune: mark shipped things shipped, drop stale "open" notes. The goal is `git == truth` and `memory == truth`.
  - Memories reflect when they were written — agents should verify a recalled file/flag still exists before acting on it.

## How to set it up

1. Claude Code creates `~/.claude/projects/<project>/memory/` automatically. Seed the index:
   ```bash
   mkdir -p ~/.claude/projects/<project>/memory
   printf '# Claude Memory\n\n## Preferences\n\n## Projects\n\n## References\n\n## Feedback\n' \
     > ~/.claude/projects/<project>/memory/MEMORY.md
   ```
2. Add the habit to your global `~/.claude/CLAUDE.md` (full template in [SYSTEM.md](SYSTEM.md)): sessions start by reading the latest session log, end by writing one; durable facts become memory files + an index line.
3. Create the session-log folder: `mkdir -p ~/Documents/Claude\ Sessions/$(date +%Y-%m)`.
4. Optional: point your agent at this file and say *"set up the shared memory system described here"* — it's written to be agent-executable.

## Why this design

- **Index + leaf files** beats one big memory file: the always-loaded part stays tiny (cheap tokens), while detail loads only when relevant.
- **One fact per file** makes updates surgical and merge-conflict-free when several agents write in the same hour.
- **Typed memories** (`user/feedback/project/reference`) let an agent weigh them: feedback overrides defaults, references get verified, projects get resumed.
- **Plain Markdown** means you can read, edit, grep, and version it yourself — no lock-in, no schema migration, and it survives any tool change.
