// dispatch/trigger.js — monotonic Slack #dispatch trigger and MCP bridge launcher.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE_PROMPT = {
  intake: 'Read Client-OS tasks tagged auto:eligible that are actionable (not done, paused, blocked, or claimed) via the task tracker. For each resolve exactly {id,title,status,tags,blockedBy,owner,repo,cwd,hasPlan}. Read the cockpit token from ~/.claude/agent-dashboard/.token and POST {tasks:[...]} to http://127.0.0.1:3847/api/dispatch/run with header x-cockpit-token. Do nothing else.',
  report: 'Read ~/.claude/agent-dashboard/dispatch-state.json. For each finished dispatch run, file a Client-OS task titled "🔒 GATE: review dispatched PR — <title>" with the PR link and review-provenance in the body, assigned to the repo owner. Return one summary line per run and do nothing else.',
};

function stateDir() { return process.env.COCKPIT_DIR || path.join(os.homedir(), '.claude', 'agent-dashboard'); }
function stateFile() { return path.join(stateDir(), 'trigger-state.json'); }
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; } }
function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile() + '.tmp', stateFile());
}
function defaultToken() { try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'agent-dashboard', '.slack-bot-token'), 'utf8').trim(); } catch (e) { return ''; } }
function defaultSpawnBridge(mode) {
  const prompt = BRIDGE_PROMPT[mode];
  if (!prompt) return;
  spawn('claude', ['-p', prompt], { detached: true, stdio: 'ignore' }).unref();
}
function newer(a, b) { return Number(a) > Number(b); }

function pollTrigger(deps, cb) {
  deps = deps || {};
  cb = cb || (() => {});
  const config = deps.config || require('../dispatch.js').readConfig();
  const channel = config.slackChannelId || '';
  const allow = Array.isArray(config.slackTriggerUserIds) ? config.slackTriggerUserIds : [];
  const token = deps.token === undefined ? defaultToken() : deps.token;
  if (!channel || !token) return cb(null, { fired: false });
  const state = loadState();
  const lastTs = String(state.lastTs || '0');
  const fetchFn = deps.fetch || global.fetch;
  const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&oldest=${encodeURIComponent(lastTs)}&limit=20`;
  Promise.resolve(fetchFn(url, { headers: { Authorization: `Bearer ${token}` } }))
    .then(res => res.json())
    .then(data => {
      if (!data || data.ok === false || !Array.isArray(data.messages)) return cb(null, { fired: false });
      const qualifying = data.messages.filter(m => m && newer(m.ts, lastTs) && allow.includes(m.user) && /^\s*dispatch\b/i.test(String(m.text || '')))
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      if (!qualifying.length) return cb(null, { fired: false });
      const newest = qualifying[0];
      (deps.spawnBridge || defaultSpawnBridge)('intake');
      state.lastTs = String(newest.ts);
      saveState(state);
      cb(null, { fired: true, lastTs: state.lastTs });
    })
    .catch(err => cb(err));
}

module.exports = { pollTrigger, spawnBridge: defaultSpawnBridge, BRIDGE_PROMPT, _stateFile: stateFile };
