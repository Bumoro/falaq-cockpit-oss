#!/usr/bin/env node
// session-hook.js — maintains sessions/<session_id>.json from Claude Code lifecycle hooks.
// Fed by: SessionStart, UserPromptSubmit, PostToolUse, Notification, Stop,
// SubagentStart, SubagentStop, SessionEnd. Never blocks: always exits 0, fast.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = process.env.COCKPIT_DIR || __dirname;
const SESSIONS_DIR = path.join(DIR, 'sessions');
const THROTTLE_MS = 5000;
const CLEANUP_AGE_MS = 48 * 60 * 60 * 1000;

function resolveClient(cwd, dir) {
  if (!cwd) return 'unknown';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    for (const [needle, name] of Object.entries(cfg.clientMap || {})) {
      if (cwd.toLowerCase().includes(needle.toLowerCase())) return name;
    }
  } catch (e) {}
  return path.basename(cwd) || 'unknown';
}

function cleanupOld(now) {
  // prune session files older than 48h so the dir never grows unbounded
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      const p = path.join(SESSIONS_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > CLEANUP_AGE_MS) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
}

try {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  const id = data.session_id;
  const evt = data.hook_event_name;
  if (!id || !evt) process.exit(0);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, id + '.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}

  const now = Date.now();
  s.sessionId = id;
  if (data.cwd) s.cwd = data.cwd;
  if (data.transcript_path) s.transcriptPath = data.transcript_path;
  s.client = resolveClient(s.cwd, DIR);
  // New controlled chats export CK_CHAT=<name> (chats.js `-e`); the hook, a child of the Claude
  // process, inherits it. Cheap env read — safe to do on every event. (The tmux-name fallback for
  // marker-less chats runs later, AFTER the early-exit paths — see deriveChatNameFromTmux below.)
  if (process.env.CK_CHAT) s.chatName = String(process.env.CK_CHAT).slice(0, 44);

  switch (evt) {
    case 'SessionStart':
      if (!s.startedAt) s.startedAt = now;
      if (data.model) s.model = data.model;
      s.state = 'running';
      s.needsYou = null;
      cleanupOld(now);
      break;
    case 'UserPromptSubmit': {
      s.state = 'running';
      s.needsYou = null;
      const prompt = String(data.prompt || data.prompt_text || '').slice(0, 140);
      if (prompt) s.lastPrompt = prompt;
      break;
    }
    case 'PostToolUse':
      if (s.state === 'needs_you') {
        // A permission-dialog approval doesn't fire UserPromptSubmit; the next
        // tool use proves the session is unblocked, so clear needs_you here
        // and skip the throttle (this transition must always be recorded).
        s.state = 'running';
        s.needsYou = null;
      } else {
        if (s.lastActivityAt && now - s.lastActivityAt < THROTTLE_MS && s.lastTool === data.tool_name) {
          process.exit(0);
        }
        s.state = 'running';
      }
      s.lastTool = data.tool_name || s.lastTool;
      break;
    case 'Notification':
      s.state = 'needs_you';
      s.needsYou = {
        at: now,
        message: String(data.message || data.notification_type || data.title || 'needs attention').slice(0, 200),
      };
      break;
    case 'Stop':
      if (s.state !== 'needs_you') s.state = 'idle';
      break;
    case 'SubagentStart':
      // agent_id/agent_type come from the subagent context (session_id here is the PARENT).
      s.subagents = (s.subagents || 0) + 1;
      s.agents = s.agents || [];
      if (data.agent_id && !s.agents.some(a => a.id === data.agent_id)) {
        s.agents.push({ id: data.agent_id, type: String(data.agent_type || 'agent').slice(0, 40), at: now });
      }
      s.agents = s.agents.slice(-12);
      break;
    case 'SubagentStop':
      s.subagents = Math.max(0, (s.subagents || 0) - 1);
      if (data.agent_id) s.agents = (s.agents || []).filter(a => a.id !== data.agent_id);
      // self-heal: if an id was ever missing, keep the list from out-growing the live count.
      // NB: use an explicit 0-case — `[].slice(-0)` returns the WHOLE array, not [].
      if (s.agents && s.agents.length > s.subagents) s.agents = s.subagents > 0 ? s.agents.slice(-s.subagents) : [];
      break;
    case 'SessionEnd':
      s.state = 'ended';
      s.endedAt = now;
      s.agents = [];
      s.subagents = 0;
      break;
    default:
      process.exit(0);
  }

  // Legacy controlled chats (started before the CK_CHAT marker) still run inside a `ck-*` tmux pane —
  // derive the pane's session name so they link (Full-log + dedup) with no restart. Placed AFTER the
  // switch, so it runs ONLY on events that reach the file-write below: the throttled-PostToolUse and
  // `default` paths already `process.exit(0)` above, so this tmux call never fires on the hot path and,
  // guarded by the now-persisted `_tmuxTried`, runs at most once per session.
  if (!s.chatName && process.env.TMUX_PANE && !s._tmuxTried) {
    s._tmuxTried = true;
    try {
      const tmuxBin = process.env.CK_TMUX_BIN || (fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux');
      const nm = execFileSync(tmuxBin, ['display-message', '-p', '-t', process.env.TMUX_PANE, '#S'],
        { encoding: 'utf8', timeout: parseInt(process.env.CK_TMUX_TIMEOUT, 10) || 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^ck-[a-z0-9-]{1,40}$/.test(nm)) s.chatName = nm;
    } catch (e) {}
  }

  s.lastActivityAt = now;
  const tmpFile = file + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(s));
  fs.renameSync(tmpFile, file);
} catch (e) {
  // never block Claude
}
process.exit(0);
