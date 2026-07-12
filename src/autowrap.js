// autowrap.js — safely wrap controlled chats when their context window is nearly full.
// All state is local, fail-soft, and injectable for deterministic tests.
const fs = require('fs');
const path = require('path');

// Ships OFF by default (opt-in via the /live toggle or config). Auto-injecting a "wrap up and stop"
// message into a live controlled chat is a surprising, unattended behavior change, so a fresh install
// never does it until the operator turns it on. (Review panel MAJOR: enabled-by-default footgun.)
const DEFAULTS = { enabled: false, thresholdPct: 0.85, autoRestart: false };
const WRAP_MSG = "We're running low on context (auto-wrap). Follow your session-close protocol now: write the session log / update your task tracker as your setup dictates, then STOP. On the very last line, output the exact prompt to resume this work in a fresh session, wrapped EXACTLY as: <RESUME>your resume prompt here</RESUME> — nothing after it.";

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function _stateFile() { return path.join(stateDir(), 'autowrap-state.json'); }
function configFile() { return path.join(stateDir(), 'config.json'); }

function readConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')).autoWrap || {}; } catch (e) {}
  const thresholdPct = typeof raw.thresholdPct === 'number' && Number.isFinite(raw.thresholdPct) && raw.thresholdPct > 0 && raw.thresholdPct <= 1
    ? raw.thresholdPct : DEFAULTS.thresholdPct;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    thresholdPct,
    autoRestart: typeof raw.autoRestart === 'boolean' ? raw.autoRestart : DEFAULTS.autoRestart,
  };
}

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(_stateFile(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) { return {}; }
}
function saveState(value) {
  try {
    const file = _stateFile();
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    // A silently-failing save would defeat the once-per-session guard (re-inject every idle tick).
    // Stay fail-soft, but surface it so a broken guard is diagnosable. (Review panel MINOR.)
    try { fs.appendFileSync(path.join(stateDir(), 'error.log'), new Date().toISOString() + ' autowrap saveState ' + ((e && e.message) || e) + '\n'); } catch (_) {}
  }
}
function realDeps() {
  const chats = require('./chats.js');
  const transcript = require('./transcript.js');
  return {
    sendInput: chats.sendInput,
    createChat: chats.createChat,
    listChats: chats.listChats,
    readTranscript: transcript.readTranscript,
  };
}

function tick(sessions, deps, now) {
  const config = readConfig();
  const io = deps || realDeps();
  const clock = typeof now === 'function' ? now() : (typeof now === 'number' ? now : Date.now());
  const current = Array.isArray(sessions) ? sessions : [];
  const present = new Set(current.map(s => s && s.sessionId).filter(Boolean));
  const state = loadState();
  let changed = false;

  for (const id of Object.keys(state)) {
    if (!present.has(id)) { delete state[id]; changed = true; }
  }

  for (const s of current) {
    if (!s || !s.sessionId) continue;
    const existing = state[s.sessionId];
    // Safety-critical: injection is permitted only at the explicit idle REPL state.
    if (!existing && config.enabled && s.chatName && s.context && s.context.pct >= config.thresholdPct && s.state === 'idle') {
      try {
        io.sendInput(s.chatName, WRAP_MSG);
        state[s.sessionId] = { phase: 'wrapped', wrappedAt: clock };
        changed = true;
      } catch (e) {}
      // A continuation requires a later tick/idle observation, never the same tick as wrapping.
      continue;
    }
    if (!config.autoRestart || !existing || existing.phase !== 'wrapped' || s.state !== 'idle') continue;
    try {
      const text = io.readTranscript(s.transcriptPath || '');
      // WRAP_MSG itself contains a literal <RESUME>…</RESUME> EXAMPLE and is rendered back as a user
      // turn in the transcript. Strip every occurrence of it before matching so extraction can only
      // pick up Claude's OWN emitted block — otherwise a wrap where Claude emits no real resume block
      // would "restart" with the placeholder text `your resume prompt here`. (Review panel MAJOR.)
      const cleaned = String(text || '').split(WRAP_MSG).join('');
      const matches = [...cleaned.matchAll(/<RESUME>([\s\S]+?)<\/RESUME>/g)];
      if (!matches.length) continue;
      const resume = matches[matches.length - 1][1].trim();
      if (!resume) continue;
      const chat = (io.listChats() || []).find(c => c.name === s.chatName);
      if (!chat) continue;
      io.createChat({
        title: '(cont) ' + chat.title,
        prompt: resume,
        model: chat.model,
        effort: chat.effort,
        cwd: chat.cwd,
        profile: chat.profile,
      }, () => {});
      existing.phase = 'restarted';
      changed = true;
    } catch (e) {}
  }
  if (changed) saveState(state);
  return state;
}

module.exports = { tick, readConfig, WRAP_MSG, _stateFile };
