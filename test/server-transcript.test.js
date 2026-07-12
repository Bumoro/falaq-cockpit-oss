// server-transcript.test.js — the /api/chats/:name/transcript route: token gate, whitelist, jail.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3901;
const BASE = `http://localhost:${PORT}`;

test('transcript route enforces token + whitelist + projects-dir jail', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cktxproj-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cktxstate-'));
  fs.mkdirSync(path.join(state, 'sessions'));

  // a real transcript, inside the jail, referenced by a known session -> should be served
  const tx = path.join(proj, 'good.jsonl');
  fs.writeFileSync(tx, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from transcript' } }) + '\n');
  fs.writeFileSync(path.join(state, 'sessions', 's1.json'), JSON.stringify({ sessionId: 's1', transcriptPath: tx, state: 'running' }));

  // a secret OUTSIDE the jail, referenced by a session (whitelisted) -> jail must still block it
  const secretWhitelisted = path.join(os.tmpdir(), 'ck-secret-wl-' + Date.now() + '.txt');
  fs.writeFileSync(secretWhitelisted, 'TOP SECRET A');
  fs.writeFileSync(path.join(state, 'sessions', 's2.json'), JSON.stringify({ sessionId: 's2', transcriptPath: secretWhitelisted, state: 'running' }));

  // a secret OUTSIDE the jail and NOT referenced by any session -> whitelist must block it
  const secretUnknown = path.join(os.tmpdir(), 'ck-secret-unk-' + Date.now() + '.txt');
  fs.writeFileSync(secretUnknown, 'TOP SECRET B');

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_PROJECTS_DIR: proj, CK_TMUX_BIN: '/bin/echo', CK_TEST_CMD: 'sleep 5' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const H = { 'x-cockpit-token': token };
    const q = (p) => `${BASE}/api/chats/ck-x/transcript?path=${encodeURIComponent(p)}`;

    // no token -> 403
    assert.equal((await fetch(q(tx))).status, 403);

    // known + in-jail -> served
    const ok = await fetch(q(tx), { headers: H });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /hello from transcript/);

    // whitelisted but OUTSIDE the jail -> blocked by the jail (empty), never leaks the secret
    const wl = await fetch(q(secretWhitelisted), { headers: H });
    assert.equal(wl.status, 200);
    const wlText = await wl.text();
    assert.equal(wlText.trim(), '');
    assert.doesNotMatch(wlText, /TOP SECRET/);

    // not whitelisted -> blocked by the whitelist (empty)
    const unk = await fetch(q(secretUnknown), { headers: H });
    assert.equal(unk.status, 200);
    assert.equal((await unk.text()).trim(), '');

    // missing path param -> empty, no crash
    assert.equal((await (await fetch(`${BASE}/api/chats/ck-x/transcript`, { headers: H })).text()).trim(), '');

    // server still alive
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200);
  } finally {
    srv.kill();
  }
});
