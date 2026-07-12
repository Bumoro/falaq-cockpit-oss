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
const watchersMod = require('./watchers.js');
const { buildChecks } = require('./watchers/checks.js');
const codexMod = require('./codex.js');
const transcriptMod = require('./transcript.js');
const agentsMod = require('./agents.js');
const promptReader = require('./prompt-reader.js');
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847');
const DIR = __dirname;

// Never let a route error kill the whole server (and everyone connected to it).
// Log it and keep serving. Do NOT process.exit here.
process.on('uncaughtException', (e) => { try { fs.appendFileSync(path.join(DIR, 'error.log'), new Date().toISOString() + ' ' + (e.stack || e) + '\n'); } catch (_) {} });

const EVENTS_FILE = path.join(DIR, 'events.jsonl');
const INDEX_FILE = path.join(DIR, 'index.html');
// Port-aware pid file: the bind winner writes it (see server.listen below) so external tooling / a
// human can find the live listener; a custom AGENT_DASHBOARD_PORT (e.g. tests) gets its own
// server-<PORT>.pid. start.js does NOT read this — it probes the port to decide whether to start.
const PID_FILE = path.join(DIR, process.env.AGENT_DASHBOARD_PORT ? `server-${PORT}.pid` : 'server.pid');

const STATE_DIR = process.env.COCKPIT_DIR || DIR;
const TOKEN_FILE = path.join(STATE_DIR, '.token');
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { TOKEN = ''; }
if (!/^[0-9a-f]{48}$/.test(TOKEN)) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
  req.on('end', () => { let b = {}; try { b = JSON.parse(data || '{}'); } catch (e) {} cb(b); });
}

// Cheap, cached read of a controlled chat's pending prompt (tmux capture is spawned per call, so
// cache briefly — /api/sessions is polled ~1/s and only WAITING chats are ever screened).
const _pendingCache = new Map(); // name -> { t, val }
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
  return set;
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

const server = http.createServer((req, res) => {
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
    const agentEvents = allEvents.filter(e => e.type === 'agent_spawn').reverse();
    for (const evt of agentEvents) {
      if (!activeAgents[evt.agent] && evt.agent !== 'Unknown') {
        activeAgents[evt.agent] = evt;
      }
    }

    // Get task state
    const tasks = {};
    for (const evt of allEvents) {
      if (evt.type === 'task_create') {
        tasks[evt.task] = { ...evt, status: 'in_progress' };
      } else if (evt.type === 'task_update' && evt.status === 'completed') {
        // Mark matching task as done
        for (const key of Object.keys(tasks)) {
          if (tasks[key].taskId === evt.taskId || key === evt.taskId) {
            tasks[key].status = 'completed';
            tasks[key].completedAt = evt.timestamp;
          }
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: newEvents.slice(-100),
      agents: activeAgents,
      tasks: Object.values(tasks),
      stats: stats,
      serverTime: Date.now()
    }));
    return;
  }

  if (parsed.pathname === '/api/token') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(TOKEN);
  }

  if (parsed.pathname === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(usageMod.readCache() || {}));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(defaults));
  }
  if (parsed.pathname === '/falaq-logo.png') {
    const p = path.join(DIR, 'falaq-icon-1024.png');
    if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(fs.readFileSync(p)); }
    res.writeHead(404); return res.end();
  }

  if (parsed.pathname.startsWith('/api/chats')) {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    const jm = parsed.pathname.match(/^\/api\/chats(?:\/(ck-[a-z0-9-]{1,40})(?:\/(screen|input|keys|term|transcript|messages))?)?$/);
    if (!jm) { res.writeHead(404); return res.end(); }
    const name = jm[1], action = jm[2];
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && !name) return json(200, chatsMod.listChats());
      if (req.method === 'POST' && !name) {
        return readBody(req, body => {
          chatsMod.createChat(body, (err, chat) => {
            if (err) return json(400, { error: err.message });
            try {
              const defFile = path.join(STATE_DIR, 'new-chat-defaults.json');
              const defaults = { model: body.model, effort: body.effort, ultracode: !!body.ultracode };
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
      if (req.method === 'GET' && name && action === 'transcript') {
        // Read-only "whole session" view. The client passes the correlated session's transcriptPath;
        // we only serve it if it's a known session transcript (whitelist) AND under ~/.claude/projects.
        const p = parsed.searchParams.get('path') || '';
        const text = (p && knownTranscriptPaths().has(p)) ? transcriptMod.readTranscript(p) : '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (req.method === 'GET' && name && action === 'messages') {
        // Structured turns for the /chat bubble view. Same gate as /transcript: only a transcript
        // the dashboard already tracks may be read, and parseTranscript re-jails to ~/.claude/projects.
        const p = parsed.searchParams.get('path') || '';
        const turns = (p && knownTranscriptPaths().has(p)) ? transcriptMod.parseTranscript(p) : [];
        return json(200, turns);
      }
      if (req.method === 'POST' && name && action === 'input') {
        return readBody(req, body => {
          try { chatsMod.sendInput(name, body.text || ''); json(200, { ok: true }); }
          catch (e) { json(400, { error: e.message }); }
        });
      }
      if (req.method === 'POST' && name && action === 'keys') {
        return readBody(req, body => {
          try { chatsMod.sendKey(name, String(body.key || '')); json(200, { ok: true }); }
          catch (e) { json(400, { error: e.message }); }
        });
      }
      if (req.method === 'POST' && name && action === 'term') {
        return readBody(req, body => {
          try { chatsMod.sendTermKey(name, { t: body.t, v: body.v }); json(200, { ok: true }); }
          catch (e) { json(400, { error: e.message }); }
        });
      }
      if (req.method === 'DELETE' && name && !action) { chatsMod.killChat(name); return json(200, { ok: true }); }
      res.writeHead(405); return res.end();
    } catch (e) { return json(400, { error: e.message }); }
  }

  if (parsed.pathname === '/api/sessions') {
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
    sessions = sessions.map(s => {
      const extra = {};
      if (s.transcriptPath) {
        try { const c = contextMod.contextForTranscript(s.transcriptPath); if (c) extra.context = c; } catch (e) {}
        try { const la = agentsMod.activeAgents(s.transcriptPath); if (la.length) extra.liveAgents = la; } catch (e) {}
      }
      // Only WAITING, cockpit-CONTROLLED chats can be answered from the card.
      try {
        if (s.state === 'needs_you' && s.chatName) {
          const p = pendingFor(s.chatName);
          if (p && p.kind !== 'none') extra.pending = p;
        }
      } catch (e) {}
      return Object.keys(extra).length ? { ...s, ...extra } : s;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sessions));
  }

  if (parsed.pathname === '/live') {
    const liveFile = path.join(DIR, 'live.html');
    try {
      const html = fs.readFileSync(liveFile);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('live.html not installed');
    }
  }

  if (parsed.pathname === '/chat') {
    const chatFile = path.join(DIR, 'chat.html');
    try {
      const html = fs.readFileSync(chatFile);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('chat.html not installed');
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

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(INDEX_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
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

try { usageMod.refreshPreserving(); } catch (e) {}
setInterval(() => { try { usageMod.refreshPreserving(); } catch (e) {} }, 60000).unref();

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
    const text = `☀️ *Morning brief* — ${today}\n${ws.length} watchers · ${attn.length} need attention${attn.length ? ': ' + attn.map(label).join(', ') : ''}.`;
    watchersMod.notify(text, () => {});
    fs.writeFileSync(stamp, JSON.stringify({ date: today }));
  } catch (e) {}
}
maybeBrief();
setInterval(maybeBrief, 30 * 60 * 1000).unref();
