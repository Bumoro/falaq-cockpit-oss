#!/usr/bin/env node
// server.js — Falaq Agent Dashboard HTTP server
// Zero dependencies — uses Node.js built-in http module

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chatsMod = require('./chats.js');
const contextMod = require('./context.js');
const usageMod = require('./usage.js');
const modelsMod = require('./models.js');
const watchersMod = require('./watchers.js');
const { buildChecks } = require('./watchers/checks.js');
const codexMod = require('./codex.js');
const ollamaMod = require('./providers/ollama.js');
const ollamaChat = require('./providers/ollama-chat.js');
const antigravityMod = require('./providers/antigravity.js');
const { normalizeProviderSession } = require('./providers/session.js');
const transcriptMod = require('./transcript.js');
const agentsMod = require('./agents.js');
const promptReader = require('./prompt-reader.js');
const autowrapMod = require('./autowrap.js');
const dispatchMod = require('./dispatch.js');
const dispatchTrigger = require('./dispatch/trigger.js');
const dashboardState = require('./dashboard-state.js');
const purposeMod = require('./purpose.js');
const duplicatesMod = require('./duplicates.js');
const updaterMod = require('./updater.js');
const notifyMod = require('./notify.js');
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847');
const DIR = __dirname;
const STATE_DIR = process.env.COCKPIT_DIR || DIR;

// Host validation blocks DNS rebinding before any route (including /api/token) runs: without it a
// malicious page can rebind its hostname to 127.0.0.1, become same-origin (so the CORS pin never
// applies), read /api/token and POST /api/chats — arbitrary code execution as the user.
//
// A reverse proxy forwards its OWN hostname in Host, so any fronted access must be allow-listed or
// it 403s. `tailscale serve` (how the phone reaches /m) is exactly this case. Extra hostnames come
// from config.json `allowedHosts` AND CK_ALLOWED_HOSTS — config.json is the durable one, because the
// SessionStart hook auto-starts start.js without the user's shell env (same reason a custom
// AGENT_DASHBOARD_PORT doesn't stick).
function configuredHosts() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8'));
    return Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : [];
  } catch (e) { return []; }
}
const ALLOWED_HOSTNAMES = new Set([
  '127.0.0.1', 'localhost', '[::1]',
  ...[...(process.env.CK_ALLOWED_HOSTS || '').split(','), ...configuredHosts()]
    .map(host => String(host || '').trim().toLowerCase()).filter(Boolean),
]);
function allowedHost(req) {
  const host = req.headers.host;
  // Fail closed on a missing Host. An HTTP/1.0 exemption was tempting (Host is optional there), but
  // nothing that talks to this server speaks 1.0 — browsers and curl are both 1.1 — and it would be
  // a standing hole for any front-end that downgrades and drops the header.
  if (typeof host !== 'string' || host !== host.trim() || !host) return false;
  // Node KEEPS THE FIRST Host and silently discards the rest (host is a discard-duplicates header),
  // so `headers.host` alone would approve a smuggled `Host: 127.0.0.1` + `Host: evil.com` pair on the
  // strength of the first one. Verified empirically — it answered 200, not the 400 one might assume.
  // Browsers never send two, but fail closed rather than depend on that.
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let seen = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === 'host' && ++seen > 1) return false;
  }
  const normalized = host.toLowerCase();
  for (const hostname of ALLOWED_HOSTNAMES) {
    if (normalized === hostname || normalized === `${hostname}:${PORT}`) return true;
  }
  return false;
}

// Never let a route error kill the whole server (and everyone connected to it).
// Log it and keep serving. Do NOT process.exit here.
process.on('uncaughtException', (e) => { try { fs.appendFileSync(path.join(DIR, 'error.log'), new Date().toISOString() + ' ' + (e.stack || e) + '\n'); } catch (_) {} });

const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');
const HOME_FILE = path.join(DIR, 'home.html');
const INDEX_FILE = path.join(DIR, 'index.html');
const HELP_FILE = path.join(DIR, 'help.html');
// Port-aware pid file: the bind winner writes it (see server.listen below) so external tooling / a
// human can find the live listener; a custom AGENT_DASHBOARD_PORT (e.g. tests) gets its own
// server-<PORT>.pid. start.js does NOT read this — it probes the port to decide whether to start.
const PID_FILE = path.join(DIR, process.env.AGENT_DASHBOARD_PORT ? `server-${PORT}.pid` : 'server.pid');

const TOKEN_FILE = path.join(STATE_DIR, '.token');
function readUpdateConfig() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8')); } catch (e) {}
  return updaterMod.normalizeUpdateConfig(config);
}
const purposeTitles = new purposeMod.PurposeTitles({ stateDir: STATE_DIR });
const duplicateDetector = new duplicatesMod.DuplicateDetector({ stateDir: STATE_DIR });
// Keep policy in this server layer so config changes are picked up on every scheduled run.
const updater = new updaterMod.Updater({ stateDir: STATE_DIR, auto: false });
const notifier = new notifyMod.Notifier({ stateDir: STATE_DIR });
let duplicateSnapshot = { updatedAt: 0, pairs: [] };
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { TOKEN = ''; }
if (!/^[0-9a-f]{48}$/.test(TOKEN)) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

function readBody(req, cb, maxBytes = 1e5) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  req.on('data', c => {
    if (tooLarge) return;
    bytes += Buffer.byteLength(c);
    if (bytes > maxBytes) { tooLarge = true; chunks.length = 0; return; }
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  });
  req.on('end', () => {
    if (tooLarge) return cb({}, new Error('request body is too large'));
    const data = Buffer.concat(chunks).toString('utf8');
    let b = {};
    try { b = JSON.parse(data || '{}'); }
    catch (e) { return cb({}, new Error('invalid JSON')); }
    cb(b, null);
  });
}

