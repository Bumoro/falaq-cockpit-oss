const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3927;
const BASE = `http://127.0.0.1:${PORT}`;

test('/api/dispatch merges config, writes run queue, and kills active fleet', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-api-'));
  const configFile = path.join(state, 'config.json');
  const tmuxLog = path.join(state, 'tmux.log');
  const tmux = path.join(state, 'tmux.sh');
  fs.writeFileSync(tmux, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CK_TMUX_LOG"\n');
  fs.chmodSync(tmux, 0o755);
  fs.writeFileSync(configFile, JSON.stringify({ clientMap: { keep: 'yes' }, dispatch: { enabled: false, caps: { stopStartingAfter: '05:00', eveningResumeAfter: '18:00' } } }));
  fs.writeFileSync(path.join(state, 'dispatch-state.json'), JSON.stringify({ runs: {
    a: { phase: 'running', chatName: 'ck-running' }, b: { phase: 'spawning', chatName: 'ck-spawning' }, c: { phase: 'done', chatName: 'ck-done' },
  } }));
  const srv = spawn('node', [path.join(DIR, 'server.js')], { env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CCUSAGE_CMD: '/usr/bin/false', CK_TMUX_BIN: tmux, CK_TMUX_LOG: tmuxLog }, stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await fetch(`${BASE}/api/dispatch`)).status, 403);
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    await fetch(`${BASE}/api/dispatch`, { method: 'POST', headers, body: JSON.stringify({ enabled: false, concurrency: 2, dryRun: true, caps: { nightlyTokenCeiling: 1000 }, slackChannelId: 'C1', slackTriggerUserIds: ['U1'], ignored: true }) });
    const merged = JSON.parse(fs.readFileSync(configFile));
    assert.deepEqual(merged.clientMap, { keep: 'yes' });
    assert.deepEqual(merged.dispatch, { enabled: false, concurrency: 2, dryRun: true, caps: { stopStartingAfter: '05:00', eveningResumeAfter: '18:00', nightlyTokenCeiling: 1000 }, slackChannelId: 'C1', slackTriggerUserIds: ['U1'] });
    assert.equal((await fetch(`${BASE}/api/dispatch/run`, { method: 'POST', headers, body: JSON.stringify({ tasks: 'bad' }) })).status, 400);
    const tasks = [{ id: 't1', title: 'task' }];
    assert.equal((await fetch(`${BASE}/api/dispatch/run`, { method: 'POST', headers, body: JSON.stringify({ tasks }) })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'dispatch-queue.json'))), { tasks });
    await fetch(`${BASE}/api/dispatch/kill`, { method: 'POST', headers, body: '{}' });
    assert.equal(JSON.parse(fs.readFileSync(configFile)).dispatch.enabled, false);
    const log = fs.readFileSync(tmuxLog, 'utf8');
    assert.match(log, /kill-session -t =ck-running/);
    assert.match(log, /kill-session -t =ck-spawning/);
    assert.doesNotMatch(log, /ck-done/);
  } finally { srv.kill(); fs.rmSync(state, { recursive: true, force: true }); }
});
