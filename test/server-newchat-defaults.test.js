// ~/.claude/agent-dashboard/test/server-newchat-defaults.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3900;
const BASE = `http://localhost:${PORT}`;

test('POST /api/chats persists model/effort/ultracode; GET /api/new-chat-defaults serves them back', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cknewchat-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "❯ ? for shortcuts"; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_TMUX_BIN: stub, CK_TEST_CMD: 'sleep 5', CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    // before any chat is created, defaults are empty (unguarded, no token needed)
    assert.deepEqual(await (await fetch(`${BASE}/api/new-chat-defaults`)).json(), {});
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const H = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    const created = await fetch(`${BASE}/api/chats`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: 'defaults test', cwd: os.homedir(), model: 'opus', effort: 'high', ultracode: true, prompt: 'hi' }),
    });
    assert.equal(created.status, 201);
    const defaults = await (await fetch(`${BASE}/api/new-chat-defaults`)).json();
    assert.equal(defaults.model, 'opus');
    assert.equal(defaults.effort, 'high');
    assert.equal(defaults.ultracode, true);
    // unguarded: no token required
    const noTok = await fetch(`${BASE}/api/new-chat-defaults`);
    assert.equal(noTok.status, 200);
  } finally {
    srv.kill();
  }
});
