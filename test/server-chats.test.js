const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3898;
const BASE = `http://localhost:${PORT}`;

// Poll until the freshly spawned server accepts connections. A fixed sleep races under the full
// suite's concurrency (270 tests) and intermittently ECONNREFUSEs; polling is load-robust.
async function waitForServer(base, proc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc && proc.exitCode !== null) throw new Error(`server process exited (code ${proc.exitCode}) before ready at ${base}`);
    try { if ((await fetch(`${base}/api/token`)).ok) return; } catch (e) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start within ${timeoutMs}ms at ${base}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

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
    await waitForServer(BASE, srv);
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
    // uploads are stored beneath the validated chat name and return an absolute local path
    const uploaded = await fetch(`${BASE}/api/chats/${chat.name}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ filename: 'note image.txt', dataBase64: Buffer.from('hello').toString('base64') }) });
    assert.equal(uploaded.status, 200);
    const uploadedBody = await uploaded.json();
    assert.equal(path.dirname(uploadedBody.path), path.join(state, 'uploads', chat.name));
    assert.match(path.basename(uploadedBody.path), /^\d+-note_image\.txt$/);
    assert.equal(fs.readFileSync(uploadedBody.path, 'utf8'), 'hello');
    // A traversal-looking filename is reduced to its basename and cannot escape the upload jail.
    const traversal = await fetch(`${BASE}/api/chats/${chat.name}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ filename: '../../x', dataBase64: Buffer.from('safe').toString('base64') }) });
    assert.equal(traversal.status, 200);
    const traversalBody = await traversal.json();
    assert.equal(path.dirname(traversalBody.path), path.join(state, 'uploads', chat.name));
    assert.match(path.basename(traversalBody.path), /^\d+-x$/);
    assert.equal(fs.readFileSync(traversalBody.path, 'utf8'), 'safe');
    const empty = await fetch(`${BASE}/api/chats/${chat.name}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ filename: 'empty.bin', dataBase64: '' }) });
    assert.equal(empty.status, 400);
    // The upload body gets a larger JSON allowance than ordinary routes, but decoded files remain capped.
    const oversizeData = Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64');
    const oversize = await fetch(`${BASE}/api/chats/${chat.name}/upload`, { method: 'POST', headers: H, body: JSON.stringify({ filename: 'too-big.bin', dataBase64: oversizeData }) });
    assert.equal(oversize.status, 400);
    assert.match((await oversize.json()).error, /15 MB/);
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
    await waitForServer(BASE2, srv);
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
