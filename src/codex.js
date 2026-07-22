// codex.js — active Codex tasks by scanning ~/.codex/sessions rollout files.
// A rollout whose mtime is within the freshness window is an actively-running task (Codex
// appends to the rollout as the task works; an idle/finished one stops updating). Read-only;
// never throws to the caller. Zero deps.
const fs = require('fs');
const path = require('path');
const os = require('os');

function sessionsRoot() { return process.env.CK_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions'); }
function stateDir() { return process.env.COCKPIT_DIR || __dirname; }

function clientMap() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(), 'config.json'), 'utf8')).clientMap || {}; }
  catch (e) { return {}; }
}
function resolveClient(cwd, map) {
  if (!cwd) return '';
  for (const [needle, name] of Object.entries(map)) if (cwd.toLowerCase().includes(needle.toLowerCase())) return name;
  return path.basename(cwd) || '';
}
// numeric child dirs (YYYY / MM / DD), newest first, capped — bounds the walk to a few days
function recentDirs(p, n) {
  try { return fs.readdirSync(p).filter(x => /^\d+$/.test(x)).sort((a, b) => Number(b) - Number(a)).slice(0, n); }
  catch (e) { return []; }
}
function readMeta(file) {
  // First line of a rollout is `{"type":"session_meta","payload":{id,cwd,originator,...}}`. A REAL
  // rollout embeds the entire Codex system prompt in payload.base_instructions.text, so this line is
  // often tens of KB — far past any fixed buffer. A truncated read then fails JSON.parse and the task
  // is silently dropped (which made /api/workers permanently empty). Fast path: a small meta line
  // parses directly. Fallback: id/cwd/originator all appear BEFORE base_instructions, so pull them
  // straight out of the head when the full line is truncated.
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(32768);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    // Anchor to the FIRST physical line only — the meta is line 1; later event lines must never be mined
    // for id/cwd. If line 1 overflows 32KB there is no newline in the buffer, so the whole read IS the
    // (truncated) first line, which is exactly what we want. id/cwd/originator precede base_instructions.
    const firstLine = buf.slice(0, n).toString('utf8').split('\n')[0];
    try { const o = JSON.parse(firstLine); if (o && o.type === 'session_meta' && o.payload) return o.payload; } catch (e) {}
    if (!/"type"\s*:\s*"session_meta"/.test(firstLine)) return null;
    const pick = (k) => (firstLine.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')) || [])[1];
    const id = pick('id'), cwd = pick('cwd'), originator = pick('originator');
    if (!id && !cwd) return null;
    return { id, cwd, originator };
  } catch (e) {}
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
  return null;
}
function readContext(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const lines = raw.split('\n');
  let model = null;
  let context = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    const payload = o && o.payload;
    if (!model && o.type === 'turn_context' && payload && typeof payload.model === 'string') {
      model = payload.model;
      if (context) return { ...context, model };
    }
    if (context || !payload || payload.type !== 'token_count') continue;
    const info = payload.info;
    const tokens = info && info.last_token_usage && info.last_token_usage.total_tokens;
    const limit = info && info.model_context_window;
    // total_token_usage is deliberately not consulted: it is the lifetime sum, not current context.
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(limit) || limit <= 0) continue;
    context = { tokens, limit, pct: tokens / limit };
    model = (info && info.model) || model;
    if (model) return { ...context, model };
  }
  return context ? { ...context, model: null } : null;
}
function readInsights(file, cwd) {
  let raw;
  try {
    const size = fs.statSync(file).size;
    if (size > 8 * 1024 * 1024) return { prompts: [], touchedFiles: [] };
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) { return { prompts: [], touchedFiles: [] }; }
  const prompts = [], calls = new Map(), touched = new Set();
  for (const line of raw.split('\n')) {
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    const p = o && o.payload;
    if (o.type === 'event_msg' && p && p.type === 'user_message' && typeof p.message === 'string') {
      const value = p.message.replace(/\s+/g, ' ').trim();
      if (value && prompts[prompts.length - 1] !== value) prompts.push(value);
    }
    if (o.type === 'response_item' && p && p.type === 'function_call' && p.call_id) calls.set(p.call_id, p);
    if (o.type !== 'response_item' || !p || p.type !== 'function_call_output' || !p.call_id || /error|failed/i.test(String(p.output || ''))) continue;
    const call = calls.get(p.call_id);
    if (!call || call.name !== 'apply_patch') continue;
    let args = {}; try { args = JSON.parse(call.arguments || '{}'); } catch (e) {}
    for (const match of String(args.patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const file = match[1].trim();
      touched.add(path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd || '', file));
    }
  }
  return { prompts, touchedFiles: [...touched].slice(-100) };
}
let _cache = null, _cacheAt = 0;
function activeTasks(opts) {
  // The server polls /api/workers every ~2s (× open tabs); cache the no-arg result briefly so a
  // heavy ~/.codex/sessions dir isn't re-stat'd on every poll. Tests pass opts and bypass the cache.
  if (!opts && _cache && Date.now() - _cacheAt < 2500) return _cache;
  const freshMs = (opts && opts.freshMs) || 3 * 60 * 1000;
  const now = (opts && opts.now) || Date.now();
  const root = sessionsRoot();
  const map = clientMap();
  const out = [];
  try {
    for (const y of recentDirs(root, 2))
      for (const m of recentDirs(path.join(root, y), 2))
        for (const d of recentDirs(path.join(root, y, m), 2)) {
          const dd = path.join(root, y, m, d);
          let files = []; try { files = fs.readdirSync(dd); } catch (e) {}
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(dd, f);
            let mt; try { mt = fs.statSync(fp).mtimeMs; } catch (e) { continue; }
            if (now - mt > freshMs) continue;      // not fresh -> not an active task
            const meta = readMeta(fp);
            if (!meta) continue;
            const cwd = meta.cwd || '';
            const insights = readInsights(fp, cwd);
            out.push({
              id: String(meta.id || f).slice(0, 40),
              cwd,
              client: resolveClient(cwd, map),
              originator: String(meta.originator || '').slice(0, 40),
              lastActivity: Math.round(mt),
              rolloutPath: fp,
              prompts: insights.prompts,
              lastPrompt: insights.prompts[insights.prompts.length - 1] || '',
              touchedFiles: insights.touchedFiles,
              context: readContext(fp),
            });
          }
        }
  } catch (e) {}
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  if (!opts) { _cache = out; _cacheAt = Date.now(); }
  return out;
}
module.exports = { activeTasks, readInsights };
