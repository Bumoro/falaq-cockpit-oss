// notify.js — delayed, episode-deduplicated Slack alerts for sessions that need a human.
// Zero dependencies; decision logic and transport are injectable for deterministic tests.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DEFAULTS = {
  enabled: true,
  slackChannelId: '',
  delaySec: 20,
  cooldownMin: 15,
  url: 'http://localhost:3847/m',
};

function normalizeConfig(raw) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    slackChannelId: typeof raw.slackChannelId === 'string' ? raw.slackChannelId.trim() : DEFAULTS.slackChannelId,
    delaySec: typeof raw.delaySec === 'number' && Number.isFinite(raw.delaySec) && raw.delaySec >= 0 ? raw.delaySec : DEFAULTS.delaySec,
    cooldownMin: typeof raw.cooldownMin === 'number' && Number.isFinite(raw.cooldownMin) && raw.cooldownMin >= 0 ? raw.cooldownMin : DEFAULTS.cooldownMin,
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULTS.url,
  };
}

function readNotifyConfig(stateDir) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).notify || {}; } catch (e) {}
  return normalizeConfig(raw);
}

function stateFile(stateDir) { return path.join(stateDir, 'notify-state.json'); }

function loadNotifyState(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) { return {}; }
}

function saveNotifyState(stateDir, state) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = stateFile(stateDir);
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch (e) {
    try { fs.appendFileSync(path.join(stateDir, 'error.log'), new Date().toISOString() + ' notify saveState ' + ((e && e.message) || e) + '\n'); } catch (_) {}
    return false;
  }
}

function cleanEpisode(record) {
  const next = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } : {};
  delete next.firstSeenAt;
  delete next.notifiedThisEpisode;
  delete next.episodeKey;
  return next;
}

function decideNotifications(sessions, state, rawConfig, now) {
  const config = normalizeConfig(rawConfig);
  const previous = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const previousSessions = previous.sessions && typeof previous.sessions === 'object' && !Array.isArray(previous.sessions) ? previous.sessions : {};
  const nextState = { ...previous, sessions: {} };
  for (const [id, record] of Object.entries(previousSessions)) nextState.sessions[id] = { ...record };
  const notifications = [];
  const current = Array.isArray(sessions) ? sessions : [];
  const present = new Set(current.map(session => session && (session.sessionId || session.chatName)).filter(Boolean).map(String));

  // A missing/ended/recovered session closes only the active episode. Its last notification is
  // retained so the per-session cooldown also applies if that same session returns quickly.
  const pruneClock = Number.isFinite(now) ? now : Date.now();
  const pruneMs = normalizeConfig(rawConfig).cooldownMin * 60 * 1000 * 10;
  for (const id of Object.keys(nextState.sessions)) {
    if (present.has(id)) continue;
    const last = Number(nextState.sessions[id] && nextState.sessions[id].lastNotifiedAt);
    // absent + long past any cooldown relevance → drop, or the state file grows forever
    if (!Number.isFinite(last) || pruneClock - last > pruneMs) delete nextState.sessions[id];
    else nextState.sessions[id] = cleanEpisode(nextState.sessions[id]);
  }

  if (!config.enabled) {
    for (const id of Object.keys(nextState.sessions)) nextState.sessions[id] = cleanEpisode(nextState.sessions[id]);
    nextState.idleReason = 'disabled';
    return { notifications, nextState };
  }

  delete nextState.idleReason;
  const clock = Number.isFinite(now) ? now : Date.now();
  const delayMs = config.delaySec * 1000;
  const cooldownMs = config.cooldownMin * 60 * 1000;
  for (const session of current) {
    if (!session) continue;
    const idValue = session.sessionId || session.chatName;
    if (!idValue) continue;
    const id = String(idValue);
    let record = nextState.sessions[id] && typeof nextState.sessions[id] === 'object' ? { ...nextState.sessions[id] } : {};
    const qualifiesForEpisode = session.state === 'needs_you' && session.chatAlive !== false;
    if (!qualifiesForEpisode) {
      nextState.sessions[id] = cleanEpisode(record);
      continue;
    }
    // Key the episode on when needs_you was raised — an answer + a NEW question between two
    // 30s ticks changes needsYou.at, which must reset the episode or it never notifies again.
    const episodeKey = String((session.needsYou && session.needsYou.at) || '');
    if (record.episodeKey !== undefined && record.episodeKey !== episodeKey) {
      record = cleanEpisode(record);
    }
    record.episodeKey = episodeKey;
    if (!Number.isFinite(record.firstSeenAt)) record.firstSeenAt = clock;
    const delayElapsed = clock - record.firstSeenAt >= delayMs;
    const cooldownElapsed = !Number.isFinite(record.lastNotifiedAt) || clock - record.lastNotifiedAt >= cooldownMs;
    if (delayElapsed && cooldownElapsed && !record.notifiedThisEpisode) {
      notifications.push(session);
      record.notifiedThisEpisode = true;
      record.lastNotifiedAt = clock;
    }
    nextState.sessions[id] = record;
  }
  return { notifications, nextState };
}