// Cheap, cached read of a controlled chat's pending prompt (tmux capture is spawned per call, so
// cache briefly — /api/sessions is polled ~1/s and only WAITING chats are ever screened).
const _pendingCache = new Map(); // name -> { t, val }
let _chatLifeCache = { t: 0, names: new Set() };
let ollamaSessions = [];
let ollamaRefreshRunning = false;
function refreshOllamaSessions() {
  if (ollamaRefreshRunning) return;
  ollamaRefreshRunning = true;
  Promise.resolve(ollamaMod.activeSessions())
    .then(value => { ollamaSessions = Array.isArray(value) ? value : []; })
    .catch(() => { ollamaSessions = []; })
    .finally(() => { ollamaRefreshRunning = false; });
}
function liveChatNames(now = Date.now()) {
  if (now - _chatLifeCache.t < 2500) return _chatLifeCache.names;
  let names = new Set();
  try { names = new Set(chatsMod.listChats().filter(c => c.alive).map(c => c.name)); } catch (e) {}
  _chatLifeCache = { t: now, names };
  return names;
}
function pendingFor(name) {
  const now = Date.now();
  const hit = _pendingCache.get(name);
  if (hit && now - hit.t < 1200) return hit.val;
  let val = { kind: 'none', title: '', options: [] };
  try { val = promptReader.parsePrompt(chatsMod.screen(name, 200)); } catch (e) {}
  _pendingCache.set(name, { t: now, val });
  return val;
}

// The set of transcript paths that belong to a known monitored session. The transcript route only
// serves a requested path if it's in here — so a token-holder can't read arbitrary files, only the
// transcripts the dashboard already tracks (transcript.js additionally jails reads to ~/.claude/projects).
function knownTranscriptPaths() {
  const set = new Set();
  try {
    const sessionsDir = path.join(STATE_DIR, 'sessions');
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
        if (s && s.transcriptPath) set.add(s.transcriptPath);
      } catch (e) {}
    }
  } catch (e) {}
  // Chats keep a transcript pointer in the registry after their session file is pruned — without
  // this an idle open chat or the Closed-chats history could never render its conversation.
  // transcript.js still jails every read to ~/.claude/projects.
  try {
    for (const c of chatsMod.listChats()) if (c && c.transcriptPath) set.add(c.transcriptPath);
  } catch (e) {}
  return set;
}

function trackedTranscript(file) {
  if (!file) return null;
  try {
    const sessionsDir = path.join(STATE_DIR, 'sessions');
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
        if (session && session.transcriptPath === file) return session;
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

const FILE_PREVIEW_MAX = 2 * 1024 * 1024;
const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonl',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.php', '.java', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.swift', '.kt', '.kts', '.sql', '.graphql', '.gql', '.vue',
  '.svelte', '.csv', '.tsv', '.log',
]);
const TEXT_FILE_NAMES = new Set(['.env', '.gitignore', 'dockerfile', 'makefile']);
const IMAGE_FILE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);
function fileResponseType(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_FILE_TYPES.has(ext)) return { type: IMAGE_FILE_TYPES.get(ext), attachment: false };
  const base = path.basename(file).toLowerCase();
  if (TEXT_FILE_EXTS.has(ext) || TEXT_FILE_NAMES.has(base)) return { type: 'text/plain; charset=utf-8', attachment: false };
  return { type: 'application/octet-stream', attachment: true };
}
function attachmentName(file) {
  return path.basename(file).replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
}
function resolveRecordedFile(file, rootDir) {
  let real, root;
  try {
    real = fs.realpathSync(file);
    root = fs.realpathSync(rootDir);
  } catch (e) { return null; }
  return (real === root || real.startsWith(root + path.sep)) ? real : null;
}

function controlledChat(name) {
  try { return chatsMod.listChats().find(chat => chat.name === name) || null; }
  catch (e) { return null; }
}

function mediatedTurns(name) {
  return ollamaChat.history(name).map(turn => ({
    role: turn.role === 'user' ? 'you' : 'claude',
    ts: turn.ts,
    blocks: [{ type: 'text', text: turn.content }],
  }));
}

function buildSessionsFresh() {
  const sessionsDir = path.join(STATE_DIR, 'sessions');
  const now = Date.now();
  let sessions = [];
  try {
    sessions = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); }
        catch (e) { return null; }
      })
      .filter(Boolean)
      .filter(s => !(s.state === 'ended' && now - (s.endedAt || 0) > 3600e3));
  } catch (e) {}
  const correlated = sessions.filter(s => s && s.chatName && s.transcriptPath)
    .sort((a, b) => ((a.state === 'ended') - (b.state === 'ended')) || ((b.lastActivityAt || 0) - (a.lastActivityAt || 0)));
  const persistedChats = new Set();
  for (const s of correlated) {
    if (persistedChats.has(s.chatName)) continue;
    persistedChats.add(s.chatName);
    try { chatsMod.persistTranscriptPath(s.chatName,s.transcriptPath); } catch (e) {}
  }
  const aliveChats = liveChatNames(now);
  const claude = sessions.map(s => {
    const extra = {};
    const purpose = purposeTitles.get(s.sessionId);
    if (purpose) { extra.purposeTitle = purpose.title; extra.purposeSource = purpose.source; }
    if (s.transcriptPath) {
      try { const c = contextMod.contextForTranscript(s.transcriptPath); if (c) extra.context = c; } catch (e) {}
      try { const la = agentsMod.activeAgents(s.transcriptPath); if (la.length) extra.liveAgents = la; } catch (e) {}
      try { extra.completedActions = transcriptMod.completedActions(s.transcriptPath); } catch (e) { extra.completedActions = []; }
    }
    // Only WAITING, cockpit-CONTROLLED chats can be answered from the card.
    try {
      if (s.state === 'needs_you' && s.chatName) {
        const p = pendingFor(s.chatName);
        if (p && p.kind !== 'none') extra.pending = p;
      }
    } catch (e) {}
    // Hook-created session files predate multi-provider tracking. Treat a missing provider exactly as
    // Claude so old state keeps the same behavior while every API object now has an explicit tag.
    return { ...s, provider: s.provider || 'claude', chatAlive: !!(s.chatName && aliveChats.has(s.chatName)), ...extra };
  });
  // Codex computes its own context object while reading the rollout. Keep this layer deliberately
  // dumb: normalize field names and merge; provider-specific token math stays in codex.js.
  let codex = [];
  try {
    codex = codexMod.activeTasks().map(s => ({
      sessionId: s.id,
      provider: 'codex',
      state: 'running',
      live: true,
      cwd: s.cwd,
      client: s.client,
      originator: s.originator,
      rolloutPath: s.rolloutPath,
      prompts: s.prompts,
      lastPrompt: s.lastPrompt,
      touchedFiles: s.touchedFiles,
      lastActivityAt: s.lastActivity,
      ...(s.context ? { context: s.context, model: s.context.model } : {}),
      ...(() => { const p = purposeTitles.get(s.id); return p ? { purposeTitle: p.title, purposeSource: p.source } : {}; })(),
    }));
  } catch (e) {}
  let antigravity = [];
  try { antigravity = antigravityMod.activeSessions().map(normalizeProviderSession); } catch (e) {}
  return claude.concat(codex, ollamaSessions.map(normalizeProviderSession), antigravity);
}

