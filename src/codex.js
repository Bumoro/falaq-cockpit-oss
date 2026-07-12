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
            out.push({
              id: String(meta.id || f).slice(0, 40),
              cwd,
              client: resolveClient(cwd, map),
              originator: String(meta.originator || '').slice(0, 40),
              lastActivity: Math.round(mt),
            });
          }
        }
  } catch (e) {}
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  if (!opts) { _cache = out; _cacheAt = Date.now(); }
  return out;
}
module.exports = { activeTasks };
