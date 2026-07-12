const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3904;
const BASE = `http://localhost:${PORT}`;

test('POST /api/chats passes through and records the nondev profile without persisting it as a default', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cksrv-nondev-'));
  const ndroot = fs.mkdtempSync(path.join(os.tmpdir(), 'cksrv-ndroot-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  // seed the REAL profile template so createChat's deny-floor validation passes (fail-closed otherwise).
  // run-tests.sh flattens src/ into DIR, so the profile sits at DIR/nondev-profile.json.
  fs.copyFileSync(path.join(DIR, 'nondev-profile.json'), path.join(state, 'nondev-profile.json'));
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "❯ ? for shortcuts"; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: {
      ...process.env,
      AGENT_DASHBOARD_PORT: String(PORT),
      COCKPIT_DIR: state,
      CK_NONDEV_ROOT: ndroot,
      CK_TMUX_BIN: stub,
      CK_TEST_CMD: 'sleep 5',
      CK_CCUSAGE_CMD: '/usr/bin/false',
    },
    stdio: 'ignore',
  });

  try {
    await new Promise(r => setTimeout(r, 700));
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    const response = await fetch(`${BASE}/api/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'safe route', model: 'sonnet', effort: 'medium', profile: 'nondev' }),
    });

    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.profile, 'nondev');

    const chats = await (await fetch(`${BASE}/api/chats`, { headers })).json();
    assert.equal(chats.length, 1);
    assert.equal(chats[0].profile, 'nondev');

    const defaults = JSON.parse(fs.readFileSync(path.join(state, 'new-chat-defaults.json'), 'utf8'));
    assert.deepEqual(defaults, { model: 'sonnet', effort: 'medium', ultracode: false });
    assert.ok(!Object.hasOwn(defaults, 'profile'), 'profile is per-call, not a new-chat default');
  } finally {
    srv.kill();
    fs.rmSync(ndroot, { recursive: true, force: true });
  }
});