let _sessionsCache = { t: 0, value: null };
function buildSessions() {
  const now = Date.now();
  if (_sessionsCache.value && now - _sessionsCache.t < 1000) return _sessionsCache.value;
  const value = buildSessionsFresh();
  _sessionsCache = { t: Date.now(), value };
  return value;
}

// Auto-shutdown after 30 min of no events
let lastActivity = Date.now();
const TIMEOUT = 30 * 60 * 1000;

function sessionsDirActive() {
  // Treat fresh session-file writes as activity even if nobody hit the HTTP API.
  try {
    const sessionsDir = path.join(STATE_DIR, 'sessions');
    let newest = 0;
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = fs.statSync(path.join(sessionsDir, f)).mtimeMs;
        if (m > newest) newest = m;
      } catch (e) {}
    }
    return newest > 0 && Date.now() - newest < TIMEOUT;
  } catch (e) {
    return false;
  }
}

const activityCheck = setInterval(() => {
  if (Date.now() - lastActivity > TIMEOUT && !sessionsDirActive()) {
    cleanup();
    process.exit(0);
  }
}, 60000);

function cleanup() {
  clearInterval(activityCheck);
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

function getEvents(since) {
  try {
    const content = fs.readFileSync(EVENTS_FILE, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    const events = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (!since || evt.timestamp > since) {
          events.push(evt);
        }
      } catch (e) {}
    }
    return events;
  } catch (e) {
    return [];
  }
}

function getWeeklyStats(events) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const weekCalls = toolCalls.filter(e => e.timestamp > weekAgo).length;
  const dayCalls = toolCalls.filter(e => e.timestamp > dayAgo).length;

  // Calculate day of week (0=Sun)
  const dayOfWeek = new Date().getDay();
  const daysIntoWeek = dayOfWeek === 0 ? 7 : dayOfWeek;

  return { weekCalls, dayCalls, daysIntoWeek };
}

function getTaskState(events, now) {
  return dashboardState.classifyTasks(dashboardState.reduceTasks(events), buildSessions(), now)
    .map(task => ({ ...task, relativeTime: dashboardState.relativeTime(task.lastEventAt, now) }));
}

function appendTaskUpdates(keys, status) {
  if (!['completed', 'abandoned'].includes(status)) throw new Error('invalid task status');
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000) throw new Error('taskKeys must be a non-empty array');
  const known = new Set(dashboardState.reduceTasks(getEvents(0)).map(task => task.key));
  const now = Date.now();
  const lines = [];
  for (const raw of [...new Set(keys)]) {
    const key = String(raw || '');
    if (!/^[A-Za-z0-9._-]{1,100}:\d{1,5}$/.test(key) || !known.has(key)) throw new Error('unknown task key');
    const split = key.lastIndexOf(':');
    lines.push(JSON.stringify({
      type: 'task_update', taskKey: key, taskId: key.slice(split + 1), status,
      timestamp: now, sessionId: key.slice(0, split), source: 'cockpit',
    }));
  }
  fs.appendFileSync(EVENTS_FILE, lines.join('\n') + '\n');
  return lines.length;
}

