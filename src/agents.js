// agents.js — detect ACTIVE subagents per session by scanning the session's subagents/ dir for
// freshly-updated agent-*.jsonl transcripts. This is HOOK-INDEPENDENT: background async agents never
// fire SubagentStart/Stop in Claude Code 2.1.204 (so the hook's agents[] misses them), but they DO
// stream a transcript. A fresh mtime = an actively-running agent. Fixes two things:
//   1. a session waiting on a dispatched (background) agent no longer shows "stale"
//   2. those agents appear in the Workers row / on the card
// Read-only, never throws, zero deps.
const fs = require('fs');
const path = require('path');
const os = require('os');

function projectsRoot() { return process.env.CK_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'); }

// ~/.claude/projects/<proj>/<session>.jsonl  ->  ~/.claude/projects/<proj>/<session>/subagents
function subagentsDir(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  return transcriptPath.slice(0, -'.jsonl'.length) + '/subagents';
}

// agent-<id>.meta.json sits next to the transcript: { agentType, description, ... }
function readMeta(dir, id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'agent-' + id + '.meta.json'), 'utf8'));
    return {
      type: String((m && (m.agentType || m.type || m.subagent_type)) || 'agent').slice(0, 40),
      desc: String((m && m.description) || '').slice(0, 80),
    };
  } catch (e) { return { type: 'agent', desc: '' }; }
}

// Active agents for a session: agent-*.jsonl whose mtime is within freshMs. Each: {id, type, desc, at}.
function activeAgents(transcriptPath, opts) {
  opts = opts || {};
  const freshMs = opts.freshMs || 120 * 1000; // an agent mid-tool-call can be quiet a while; be generous
  const now = opts.now || Date.now();
  const dir = subagentsDir(transcriptPath);
  if (!dir) return [];
  // defense-in-depth: transcriptPath is local session state, but a poisoned session file shouldn't make
  // us stat an arbitrary <path>/subagents — only ever scan under the projects root. (path.resolve folds
  // any `..`; no realpath needed since this isn't attacker-controlled HTTP input.)
  const root = projectsRoot(), rd = path.resolve(dir);
  if (rd !== root && !rd.startsWith(root + path.sep)) return [];
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  let scanned = 0;
  for (const f of files) {
    if (++scanned > 400) break; // bound worst-case sync work per /api/sessions call
    const m = /^agent-([A-Za-z0-9]+)\.jsonl$/.exec(f);
    if (!m) continue;
    let mt; try { mt = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { continue; }
    if (now - mt > freshMs) continue; // not fresh -> finished/idle
    const meta = readMeta(dir, m[1]);
    out.push({ id: m[1].slice(0, 40), type: meta.type, desc: meta.desc, at: Math.round(mt) });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, 12);
}

module.exports = { activeAgents, subagentsDir };
