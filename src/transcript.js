// transcript.js — render a Claude Code session transcript (.jsonl) as readable, scrollable text.
// The controlled-chat live view only shows the current full-screen TUI frame (tmux keeps no
// scrollback for an alternate-screen app), so "read the whole session" is served from the
// transcript instead. Read-only, sandboxed to ~/.claude/projects, never throws. Zero deps.
const fs = require('fs');
const path = require('path');
const os = require('os');

const transcriptMemo = new Map();
const MEMO_CAP = 32;

// Cached arrays are returned by reference; callers must not mutate transcript results.
function memoized(kind, real, readCap, empty, compute) {
  let st;
  try { st = fs.statSync(real); } catch (e) { return empty; }
  const key = kind + '\0' + real + '\0' + readCap;
  const hit = transcriptMemo.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    transcriptMemo.delete(key);
    transcriptMemo.set(key, hit);
    return hit.result;
  }
  let result;
  try { result = compute(); } catch (e) { return empty; }
  transcriptMemo.delete(key);
  transcriptMemo.set(key, { mtimeMs: st.mtimeMs, size: st.size, result });
  while (transcriptMemo.size > MEMO_CAP) transcriptMemo.delete(transcriptMemo.keys().next().value);
  return result;
}

function projectsRoot() { return process.env.CK_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'); }

// Resolve `file` to its realpath and return it ONLY if it lands inside ~/.claude/projects, else null.
// This is the security gate for the token-authenticated /api/chats/:name/transcript route: without it,
// a caller could pass ?path= to read any file on disk. realpath both sides so symlinks can't escape the
// jail. Callers read the RETURNED realpath (not the original string) — resolving once and reading the
// canonical path closes the check-then-open (TOCTOU) window a symlink swap could otherwise slip through.
function resolveInJail(file) {
  if (!file || typeof file !== 'string') return null;
  let real, root;
  try { real = fs.realpathSync(file); } catch (e) { return null; }
  try { root = fs.realpathSync(projectsRoot()); } catch (e) { return null; }
  return (real === root || real.startsWith(root + path.sep)) ? real : null;
}
function isAllowed(file) { return resolveInJail(file) !== null; }

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function hhmm(ts) {
  // ts is an ISO string on each transcript line; render a compact local HH:MM. Bad/absent -> ''.
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// Bounded raw read shared by readTranscript/parseTranscript: whole file if small, else the LAST
// readCap bytes with the partial first line dropped. Throws propagate to the caller's catch.
function readBounded(real, readCap) {
  const st = fs.statSync(real);
  if (st.size <= readCap) return { raw: fs.readFileSync(real, 'utf8'), tailed: false };
  const fd = fs.openSync(real, 'r');
  let raw;
  try {
    const buf = Buffer.alloc(readCap);
    const n = fs.readSync(fd, buf, 0, readCap, st.size - readCap);
    raw = buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
  const nl = raw.indexOf('\n');
  return { raw: nl >= 0 ? raw.slice(nl + 1) : raw, tailed: true };
}

// Turn one transcript line into 0+ display lines. Only user/assistant turns are rendered; the noisy
// bookkeeping types (mode, permission-mode, attachment, file-history-snapshot, ai-title, system,
// queue-operation, last-prompt) and the verbose blocks (thinking, tool_result) are dropped.
function renderLine(o, opts) {
  const t = o && o.type;
  if (t !== 'user' && t !== 'assistant') return [];
  const m = o.message; if (!m || typeof m !== 'object') return [];
  const who = t === 'user' ? '❯ you' : '● claude';
  const time = hhmm(o.timestamp);
  const head = (time ? '[' + time + '] ' : '') + who + ': ';
  const c = m.content;
  const out = [];
  if (typeof c === 'string') {
    if (c.trim()) out.push(head + clip(c, opts.maxText));
    return out;
  }
  if (!Array.isArray(c)) return [];
  let saidHead = false;
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text && b.text.trim()) {
      out.push(head + clip(b.text, opts.maxText));
      saidHead = true;
    } else if (b.type === 'tool_use') {
      const inp = b.input && Object.keys(b.input).length ? ' · ' + clip(JSON.stringify(b.input), opts.maxTool) : '';
      out.push('    ⛭ ' + clip(b.name || 'tool', 40) + inp);
      saidHead = true;
    }
    // skip: thinking (internal), tool_result (huge/noisy), images, etc.
  }
  return saidHead ? out : [];
}

// Read a transcript file and return a readable, size-capped string. Options are for tests.
function readTranscript(file, opts) {
  opts = opts || {};
  const o = {
    maxText: opts.maxText || 4000,   // per text block
    maxTool: opts.maxTool || 160,    // per tool_use input summary
    maxTurns: opts.maxTurns || 6000, // total display lines kept (keeps the TAIL if exceeded)
    maxBytes: opts.maxBytes || 500000,
    readCap: opts.readCap || 4 * 1024 * 1024, // never slurp more than this many bytes of raw .jsonl
  };
  const real = resolveInJail(file);
  if (!real) return '';
  return memoized('readTranscript', real, o.readCap, '', () => readTranscriptUncached(real, o));
}

function readTranscriptUncached(real, o) {
  // Bound the READ itself: transcripts grow to many MB and full-log mode polls every ~1s, so never load
  // the whole file into the single shared server (OOM / stall risk). If it's over the cap, read only the
  // last readCap bytes (the tail is what a reader wants) and drop the partial first line.
  let raw, tailed = false;
  try { ({ raw, tailed } = readBounded(real, o.readCap)); } catch (e) { return ''; }
  const disp = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const rows = renderLine(ev, o);
    for (const r of rows) {
      if (r.startsWith('[') && r.includes('❯ you:') && disp.length) disp.push(''); // blank line before each new user turn
      disp.push(r);
    }
  }
  if (!disp.length) return '';
  let head = '';
  let kept = disp;
  if (disp.length > o.maxTurns) {
    kept = disp.slice(-o.maxTurns);
    head = '… [' + (disp.length - o.maxTurns) + ' earlier lines truncated] …\n\n';
  } else if (tailed) {
    head = '… [earlier session truncated — showing the most recent activity] …\n\n';
  }
  let text = head + kept.join('\n');
  if (text.length > o.maxBytes) text = '… [truncated to last ' + o.maxBytes + ' chars] …\n\n' + text.slice(-o.maxBytes);
  return text;
}

