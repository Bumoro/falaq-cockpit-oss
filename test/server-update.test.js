const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3931;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(proc) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited before listening (${proc.exitCode})`);
    try { if ((await fetch(`${BASE}/api/token`)).ok) return; } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

test('update routes are token-gated, expose cached state, and reject a blocked apply', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-'));
  const cached = {
    checkedAt: 1721600000000,
    behind: 3,
    dirty: true,
    current: '1111111111111111111111111111111111111111',
    latest: '2222222222222222222222222222222222222222',
    log: ['fix dashboard'],
    blocked: 'dirty-tree',
  };
  fs.writeFileSync(path.join(stateDir, 'update-state.json'), JSON.stringify(cached));
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ update: { check: true, auto: false } }));
  const repo = path.join(stateDir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.repo-root'), repo);
  // Manual apply re-inspects the tree. A deterministic fake keeps this a route test (and proves
  // dirty-tree is surfaced as a conflict) without shelling out to a real repository or network.
  const fakeGit = path.join(stateDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
case "$*" in
  *"rev-parse --abbrev-ref --symbolic-full-name @{u}"*) echo origin/main ;;
  *"rev-parse HEAD"*) echo 1111111111111111111111111111111111111111 ;;
  *"rev-parse origin/main"*) echo 2222222222222222222222222222222222222222 ;;
  *"status --porcelain"*) echo ' M src/server.js' ;;
  *"merge-base --is-ancestor"*) exit 0 ;;
  *"rev-list --count HEAD..origin/main"*) echo 3 ;;
  *"rev-list --count origin/main..HEAD"*) echo 0 ;;
  *"log --oneline"*) echo '2222222 fix dashboard' ;;
  *) exit 2 ;;
esac
`);
  fs.chmodSync(fakeGit, 0o755);
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: {
      ...process.env,
      AGENT_DASHBOARD_PORT: String(PORT),
      COCKPIT_DIR: stateDir,
      PATH: `${stateDir}:${process.env.PATH || ''}`,
      CK_CCUSAGE_CMD: '/usr/bin/false',
      CK_WATCHER_CONFIG: path.join(stateDir, 'missing-watchers.json'),
    },
    stdio: 'ignore',
  });
  try {
    await waitForServer(srv);
    assert.equal((await fetch(`${BASE}/api/update`)).status, 403);
    assert.equal((await fetch(`${BASE}/api/update/apply`, { method: 'POST' })).status, 403);

    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token };
    const response = await fetch(`${BASE}/api/update`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...cached, autoEnabled: false, checkEnabled: true });

    const apply = await fetch(`${BASE}/api/update/apply`, { method: 'POST', headers });
    assert.equal(apply.status, 409);
    const result = await apply.json();
    assert.equal(result.reason, 'dirty-tree');
    assert.equal(result.dirty, true);

    // the kill switch (update.check=false) gates manual apply too — config is re-read per request
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ update: { check: false, auto: false } }));
    const disabled = await fetch(`${BASE}/api/update/apply`, { method: 'POST', headers });
    assert.equal(disabled.status, 409);
    assert.equal((await disabled.json()).reason, 'updates-disabled');

    assert.equal((await fetch(`${BASE}/api/update`, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(`${BASE}/api/update/apply`, { headers })).status, 405);
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200, 'blocked update must not kill the server');
  } finally {
    srv.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
