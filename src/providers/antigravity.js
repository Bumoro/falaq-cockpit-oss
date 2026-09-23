// providers/antigravity.js — active Antigravity CLI conversations.
//
// Antigravity does not expose stable context or usage telemetry. Its per-conversation
// SQLite files are therefore used for liveness only; the database contents are never
// opened or parsed. A matching CLI log can add the workspace and suppress a freshly
// touched database once "Stopping conversation stream" has been written.
const fs = require('fs');
const path = require('path');
const os = require('os');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const START_RE = /Starting conversation update stream for ([0-9a-f-]{36})/;
const STOP_RE = /Stopping conversation stream/;
const WORKSPACE_RE = /Initializing CLI store manager for workspace (.+)$/;

function antigravityRoot(opts) {
  return (opts && opts.root) ||
    process.env.CK_ANTIGRAVITY_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli');
}
function stateDir() { return process.env.COCKPIT_DIR || path.join(__dirname, '..'); }

function clientMap() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(), 'config.json'), 'utf8')).clientMap || {}; }
  catch (e) { return {}; }
}
function resolveClient(cwd, map) {
  if (!cwd) return '';
  for (const [needle, name] of Object.entries(map)) {
    if (cwd.toLowerCase().includes(needle.toLowerCase())) return name;
  }
  return path.basename(cwd) || '';
}

// Logs are normally small. Bound exceptional files while retaining both the workspace/start
// header and a possible stop marker at the end.
function readLog(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size <= 4 * 1024 * 1024) return fs.readFileSync(file, 'utf8');
    fd = fs.openSync(file, 'r');
    const chunkSize = 256 * 1024;
    const head = Buffer.alloc(chunkSize);
    const tail = Buffer.alloc(chunkSize);
    const hn = fs.readSync(fd, head, 0, chunkSize, 0);
    const tn = fs.readSync(fd, tail, 0, chunkSize, Math.max(0, size - chunkSize));
    return head.slice(0, hn).toString('utf8') + '\n' + tail.slice(0, tn).toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

function logStates(root, oldestDbMtime) {
  const dir = path.join(root, 'log');
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^cli-.*\.log$/.test(f)); }
  catch (e) { return new Map(); }

  const recent = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { continue; }
    // A stop is written just after the last DB write. The small overlap handles timestamp
    // resolution/order without allowing an old stopped run to hide a newly resumed UUID.
    if (mtime < oldestDbMtime - 5000) continue;
    recent.push({ file, mtime });
  }
  recent.sort((a, b) => a.mtime - b.mtime);

  const states = new Map();
  for (const entry of recent) {
    const raw = readLog(entry.file);
    if (!raw) continue;
    let cwd = '';
    let currentId = '';
    for (const line of raw.split(/\r?\n/)) {
      const workspace = line.match(WORKSPACE_RE);
      if (workspace) cwd = workspace[1].trim();
      const start = line.match(START_RE);
      if (start && UUID_RE.test(start[1])) {
        currentId = start[1].toLowerCase();
        states.set(currentId, { stopped: false, cwd, mtime: entry.mtime });
      } else if (currentId && STOP_RE.test(line)) {
        states.set(currentId, { stopped: true, cwd, mtime: entry.mtime });
      }
    }
  }
  return states;
}

let cache = null;
let cacheAt = 0;
function activeSessions(opts) {
  // Multiple open cockpit tabs poll frequently. Explicit options are for deterministic tests
  // and bypass the short production cache, matching the Codex provider's behavior.
  if (!opts && cache && Date.now() - cacheAt < 2500) return cache;
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const freshMs = opts && Number.isFinite(opts.freshMs) ? opts.freshMs : 3 * 60 * 1000;
  const root = antigravityRoot(opts);
  const dir = path.join(root, 'conversations');
  const candidates = [];

  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.db')) continue;
      const id = name.slice(0, -3);
      if (!UUID_RE.test(id)) continue;
      const file = path.join(dir, name);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch (e) { continue; }
      if (now - mtime > freshMs) continue;
      candidates.push({ id: id.toLowerCase(), file, mtime });
    }
  } catch (e) {}

  const states = candidates.length
    ? logStates(root, Math.min(...candidates.map(x => x.mtime)))
    : new Map();
  const map = clientMap();
  const out = [];
  for (const item of candidates) {
    const log = states.get(item.id);
    if (log && log.stopped && log.mtime >= item.mtime) continue;
    const cwd = (log && log.cwd) || '';
    out.push({
      id: item.id,
      cwd,
      client: resolveClient(cwd, map),
      lastActivity: Math.round(item.mtime),
      context: null,
      provider: 'antigravity',
    });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  if (!opts) { cache = out; cacheAt = Date.now(); }
  return out;
}

module.exports = { activeSessions };
