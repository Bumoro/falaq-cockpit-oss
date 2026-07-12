const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3898;
const BASE = `http://localhost:${PORT}`;

test('chat routes: token gate, create, screen, keys allowlist, delete', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cksrv-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "SCREEN-CONTENT ❯ ? for shortcuts"; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_TMUX_BIN: stub, CK_TEST_CMD: 'sleep 5' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    // no token -> 403
    assert.equal((await fetch(`${BASE}/api/chats`)).status, 403);
    // token endpoint works
    const token = await (await fetch(`${BASE}/api/token`)).text();
    assert.match(token, /^[0-9a-f]{48}$/);
    const H = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    // list empty
    assert.deepEqual(await (await fetch(`${BASE}/api/chats`, { headers: H })).json(), []);
    // create
    const created = await fetch(`${BASE}/api/chats`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'srv test', cwd: os.homedir(), model: 'haiku', effort: 'low', prompt: 'hi' }) });
    assert.equal(created.status, 201);
    const chat = await created.json();
    assert.match(chat.name, /^ck-srv-test/);
    // bad model -> 400
    const bad = await fetch(`${BASE}/api/chats`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'x', cwd: os.homedir(), model: 'gpt', effort: 'low' }) });
    assert.equal(bad.status, 400);
    // screen
    const scr = await (await fetch(`${BASE}/api/chats/${chat.name}/screen`, { headers: H })).text();
    assert.match(scr, /SCREEN-CONTENT/);
    // keys: allowed + rejected
    assert.equal((await fetch(`${BASE}/api/chats/${chat.name}/keys`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'esc' }) })).status, 200);
    assert.equal((await fetch(`${BASE}/api/chats/${chat.name}/keys`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'q' }) })).status, 400);
    // input
    assert.equal((await fetch(`${BASE}/api/chats/${chat.name}/input`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'follow-up' }) })).status, 200);
    // delete
    assert.equal((await fetch(`${BASE}/api/chats/${chat.name}`, { method: 'DELETE', headers: H })).status, 200);
    assert.deepEqual(await (await fetch(`${BASE}/api/chats`, { headers: H })).json(), []);
    // v1 endpoints still open (no token)
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200);
  } finally {
    srv.kill();
  }
});

test('a screen capture failure returns 400 without crashing the server', async () => {
  const PORT2 = 3899;
  const BASE2 = `http://localhost:${PORT2}`;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cksrv-crash-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  const failFlag = path.join(state, 'fail-capture');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then
  if [ -f "${failFlag}" ]; then echo "capture-pane: can't find pane" >&2; exit 1; fi
  echo "SCREEN-CONTENT ❯ ? for shortcuts"
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT2), COCKPIT_DIR: state, CK_TMUX_BIN: stub, CK_TEST_CMD: 'sleep 5' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const token = await (await fetch(`${BASE2}/api/token`)).text();
    const H = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    const created = await fetch(`${BASE2}/api/chats`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'crash test', cwd: os.homedir(), model: 'haiku', effort: 'low' }) });
    assert.equal(created.status, 201);
    const chat = await created.json();
    // make the next capture-pane call (the /screen route) fail like a dead tmux session
    fs.writeFileSync(failFlag, '1');
    const scr = await fetch(`${BASE2}/api/chats/${chat.name}/screen`, { headers: H });
    assert.equal(scr.status, 400);
    // the server process must still be alive and answering requests afterwards
    const after = await fetch(`${BASE2}/api/chats`, { headers: H });
    assert.equal(after.status, 200);
  } finally {
    srv.kill();
  }
});