function oneLine(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function truncate(value, max = 140) {
  const text = oneLine(value);
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Session-controlled text is untrusted for Slack markup — a prompt containing <!channel> or
// <@U…> must render as literal text, never as a live mention.
function slackEscape(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildMessage(session, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const title = truncate(session && (session.purposeTitle || session.chatName || session.sessionId), 120) || 'Session';
  const prompt = truncate(session && ((session.pending && session.pending.title) || (session.needsYou && session.needsYou.message) || session.lastPrompt)) || 'Waiting for your response.';
  return `🔴 Needs you: ${slackEscape(title)}\n${slackEscape(prompt)}\n${config.url}`;
}

function postSlack(payload) {
  return new Promise(resolve => {
    const body = JSON.stringify({ channel: payload.channel, text: payload.text });
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    let req;
    try {
      req = https.request({
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        timeout: 10_000,
        headers: {
          Authorization: `Bearer ${payload.token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { if (data.length < 64 * 1024) data += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(data || '{}'); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok === true) return finish({ ok: true, ts: parsed.ts });
          finish({ ok: false, error: parsed.error || `http-${res.statusCode || 0}` });
        });
      });
      req.on('error', error => finish({ ok: false, error: (error && error.message) || 'network-error' }));
      req.on('timeout', () => { req.destroy(new Error('timeout')); finish({ ok: false, error: 'timeout' }); });
      req.end(body);
    } catch (error) {
      if (req) req.destroy();
      finish({ ok: false, error: (error && error.message) || 'network-error' });
    }
  });
}

class Notifier {
  constructor(options = {}) {
    this.stateDir = options.stateDir || process.env.COCKPIT_DIR || __dirname;
    this.postSlack = options.postSlack || postSlack;
    this.now = options.now || Date.now;
    this.running = false;
  }

  token() {
    try { return fs.readFileSync(path.join(this.stateDir, '.slack-bot-token'), 'utf8').trim(); } catch (e) { return ''; }
  }

  getStatus(rawConfig) {
    const config = normalizeConfig(rawConfig === undefined ? readNotifyConfig(this.stateDir) : rawConfig);
    const state = loadNotifyState(this.stateDir);
    let idleReason = state.idleReason || null;
    if (!config.enabled) idleReason = 'disabled';
    else if (!config.slackChannelId) idleReason = 'missing-channel';
    else if (!this.token()) idleReason = 'missing-token';
    else if (['disabled', 'missing-channel', 'missing-token'].includes(idleReason)) idleReason = null;
    return {
      enabled: config.enabled,
      idleReason,
      lastSentAt: state.lastSentAt || null,
      lastError: state.lastError || null,
    };
  }

  async tick(sessions, rawConfig) {
    if (this.running) return this.getStatus(rawConfig);
    this.running = true;
    try {
      const config = normalizeConfig(rawConfig === undefined ? readNotifyConfig(this.stateDir) : rawConfig);
      const clock = typeof this.now === 'function' ? Number(this.now()) : (Number.isFinite(this.now) ? this.now : Date.now());
      let state = loadNotifyState(this.stateDir);
      const token = this.token();
      let idleReason = null;
      if (!config.enabled) idleReason = 'disabled';
      else if (!config.slackChannelId) idleReason = 'missing-channel';
      else if (!token) idleReason = 'missing-token';

      // Dependency-idle time must not count toward the needs-you delay. Treat it like the kill switch
      // for episode tracking, then replace the generic disabled reason with the actionable cause.
      const decision = decideNotifications(sessions, state, idleReason ? { ...config, enabled: false } : config, clock);
      state = decision.nextState;
      state.idleReason = idleReason;
      // Never send unless the episode guard is durable. If persistence is broken, sending first
      // would make every later tick look fresh and create exactly the retry storm this state prevents.
      if (!saveNotifyState(this.stateDir, state)) return { ...this.getStatus(config), lastError: 'state-save-failed' };
      if (idleReason) return this.getStatus(config);

      for (const session of decision.notifications) {
        let result;
        try {
          result = await this.postSlack({ token, channel: config.slackChannelId, text: buildMessage(session, config) });
        } catch (error) {
          result = { ok: false, error: (error && error.message) || String(error) };
        }
        if (result && result.ok) {
          state.lastSentAt = clock;
          state.lastError = null;
        } else {
          state.lastError = (result && result.error) || 'slack-post-failed';
        }
        saveNotifyState(this.stateDir, state);
      }
      return this.getStatus(config);
    } catch (error) {
      const state = loadNotifyState(this.stateDir);
      state.lastError = (error && error.message) || String(error);
      saveNotifyState(this.stateDir, state);
      return this.getStatus(rawConfig);
    } finally {
      this.running = false;
    }
  }
}

module.exports = {
  DEFAULTS,
  Notifier,
  buildMessage,
  decideNotifications,
  loadNotifyState,
  normalizeConfig,
  postSlack,
  readNotifyConfig,
  saveNotifyState,
};
