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
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((await fetch(`${BASE}/api/autowrap`)).status, 403);
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    assert.deepEqual(await (await fetch(`${BASE}/api/autowrap`, { headers })).json(), { enabled: false, thresholdPct: 0.85, autoRestart: false });
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