// A friendly one-liner for a tool chip, from the tool_use input. Prefers the human-written
// description, then the most identifying arg. Unknown/odd inputs -> ''.
function toolLabel(input, cap) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subject', 'title']) {
    if (typeof input[k] === 'string' && input[k].trim()) return clip(input[k], cap);
  }
  return '';
}

// parseTranscript(file, opts) -> [{ role:'you'|'claude', ts, blocks:[...] }] — structured turns for
// the /chat bubble view. Same jail + bounded tail-read as readTranscript. Never throws; foreign or
// unreadable paths -> []. Harness plumbing (system-reminders, command wrappers, tool_result payloads,
// thinking, sidechain lines) is filtered so a non-dev sees only the real conversation.
function parseTranscript(file, opts) {
  opts = opts || {};
  const o = {
    maxText: opts.maxText || 20000,
    maxLabel: opts.maxLabel || 120,
    maxTurns: opts.maxTurns || 400,
    readCap: opts.readCap || 4 * 1024 * 1024,
  };
  const real = resolveInJail(file);
  if (!real) return [];
  return memoized('parseTranscript', real, o.readCap, [], () => parseTranscriptUncached(real, o));
}

function parseTranscriptUncached(real, o) {
  let raw;
  try { const r = readBounded(real, o.readCap); raw = typeof r === 'string' ? r : r.raw; } catch (e) { return []; }
  const lines = raw.split('\n');
  const statuses = new Map(); // tool_use id -> 'done' | 'error'
  for (const line of lines) {
    if (!line || line.indexOf('tool_result') < 0) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    const c = ev && ev.message && ev.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) statuses.set(b.tool_use_id, b.is_error ? 'error' : 'done');
  }
  // Harness plumbing that surfaces as user/assistant TEXT but is NOT real conversation: the specific
  // wrapper tags Claude Code injects, the local-command preamble, and the interrupt marker. Kept
  // NARROW (named tags, not "any line starting with <") so a teammate who types "<3" or pastes an HTML
  // snippet still sees their own message. Synthetic whole-turn injections (skill walls, post-compaction
  // continuation summaries) carry isMeta/isCompactSummary and are dropped by flag below, not by text.
  // Tag list verified against the real ~/.claude/projects transcripts (task-notification, system-reminder,
  // command-*, local-command-*, and the `!command` echoes bash-input/bash-stdout/bash-stderr — the last
  // three carry NO isMeta flag, so they must be caught here or they render as bogus "you" bubbles).
  const HARNESS_TEXT = /^\s*(<\/?(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|budget|user-prompt-submit-hook|session-start-hook)\b|Caveat: The messages below were generated by the user while running local commands|\[Request interrupted by user)/i;
  const turns = [];
  const push = (role, ts, block) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) { last.blocks.push(block); return; }
    turns.push({ role, ts: ts || '', blocks: [block] });
  };
  for (const line of lines) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
    // Drop synthetic / non-conversation turns: subagent traffic (isSidechain), harness-injected turns
    // like Skill-tool instruction walls (isMeta), and post-compaction continuation summaries
    // (isCompactSummary) — each would otherwise render as a giant bubble the non-dev never sent.
    if (ev.isSidechain === true || ev.isMeta === true || ev.isCompactSummary === true) continue;
    const t = ev.type;
    if (t !== 'user' && t !== 'assistant') continue;
    const m = ev.message; if (!m || typeof m !== 'object') continue;
    const role = t === 'user' ? 'you' : 'claude';
    const ts = ev.timestamp || '';
    const c = m.content;
    if (typeof c === 'string') {
      const s = c.trim();
      if (s && !HARNESS_TEXT.test(s)) push(role, ts, { type: 'text', text: s.slice(0, o.maxText) });
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const s = b.text.trim();
        if (!HARNESS_TEXT.test(s)) push(role, ts, { type: 'text', text: s.slice(0, o.maxText) });
      } else if (b.type === 'tool_use' && role === 'claude') {
        push(role, ts, { type: 'tool', name: String(b.name || 'tool').slice(0, 60), label: toolLabel(b.input, o.maxLabel), status: statuses.get(b.id) || 'running' });
      }
    }
  }
  // an interrupted / stale tool call must not spin forever: only the FINAL turn may say 'running'
  for (let i = 0; i < turns.length - 1; i++) {
    for (const b of turns[i].blocks) if (b.type === 'tool' && b.status === 'running') b.status = 'done';
  }
  return turns.length > o.maxTurns ? turns.slice(-o.maxTurns) : turns;
}

