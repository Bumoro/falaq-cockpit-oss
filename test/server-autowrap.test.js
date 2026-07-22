const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3906;
const BASE = `http://localhost:${PORT}`;

test('/api/autowrap is token-gated and POST merges without losing other config', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-autowrap-'));
  const configFile = path.join(state, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ clientMap: { project: 'Project' }, unrelated: { keep: true } }));
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CCUSAGE_CMD: '/usr/bin/false', CK_PLAN_USAGE_FILE: path.join(state, 'plan-usage-history.json') },
    stdio: 'ignore',
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await fetch(`${BASE}/api/autowrap`)).status, 403);
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    assert.deepEqual(await (await fetch(`${BASE}/api/autowrap`, { headers })).json(), { enabled: false, thresholdPct: 0.50, autoRestart: false });
    const response = await fetch(`${BASE}/api/autowrap`, {
      method: 'POST', headers, body: JSON.stringify({ enabled: false, thresholdPct: 0.72, autoRestart: true, ignored: 'value' }),
    });
    assert.deepEqual(await response.json(), { enabled: false, thresholdPct: 0.72, autoRestart: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {
      clientMap: { project: 'Project' },
      unrelated: { keep: true },
      autoWrap: { enabled: false, thresholdPct: 0.72, autoRestart: true },
    });
  } finally {
    srv.kill();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('server session feed identifies high-context Codex cards for the non-Claude autowrap guard', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-autowrap-provider-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-autowrap-codex-'));
  const dayDir = path.join(codexDir, '2026', '07', '19');
  fs.mkdirSync(dayDir, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: 'codex-high', cwd: state, originator: 'cli' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 100, last_token_usage: { total_tokens: 95 } } } },
  ];
  fs.writeFileSync(path.join(dayDir, 'rollout-high.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
  const port = 3916;
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(port), COCKPIT_DIR: state, CK_CODEX_DIR: codexDir, CK_CCUSAGE_CMD: '/usr/bin/false', CK_PLAN_USAGE_FILE: path.join(state, 'missing-plan.json') },
    stdio: 'ignore',
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    const sessions = await (await fetch(`http://localhost:${port}/api/sessions`)).json();
    const codex = sessions.find(s => s.sessionId === 'codex-high');
    assert.equal(codex.provider, 'codex');
    assert.equal(codex.context.pct, 0.95);
  } finally {
    srv.kill();
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});
