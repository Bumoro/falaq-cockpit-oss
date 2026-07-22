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
const autowrapMod = require('./autowrap.js');
const dispatchMod = require('./dispatch.js');
const dispatchTrigger = require('./dispatch/trigger.js');
const dashboardState = require('./dashboard-state.js');
const purposeMod = require('./purpose.js');
const duplicatesMod = require('./duplicates.js');
const updaterMod = require('./updater.js');
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847');
const DIR = __dirname;
const STATE_DIR = process.env.COCKPIT_DIR || DIR;

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
let duplicateSnapshot = { updatedAt: 0, pairs: [] };
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) { TOKEN = ''; }
if (!/^[0-9a-f]{48}$/.test(TOKEN)) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
}

function readBody(req, cb, maxBytes = 1e5) {
  let data = '';
  let bytes = 0;
  let tooLarge = false;
  req.on('data', c => {
    if (tooLarge) return;
    bytes += Buffer.byteLength(c);
    if (bytes > maxBytes) { tooLarge = true; data = ''; return; }
    data += c;
  });
  req.on('end', () => {
    if (tooLarge) return cb({}, new Error('request body is too large'));
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
  return set;
}

function buildSessions() {
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
  return claude.concat(codex);
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
      const freshSessions = buildSessions();
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
    });
  }

  if (parsed.pathname === '/api/token') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(TOKEN);
  }

  if (parsed.pathname === '/api/update' || parsed.pathname === '/api/update/apply') {
    if (req.headers['x-cockpit-token'] !== TOKEN) { res.writeHead(403); return res.end('forbidden'); }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (parsed.pathname === '/api/update' && req.method === 'GET') {
      let state = {};
      try { state = updater.getState() || {}; } catch (e) { state = { error: e.message }; }
      let autoEnabled = true, checkEnabled = true;
      try { const uc = readUpdateConfig(); autoEnabled = uc.auto; checkEnabled = uc.check; } catch (e) {}
      return json(200, { ...state, autoEnabled, checkEnabled });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const cache = usageMod.readCache() || {};
    const now = Date.now();
    // Decide the "This Week" tile mode here (request time = fresh `now` for the staleness/week-boundary
    // check), so the browser renders a pre-computed, unit-tested decision instead of its own logic.
    cache.weekTile = usageMod.weekTileMode(cache, now);
    cache.weekProjection = usageMod.weeklyProjection(cache, now);
    const framing = usageMod.weeklyFraming(cache, now);
    if (framing) cache.framing = framing;
    else delete cache.framing;
    return res.end(JSON.stringify(cache));
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
    const jm = parsed.pathname.match(/^\/api\/chats(?:\/(ck-[a-z0-9-]{1,40})(?:\/(screen|cursor|input|keys|term|transcript|messages|upload))?)?$/);
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
      if (req.method === 'DELETE' && name && !action) { chatsMod.killChat(name); return json(200, { ok: true }); }
      res.writeHead(405); return res.end();
    } catch (e) { return json(400, { error: e.message }); }
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
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

  if (parsed.pathname === '/') {
    try {
      const html = fs.readFileSync(HOME_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
      res.writeHead(200, { 'Content-Type': 'text/html' });
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
setInterval(() => { try { autowrapMod.tick(buildSessions(), undefined, Date.now()); } catch (e) {} }, 30000).unref();
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
