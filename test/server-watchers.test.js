const { test } = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawn } = require('child_process');
const DIR = path.join(__dirname, '..'); const PORT = 3896; const BASE = `http://localhost:${PORT}`;
test('/api/watchers serves stored watcher state', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'srvwatch-'));
  fs.mkdirSync(path.join(state, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(state, 'watchers', 'ci.json'), JSON.stringify({ name: 'ci', state: 'green', summary: 'ok', lastCheck: Date.now(), lastChange: Date.now() }));
  const t = path.join(state, 'true.sh'); fs.writeFileSync(t, '#!/bin/bash\nexit 0\n'); fs.chmodSync(t, 0o755);
  // Isolate from the real (production) watcher-config.json — that file configures a real
  // "ci" watcher against Bumoro/falaq-cockpit, and buildChecks() reads it from the repo's
  // watchers/ dir regardless of COCKPIT_DIR. Point CK_WATCHER_CONFIG at an empty config so
  // runWatchers() finds no checks to run and the seeded ci.json fixture is left untouched —
  // this test is only about the /api/watchers read path and /api/sessions non-blocking, not
  // about live check execution (that's covered by test/watcher-checks.test.js).
  const emptyConfig = path.join(state, 'empty-config.json'); fs.writeFileSync(emptyConfig, '{}');
  const srv = spawn('node', [path.join(DIR, 'server.js')], { env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CCUSAGE_CMD: '/usr/bin/false', CK_GH_CMD: t, CK_GMAILX_CMD: t, CK_WATCHER_CONFIG: emptyConfig }, stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 700));
    const w = await (await fetch(`${BASE}/api/watchers`)).json();
    assert.ok(Array.isArray(w)); assert.ok(w.find(x => x.name === 'ci' && x.state === 'green'));
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200);
  } finally { srv.kill(); }
});