// Files actually changed by recently completed mutating tools. Used by duplicate-work detection;
// reads and failed/unpaired writes are deliberately excluded to avoid noisy false overlap.
function recentTouchedFiles(file, cwd, opts) {
  opts = opts || {};
  const real = resolveInJail(file);
  if (!real) return [];
  const now = Number(opts.now || Date.now());
  const recentMs = Number(opts.recentMs || 60 * 60 * 1000);
  const readCap = Number(opts.readCap || 4 * 1024 * 1024);
  let raw;
  try { raw = readBounded(real, readCap).raw; } catch (e) { return []; }
  const lines = raw.split('\n'), results = new Map();
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch (e) { continue; }
    const content = event && event.message && event.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block && block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, !block.is_error);
  }
  const mutating = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
  const touched = [];
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch (e) { continue; }
    if (event && (event.isSidechain === true || event.isMeta === true)) continue;
    const at = Date.parse(event && event.timestamp);
    if (!Number.isFinite(at) || now - at > recentMs || at > now + 60000) continue;
    const content = event && event.message && event.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || !results.get(block.id) || !mutating.has(String(block.name || '').toLowerCase())) continue;
      const input = block.input || {}, value = input.file_path || input.path;
      if (typeof value !== 'string' || !value.trim()) continue;
      const normalized = path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd || '.', value));
      const prior = touched.indexOf(normalized);
      if (prior >= 0) touched.splice(prior, 1);
      touched.push(normalized);
    }
  }
  return touched.slice(-20);
}

function completedActions(file, opts) {
  opts = opts || {};
  const real = resolveInJail(file);
  if (!real) return [];
  const readCap = opts.readCap || 4 * 1024 * 1024;
  return memoized('completedActions', real, readCap, [], () => {
    let raw;
    try { raw = readBounded(real, readCap).raw; } catch (e) { return []; }
    const lines = raw.split('\n'), success = new Set();
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch (e) { continue; }
      const content = event && event.message && event.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) if (block && block.type === 'tool_result' && block.tool_use_id && !block.is_error) success.add(block.tool_use_id);
    }
    const actions = [];
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch (e) { continue; }
      if (event && (event.isSidechain === true || event.isMeta === true)) continue;
      const content = event && event.message && event.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) if (block && block.type === 'tool_use' && success.has(block.id)) {
        actions.push({ name: String(block.name || 'tool').slice(0, 60), label: toolLabel(block.input, 120), ts: event.timestamp || '' });
      }
    }
    return actions.slice(-3);
  });
}

module.exports = { readTranscript, parseTranscript, recentTouchedFiles, completedActions, isAllowed };