const server = http.createServer((req, res) => {
  if (!allowedHost(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden host');
  }
  lastActivity = Date.now();
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', `http://localhost:${PORT}`);

  if (parsed.pathname === '/api/events') {
    const since = parseInt(parsed.searchParams.get('since')) || 0;
    const allEvents = getEvents(0);
    const newEvents = since ? allEvents.filter(e => e.timestamp > since) : allEvents;
    const stats = getWeeklyStats(allEvents);

    // Get active agents from recent events
    const activeAgents = {};
    const agentNow = Date.now();
    const liveSessionIds = new Set(buildSessions()
      .filter(s => s && dashboardState.isSessionLive(s, agentNow))
      .map(s => String(s.sessionId)));
    const agentEvents = allEvents.filter(e => e.type === 'agent_spawn').reverse();
    for (const evt of agentEvents) {
      if (!activeAgents[evt.agent] && evt.agent !== 'Unknown' && liveSessionIds.has(String(evt.sessionId)) && agentNow - Number(evt.timestamp || 0) < 30 * 60 * 1000) {
        activeAgents[evt.agent] = evt;
      }
    }

    const tasks = getTaskState(allEvents, Date.now());

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: newEvents.slice(-100),
      agents: activeAgents,
      tasks,
      stats: stats,
      serverTime: Date.now()
    }));
    return;
  }

  if (parsed.pathname === '/api/tasks/actions') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return readBody(req, body => {
      try {
        const updated = appendTaskUpdates(body.taskKeys, body.status);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, updated }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  if (parsed.pathname === '/api/duplicates') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(duplicateSnapshot));
  }

  if (parsed.pathname === '/api/notify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(notifier.getStatus()));
  }

  if (parsed.pathname === '/api/duplicates/dismiss') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return readBody(req, body => {
      const ok = duplicateDetector.dismiss(body.pairKey);
      if (ok) duplicateSnapshot = { ...duplicateSnapshot, pairs: duplicateDetector.pairs };
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'unknown duplicate pair' }));
    });
  }

  if (parsed.pathname === '/api/sessions/save-kill') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return readBody(req, body => {
      try {
        // Deliberately BYPASSES the 1s buildSessions cache. This route kills a real process, and the
        // re-pairing below is its ground-truth check that the banner isn't stale — a cached snapshot
        // populated by an unrelated poll a moment earlier would undermine exactly that guarantee.
        const freshSessions = buildSessionsFresh();
        // Synchronous structural re-pairing at kill time closes the stale-banner race (the
        // snapshot refreshes only every 60s). Mirrors refreshDuplicates()'s input construction.
        const killNow = Date.now();
        const freshPairs = duplicatesMod.structuralPairs(freshSessions
          .filter(session => dashboardState.isSessionLive(session, killNow))
          .map(session => duplicatesMod.enrichSession({ ...session, live: true }, killNow)));
        const result = duplicatesMod.saveKillSession({
          sessionId: body.sessionId,
          pairs: duplicateSnapshot.pairs,
          freshPairs,
          sessions: freshSessions,
          stateDir: STATE_DIR,
          transcriptMod,
          chatsMod,
          now: new Date(),
        });
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        try { fs.appendFileSync(path.join(DIR, 'error.log'), new Date().toISOString() + ' save-kill: ' + (e && e.stack || e) + '\n'); } catch (e2) {}
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'save-kill failed' }));
        } else {
          try { res.end(); } catch (e2) {}
        }
      }
    });
  }

  if (parsed.pathname === '/api/token') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(TOKEN);
  }

  if (parsed.pathname === '/api/update' || parsed.pathname === '/api/update/apply' ||
      parsed.pathname === '/api/update/check' || parsed.pathname === '/api/update/config') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const updateState = () => {
      let state = {};
      try { state = updater.getState() || {}; } catch (e) { state = { error: e.message }; }
      let autoEnabled = true, checkEnabled = true;
      try { const uc = readUpdateConfig(); autoEnabled = uc.auto; checkEnabled = uc.check; } catch (e) {}
      return { ...state, autoEnabled, checkEnabled };
    };
    if (parsed.pathname === '/api/update' && req.method === 'GET') {
      return json(200, updateState());
    }
    if (parsed.pathname === '/api/update/check' && req.method === 'POST') {
      try { if (!readUpdateConfig().check) return json(409, { reason: 'updates-disabled' }); } catch (e) {}
      return Promise.resolve()
        .then(() => updater.check())
        .then(() => json(200, updateState()))
        .catch(e => json(500, { ...updateState(), error: e.message }));
    }
    if (parsed.pathname === '/api/update/config' && req.method === 'POST') {
      return readBody(req, body => {
        try {
          const file = path.join(STATE_DIR, 'config.json');
          // Read the existing config. If the file EXISTS but doesn't parse, refuse to write — else we'd
          // silently drop clientMap and every other sibling key. A missing file (ENOENT) is fine to create.
          let config = {}, existed = false, parseOk = true;
          try { const rawCfg = fs.readFileSync(file, 'utf8'); existed = true; try { config = JSON.parse(rawCfg); } catch (e) { parseOk = false; } }
          catch (e) { if (e.code !== 'ENOENT') return json(200, updateState()); }
          if (existed && !parseOk) return json(200, updateState());
          if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
          const update = config.update && typeof config.update === 'object' && !Array.isArray(config.update) ? { ...config.update } : {};
          if (typeof body.auto === 'boolean') update.auto = body.auto;
          if (typeof body.check === 'boolean') update.check = body.check;
          config.update = update;
          fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2));
          fs.renameSync(file + '.tmp', file);
        } catch (e) {}
        json(200, updateState());
      });
    }
    if (parsed.pathname === '/api/update/apply' && req.method === 'POST') {
      // the kill switch gates applying too — a disabled updater must not act on stale state
      try { if (!readUpdateConfig().check) return json(409, { reason: 'updates-disabled' }); } catch (e) {}
      return Promise.resolve()
        .then(() => updater.applyUpdate())
        .then(result => {
          const state = result || {};
          if (state.error || state.status === 'error') return json(500, { ...state, reason: 'update-failed' });
          const reason = state.blocked || (state.status && state.status !== 'started' ? state.status : '');
          if (reason) return json(409, { ...state, reason: String(reason) });
          return json(202, state);
        })
        .catch(e => json(500, { reason: 'update-failed', error: e.message }));
    }
    res.writeHead(405); return res.end();
  }

  if (parsed.pathname === '/api/usage') {
    let cache = {};
    try {
      cache = usageMod.readCache() || {};
      const now = Date.now();
      // Decide the "This Week" tile mode here (request time = fresh `now` for the staleness/week-boundary
      // check), so the browser renders a pre-computed, unit-tested decision instead of its own logic.
      cache.weekTile = usageMod.weekTileMode(cache, now);
      cache.weekProjection = usageMod.weeklyProjection(cache, now);
      const framing = usageMod.weeklyFraming(cache, now);
      if (framing) cache.framing = framing;
      else delete cache.framing;
    } catch (e) { cache = {}; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cache));
  }
  // Model catalog for every provider (sync read of the warm registry — never spawns a CLI here).
  // ?refresh=1 kicks a busy-guarded, 60s-throttled background refresh and returns the current catalog immediately.
  if (parsed.pathname === '/api/models') {
    if (parsed.searchParams.get('refresh') === '1') {
      try { modelsMod.requestRefresh(); } catch (e) {}
    }
    let catalog = {};
    try { catalog = modelsMod.getCatalog(); } catch (e) { catalog = {}; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(catalog));
  }
  if (parsed.pathname === '/api/providers/ollama/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return Promise.resolve(ollamaMod.listModels())
      .then(models => res.end(JSON.stringify(models)))
      .catch(() => res.end(JSON.stringify([...ollamaMod.FALLBACK_MODELS])));
  }
  if (parsed.pathname === '/api/watchers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(watchersMod.readAll()));
  }
  if (parsed.pathname === '/api/workers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try { return res.end(JSON.stringify({ codex: codexMod.activeTasks() })); }
    catch (e) { return res.end(JSON.stringify({ codex: [] })); }
  }
  if (parsed.pathname === '/api/new-chat-defaults') {
    let defaults = {};
    try { defaults = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'new-chat-defaults.json'), 'utf8')); } catch (e) { defaults = {}; }
    // A saved model that has since been retired (or never discovered) falls back to its provider default.
    try {
      if (defaults && typeof defaults === 'object' && typeof defaults.model === 'string') {
        const provider = ['claude', 'codex', 'ollama', 'agy'].includes(defaults.provider) ? defaults.provider : 'claude';
        if (!modelsMod.isAllowedModel(provider, defaults.model)) {
          const fallback = modelsMod.defaultModel(provider);
          if (fallback) defaults.model = fallback;
        }
        // Model still offered but the saved effort isn't valid for it (or the model was swapped): repair.
        if (modelsMod.isAllowedModel(provider, defaults.model)) {
          const efforts = modelsMod.effortsFor(provider, defaults.model);
          if (efforts.length && !efforts.includes(defaults.effort)) defaults.effort = modelsMod.defaultEffort(provider, defaults.model);
        }
      }
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(defaults));
  }
  if (parsed.pathname === '/falaq-logo.png') {
    const p = path.join(DIR, 'falaq-icon-1024.png');
    if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(p)); }
    res.writeHead(404); return res.end();
  }

  if (parsed.pathname.startsWith('/api/chats')) {
    if (req.headers['x-cockpit-token'] !== TOKEN) {
      const body = JSON.stringify({ error: 'forbidden' });
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }); return res.end(body);
    }
    const jm = parsed.pathname.match(/^\/api\/chats(?:\/(ck-[a-z0-9-]{1,40})(?:\/(screen|cursor|input|keys|term|transcript|messages|files|file|upload|wrap))?)?$/);
    if (!jm) { res.writeHead(404); return res.end(); }
    const name = jm[1], action = jm[2];
    const json = (code, obj, headers) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', ...(headers || {}) });
      res.end(body);
    };
    try {
      // Closed (archived) chats are opt-in: only /chat's history section asks for them, so /live
      // and /m keep their existing open-chats view untouched.
      if (req.method === 'GET' && !name) {
        const withClosed = parsed.searchParams.get('closed') === '1';
        return json(200, chatsMod.listChats().filter(c => withClosed || !c.closed));
      }
      if (req.method === 'POST' && !name) {
        return readBody(req, body => {
          chatsMod.createChat(body, (err, chat) => {
            if (err) return json(400, { error: err.message });
            try {
              const defFile = path.join(STATE_DIR, 'new-chat-defaults.json');
              const defaults = { provider: body.provider || 'claude', model: body.model, effort: body.effort, ultracode: !!body.ultracode };
              fs.writeFileSync(defFile + '.tmp', JSON.stringify(defaults));
              fs.renameSync(defFile + '.tmp', defFile);
            } catch (e) {}
            json(201, chat);
          });
        });
      }
      if (req.method === 'GET' && name && action === 'screen') {
        // pane is now 200 rows tall — capture the whole virtual frame so the panel can scroll it
        const text = chatsMod.screen(name, 300);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (req.method === 'GET' && name && action === 'cursor') {
        let c = '';
        try { c = chatsMod.cursor(name); } catch (e) { c = ''; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(c);
      }
      if (req.method === 'GET' && name && action === 'transcript') {
        // Read-only "whole session" view. The client passes the correlated session's transcriptPath;
        // we only serve it if it's a known session transcript (whitelist) AND under ~/.claude/projects.
        const p = parsed.searchParams.get('path') || '';
        const text = (p && knownTranscriptPaths().has(p)) ? transcriptMod.readTranscript(p) : '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (req.method === 'GET' && name && action === 'messages') {
        const chat = controlledChat(name);
        if (chat && chat.mediated) return json(200, mediatedTurns(name));
        // Structured turns for the /chat bubble view. Same gate as /transcript: only a transcript
        // the dashboard already tracks may be read, and parseTranscript re-jails to ~/.claude/projects.
        const p = parsed.searchParams.get('path') || '';
        const turns = (p && knownTranscriptPaths().has(p)) ? transcriptMod.parseTranscript(p) : [];
        return json(200, turns);
      }
      if (req.method === 'GET' && name && action === 'files') {
        const chat = controlledChat(name);
        const safeHeaders = { 'X-Content-Type-Options': 'nosniff' };
        if (chat && chat.mediated) return json(200, [], safeHeaders);
        const p = parsed.searchParams.get('path') || '';
        const session = trackedTranscript(p);
        if (!session || !transcriptMod.isAllowed(p)) return json(404, { error: 'transcript not found' }, safeHeaders);
        const cwd = session.cwd || (chat && chat.cwd) || '.';
        const touched = transcriptMod.filesTouched(p, { cwd });
        const files = touched.map(item => {
          try {
            const real = resolveRecordedFile(item.path, cwd);
            if (!real) throw new Error('unstable file path');
            const st = fs.statSync(real);
            if (!st.isFile()) throw new Error('not a file');
            return { path: item.path, name: path.basename(item.path), exists: true, size: st.size, mtime: st.mtimeMs };
          } catch (e) {
            return { path: item.path, name: path.basename(item.path), exists: false, size: 0, mtime: null };
          }
        });
        return json(200, files, safeHeaders);
      }
      if (req.method === 'GET' && name && action === 'file') {
        const chat = controlledChat(name);
        if (chat && chat.mediated) return json(404, { error: 'file not found' }, { 'X-Content-Type-Options': 'nosniff' });
        const p = parsed.searchParams.get('path') || '';
        const requested = parsed.searchParams.get('file') || '';
        const session = trackedTranscript(p);
        if (!session || !transcriptMod.isAllowed(p)) return json(404, { error: 'transcript not found' }, { 'X-Content-Type-Options': 'nosniff' });
        const cwd = session.cwd || (chat && chat.cwd) || '.';
        const member = transcriptMod.filesTouched(p, { cwd }).find(item => item.path === requested);
        if (!member) return json(404, { error: 'file not found' }, { 'X-Content-Type-Options': 'nosniff' });
        let real, recordedReal, data, tooLarge = false;
        try {
          recordedReal = resolveRecordedFile(member.path, cwd);
          real = resolveRecordedFile(requested, cwd);
          if (!real || real !== recordedReal) throw new Error('file changed');
          const fd = fs.openSync(real, 'r');
          try {
            const st = fs.fstatSync(fd);
            if (!st.isFile()) throw new Error('not a file');
            if (st.size > FILE_PREVIEW_MAX) tooLarge = true;
            else {
              data = Buffer.alloc(st.size);
              let offset = 0;
              while (offset < data.length) {
                const n = fs.readSync(fd, data, offset, data.length - offset, offset);
                if (!n) break;
                offset += n;
              }
              if (offset !== data.length) data = data.subarray(0, offset);
            }
          } finally { fs.closeSync(fd); }
        } catch (e) {
          return json(404, { error: 'file not found' }, { 'X-Content-Type-Options': 'nosniff' });
        }
        if (tooLarge) return json(413, { error: 'download too large; open locally' }, { 'X-Content-Type-Options': 'nosniff' });
        const info = fileResponseType(real);
        const forceDownload = parsed.searchParams.get('download') === '1';
        const headers = { 'Content-Type': info.type, 'X-Content-Type-Options': 'nosniff' };
        if (info.attachment || forceDownload) headers['Content-Disposition'] = 'attachment; filename="' + attachmentName(real) + '"';
        res.writeHead(200, headers);
        return res.end(data);
      }
      if (req.method === 'POST' && name && action === 'input') {
        return readBody(req, body => {
          try {
            const chat = controlledChat(name);
            if (chat && chat.mediated) {
              const generation = ollamaChat.send(name, chat.model, body.text || '');
              Promise.resolve(generation).catch(() => {}); // failure is persisted as an honest assistant turn
              return json(202, { busy: true });
            }
            chatsMod.sendInput(name, body.text || '');
            // Manual input IS the recovery for a lost first prompt: clear the markers so the badge
            // goes away and /wrap is allowed again.
            if (String(body.text || '').trim()) { try { chatsMod.clearPromptState(name); } catch (e) {} }
            json(200, { ok: true });
          } catch (e) {
            const status = e && (e.statusCode || e.status) === 409 ? 409 : 400;
            json(status, { error: e.message, ...(status === 409 ? { busy: true } : {}) });
          }
        });
      }
      if (req.method === 'POST' && name && action === 'wrap') {
        const chat = controlledChat(name);
        if (!chat) return json(400, { error: 'chat not found or not controlled' });
        if ((chat.provider || 'claude') !== 'claude') return json(400, { error: 'manual wrap is only available for Claude chats' });
        if (!chat.alive) return json(400, { error: 'chat is not alive' });
        if (chat.mediated) return json(400, { error: 'mediated chats cannot be wrapped' });
        if (chat.promptUndelivered || chat.pendingPrompt) return json(409, { error: 'this chat never received its first prompt — nothing to wrap; send the prompt by hand first' });
        // Resolve the session BEFORE typing anything. A chat name can appear on an older ended
        // session file, so pick the most recently active matching session. Legacy chats with no
        // tracked session still wrap (historical contract); a tracked session whose transcript
        // exists but carries no assistant usage yet has never been prompted — wrapping it types a
        // "close out" into an empty REPL (live 2026-09-06: the fresh chat then hallucinated a
        // close-out for work it never did). Refuse that instead of failing soft after the send.
        let match = null;
        try {
          match = buildSessions()
            .filter(s => s && s.chatName === name && (s.provider || 'claude') === 'claude' && s.sessionId)
            .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))[0] || null;
        } catch (e) {}
        // "Never prompted" needs positive evidence, not a missing number: the transcript must be
        // readable AND carry no assistant usage AND the hook must have recorded no prompt submission.
        // A rotated/unreadable transcript or a null context for any other reason must not block a
        // legitimate wrap (Review panel MAJOR #3).
        let neverPrompted = false;
        if (match && !match.lastPrompt && match.transcriptPath && !match.context) {
          try { neverPrompted = fs.statSync(match.transcriptPath).isFile(); } catch (e) { neverPrompted = false; }
        }
        if (neverPrompted) return json(409, { error: 'this chat has not received its first prompt yet — nothing to wrap' });
        chatsMod.sendInput(name, autowrapMod.WRAP_MSG);
        // Register the manual wrap in autowrap's per-session state so tick() can't double-inject
        // WRAP_MSG and autoRestart continues this session too.
        if (match) { try { autowrapMod.markWrapped(match.sessionId, Date.now()); } catch (e) {} }
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && name && action === 'keys') {
        return readBody(req, body => {
          try { chatsMod.sendKey(name, String(body.key || '')); _pendingCache.delete(name); json(200, { ok: true }); }
          catch (e) { json(400, { error: e.message }); }
        });
      }
      if (req.method === 'POST' && name && action === 'term') {
        return readBody(req, body => {
          try { chatsMod.sendTermKey(name, { t: body.t, v: body.v }); json(200, { ok: true }); }
          catch (e) { json(400, { error: e.message }); }
        });
      }
      if (req.method === 'POST' && name && action === 'upload') {
        // Base64 expands a 15 MB file to roughly 20 MB. Keep the ordinary JSON
        // routes on their small limit while allowing enough room to parse and
        // explicitly reject a just-over-limit decoded upload.
        return readBody(req, (body, bodyError) => {
          if (bodyError) return json(400, { error: bodyError.message });
          try {
            const savedPath = chatsMod.saveUpload(STATE_DIR, name, body.filename, body.dataBase64);
            json(200, { path: savedPath });
          } catch (e) { json(400, { error: e.message }); }
        }, 24 * 1024 * 1024);
      }
      if (req.method === 'DELETE' && name && !action) {
        // capture the linked session's transcript BEFORE the kill so the closed record can replay it
        let tp = null;
        try {
          const sessionsDir = path.join(STATE_DIR, 'sessions');
          let newest = 0;
          for (const f of fs.readdirSync(sessionsDir)) {
            if (!f.endsWith('.json')) continue;
            try {
              const sess = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
              if (sess && sess.chatName === name && sess.transcriptPath && (sess.lastActivityAt || 0) >= newest) { newest = sess.lastActivityAt || 0; tp = sess.transcriptPath; }
            } catch (e) {}
          }
        } catch (e) {}
        chatsMod.killChat(name, { transcriptPath: tp });
        return json(200, { ok: true });
      }
      if (name && (action === 'files' || action === 'file')) {
        return json(405, { error: 'method not allowed' }, { 'X-Content-Type-Options': 'nosniff' });
      }
      res.writeHead(405); return res.end();
    } catch (e) {
      const safeHeaders = action === 'files' || action === 'file' ? { 'X-Content-Type-Options': 'nosniff' } : undefined;
      return json(400, { error: e.message }, safeHeaders);
    }
  }

  if (parsed.pathname === '/api/autowrap') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET') return json(autowrapMod.readConfig());
    if (req.method === 'POST') {
      return readBody(req, body => {
        try {
          const file = path.join(STATE_DIR, 'config.json');
          // Read the existing config. If the file EXISTS but doesn't parse, refuse to write — else we'd
          // silently drop clientMap and every other sibling key. A missing file (ENOENT) is fine to create.
          let config = {}, existed = false, parseOk = true;
          try { const rawCfg = fs.readFileSync(file, 'utf8'); existed = true; try { config = JSON.parse(rawCfg); } catch (e) { parseOk = false; } }
          catch (e) {}
          if (existed && !parseOk) return json(autowrapMod.readConfig());
          if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
          const autoWrap = config.autoWrap && typeof config.autoWrap === 'object' && !Array.isArray(config.autoWrap) ? { ...config.autoWrap } : {};
          if (typeof body.enabled === 'boolean') autoWrap.enabled = body.enabled;
          if (typeof body.autoRestart === 'boolean') autoWrap.autoRestart = body.autoRestart;
          if (typeof body.thresholdPct === 'number' && Number.isFinite(body.thresholdPct) && body.thresholdPct > 0 && body.thresholdPct <= 1) autoWrap.thresholdPct = body.thresholdPct;
          config.autoWrap = autoWrap;
          fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2));
          fs.renameSync(file + '.tmp', file);
        } catch (e) {}
        json(autowrapMod.readConfig());
      });
    }
    res.writeHead(405); return res.end();
  }

  if (parsed.pathname === '/api/dispatch' || parsed.pathname === '/api/dispatch/run' || parsed.pathname === '/api/dispatch/kill') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const mergeDispatchConfig = (body) => {
      const file = path.join(STATE_DIR, 'config.json');
      let config = {}, existed = false, parseOk = true;
      try { const rawCfg = fs.readFileSync(file, 'utf8'); existed = true; try { config = JSON.parse(rawCfg); } catch (e) { parseOk = false; } }
      catch (e) {}
      if (existed && !parseOk) return false;
      if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
      const dispatch = config.dispatch && typeof config.dispatch === 'object' && !Array.isArray(config.dispatch) ? { ...config.dispatch } : {};
      if (typeof body.enabled === 'boolean') dispatch.enabled = body.enabled;
      if (Number.isInteger(body.concurrency) && body.concurrency > 0) dispatch.concurrency = body.concurrency;
      if (typeof body.dryRun === 'boolean') dispatch.dryRun = body.dryRun;
      if (body.caps && typeof body.caps === 'object' && !Array.isArray(body.caps)) dispatch.caps = { ...(dispatch.caps || {}), ...body.caps };
      if (typeof body.slackChannelId === 'string') dispatch.slackChannelId = body.slackChannelId;
      if (Array.isArray(body.slackTriggerUserIds)) dispatch.slackTriggerUserIds = body.slackTriggerUserIds;
      config.dispatch = dispatch;
      fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2));
      fs.renameSync(file + '.tmp', file);
      return true;
    };
    if (parsed.pathname === '/api/dispatch' && req.method === 'GET') return json(200, { config: dispatchMod.readConfig(), state: dispatchMod.loadState() });
    if (parsed.pathname === '/api/dispatch' && req.method === 'POST') return readBody(req, body => {
      try { mergeDispatchConfig(body); } catch (e) {}
      json(200, { config: dispatchMod.readConfig(), state: dispatchMod.loadState() });
    });
    if (parsed.pathname === '/api/dispatch/run' && req.method === 'POST') return readBody(req, body => {
      if (!Array.isArray(body.tasks)) return json(400, { error: 'tasks must be an array' });
      try {
        const file = dispatchMod._queueFile();
        fs.writeFileSync(file + '.tmp', JSON.stringify({ tasks: body.tasks }, null, 2));
        fs.renameSync(file + '.tmp', file);
        dispatchMod.tick(buildSessions(), undefined, Date.now()).catch(() => {});
        return json(200, { ok: true });
      } catch (e) { return json(400, { error: e.message }); }
    });
    if (parsed.pathname === '/api/dispatch/kill' && req.method === 'POST') return readBody(req, () => {
      try {
        mergeDispatchConfig({ enabled: false });
        const state = dispatchMod.loadState();
        for (const run of Object.values(state.runs || {})) {
          if (run && (run.phase === 'running' || run.phase === 'spawning') && run.chatName) chatsMod.killChat(run.chatName);
        }
      } catch (e) {}
      json(200, { config: dispatchMod.readConfig(), state: dispatchMod.loadState() });
    });
    res.writeHead(405); return res.end();
  }

  if (parsed.pathname === '/api/sessions') {
    const sessions = buildSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sessions));
  }

  if (parsed.pathname === '/live') {
    const liveFile = path.join(DIR, 'live.html');
    try {
      const html = fs.readFileSync(liveFile);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('live.html not installed');
    }
  }

  if (parsed.pathname === '/m') {
    const mobileFile = path.join(DIR, 'mobile.html');
    try {
      const html = fs.readFileSync(mobileFile);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('mobile.html not installed');
    }
  }

  if (parsed.pathname === '/chat') {
    const chatFile = path.join(DIR, 'chat.html');
    try {
      const html = fs.readFileSync(chatFile);
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('chat.html not installed');
    }
  }

  if (parsed.pathname === '/md.js') {
    try {
      const script = fs.readFileSync(path.join(DIR, 'md.js'));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(script);
    } catch (e) {
      res.writeHead(404);
      return res.end('md.js not installed');
    }
  }

  if (parsed.pathname === '/logo.svg') {
    try {
      const svg = fs.readFileSync(path.join(DIR, 'logo.svg'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    } catch (e) {
      res.writeHead(404);
      res.end('Logo not found');
    }
    return;
  }

  if (parsed.pathname === '/') {
    try {
      const html = fs.readFileSync(HOME_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Home page not found. Run the installer first.');
    }
    return;
  }

  if (parsed.pathname === '/help') {
    try {
      const html = fs.readFileSync(HELP_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) {
      res.writeHead(404);
      res.end('help.html not installed');
    }
    return;
  }

  if (parsed.pathname === '/classic' || parsed.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Dashboard not found. Run the installer first.');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// A losing racer must exit, not linger. `listen` errors (almost always EADDRINUSE: another server
// already holds the port) surface here, NOT via the uncaughtException guard above — so log and
// exit(1). Do NOT call cleanup(): the loser never wrote the pid file (that happens only in the
// listen callback below, which it never reaches), and cleanup() would unlink the WINNER's server.pid.
server.on('error', (e) => {
  try { fs.appendFileSync(path.join(DIR, 'error.log'), new Date().toISOString() + ' listen ' + ((e && (e.code || e.stack)) || e) + '\n'); } catch (_) {}
  // Exit only on a listen-phase failure (EADDRINUSE etc.): a server that never bound must die so it
  // can't linger. A post-listen error (server.listening === true) is logged but must NOT kill the
  // healthy winner or leave a stale pid — same "keep serving" stance as the uncaughtException guard.
  if (!server.listening) process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  // Only the process that wins the bind reaches here — so it alone owns the pid file. This keeps the
  // invariant `server.pid == the process actually listening on :PORT` true even under a deploy race.
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) {}
});

// A restart kills every in-memory settle loop: records still carrying pendingPrompt will never be
// typed — flag them undelivered now so the badge, /wrap and dispatch reflect reality.
try { chatsMod.reconcilePendingPrompts(); } catch (e) {}
try { usageMod.refreshPreserving(); } catch (e) {}
setInterval(() => { try { usageMod.refreshPreserving(); } catch (e) {} }, 60000).unref();
// Model registry: immediate + interval background refresh (no-op when CK_MODELS_DISABLE_REFRESH=1, as in tests).
try { modelsMod.start(); } catch (e) {}
refreshOllamaSessions();
setInterval(refreshOllamaSessions, 2500).unref();
setInterval(() => {
  const sessions = buildSessions();
  try { autowrapMod.tick(sessions, undefined, Date.now()); } catch (e) {}
  notifier.tick(sessions).catch(() => {});
}, 30000).unref();
setInterval(() => { dispatchMod.tick(buildSessions(), undefined, Date.now()).catch(() => {}); }, 60000).unref();

// Updating is deliberately best-effort: git/network/deploy failures are recorded by Updater and
// must never interrupt the cockpit. Config is re-read for every run so the kill switch takes effect
// without requiring a restart.
async function runUpdateCheck() {
  try {
    const config = readUpdateConfig();
    if (!config.check) return;
    const state = await updater.check();
    if (config.auto && state && state.behind > 0 && !state.dirty && !state.aheadOrDiverged && !state.blocked && !state.error) {
      await updater.applyUpdate();
    }
  } catch (e) {}
}
setTimeout(runUpdateCheck, 60 * 1000).unref();
setInterval(runUpdateCheck, 6 * 60 * 60 * 1000).unref();

let purposeRefreshRunning = false;
function refreshPurposeTitles() {
  if (purposeRefreshRunning) return;
  purposeRefreshRunning = true;
  purposeTitles.refresh(buildSessions(), Date.now()).catch(() => {}).finally(() => { purposeRefreshRunning = false; });
}
setTimeout(refreshPurposeTitles, 250).unref();
setInterval(refreshPurposeTitles, 60000).unref();

let duplicateRefreshRunning = false;
function refreshDuplicates() {
  if (duplicateRefreshRunning) return;
  duplicateRefreshRunning = true;
  const now = Date.now();
  const sessions = buildSessions()
    .filter(session => dashboardState.isSessionLive(session, now))
    .map(session => duplicatesMod.enrichSession({ ...session, live: true }, now));
  duplicateDetector.refresh(sessions, now)
    .then(pairs => { duplicateSnapshot = { updatedAt: Date.now(), pairs }; })
    .catch(() => {})
    .finally(() => { duplicateRefreshRunning = false; });
}
setTimeout(refreshDuplicates, 500).unref();
setInterval(refreshDuplicates, 60000).unref();

function pollDispatchTrigger() {
  try {
    const config = dispatchMod.readConfig();
    if (!config.enabled || !config.slackChannelId) return;
    dispatchTrigger.pollTrigger({ config }, () => {});
  } catch (e) {}
}
setInterval(pollDispatchTrigger, 45000).unref();

// Flush any watcher notifications that were gated (no webhook configured yet) —
// once a webhook shows up, deliver the pending message and clear the flag.
// Defensive: never throw, never block the event loop (sync reads of small state files only).
function flushPendingNotifies() {
  try {
    const wdir = path.join(STATE_DIR, 'watchers');
    let hasWebhook = false;
    try {
      const whFile = process.env.CK_WEBHOOK_FILE || path.join(STATE_DIR, '.slack-webhook');
      hasWebhook = !!fs.readFileSync(whFile, 'utf8').trim();
    } catch (e) { hasWebhook = false; }
    if (!hasWebhook) return;
    let files = [];
    try { files = fs.readdirSync(wdir).filter(f => f.endsWith('.json')); } catch (e) { return; }
    for (const f of files) {
      try {
        const p = path.join(wdir, f);
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!rec.pendingNotify) continue;
        const text = rec.pendingNotify;
        delete rec.pendingNotify;
        watchersMod.notify(text, () => {});
        fs.writeFileSync(p, JSON.stringify(rec, null, 2));
      } catch (e) {}
    }
  } catch (e) {}
}

function runWatchers() {
  try {
    watchersMod.runAll(buildChecks(), () => { try { flushPendingNotifies(); } catch (e) {} });
  } catch (e) {}
}
runWatchers();
setInterval(runWatchers, 10 * 60 * 1000).unref();

// morning brief: once/day, only when the local hour is >= 9 and not already sent today
function maybeBrief() {
  try {
    const stamp = path.join(STATE_DIR, 'brief-sent.json');
    const today = new Date().toISOString().slice(0, 10);
    let sent = ''; try { sent = JSON.parse(fs.readFileSync(stamp, 'utf8')).date; } catch (e) {}
    if (sent === today) return;
    if (new Date().getHours() < 9) return;
    const ws = watchersMod.readAll();
    // red/error PLUS stale — a stale watcher is holding a value its latest check couldn't confirm
    // (e.g. an expired gmailx token silently sitting on an old hash). Surface it once a day so a
    // silently-broken watcher reaches Slack instead of only the UI border.
    const attn = ws.filter(w => w.state === 'red' || w.state === 'error' || w.stale);
    const label = w => w.name + (w.stale && w.state !== 'error' && w.state !== 'red' ? ' (stale)' : '');
    const dispatchState = dispatchMod.loadState();
    const dispatchLine = dispatchMod.dispatchBriefLine(dispatchState);
    const text = `☀️ *Morning brief* — ${today}\n${ws.length} watchers · ${attn.length} need attention${attn.length ? ': ' + attn.map(label).join(', ') : ''}.${dispatchLine ? '\n' + dispatchLine : ''}`;
    watchersMod.notify(text, () => {});
    if (dispatchLine && Object.values(dispatchState.runs || {}).some(r => r && ['done', 'stuck', 'failed'].includes(r.phase))) dispatchTrigger.spawnBridge('report');
    fs.writeFileSync(stamp, JSON.stringify({ date: today }));
  } catch (e) {}
}
maybeBrief();
setInterval(maybeBrief, 30 * 60 * 1000).unref();
