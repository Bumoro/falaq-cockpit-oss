const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3902;
const BASE = `http://localhost:${PORT}`;

test('/api/sessions surfaces a pending prompt for a waiting controlled session', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpend-'));
  fs.mkdirSync(path.join(state, 'sessions'));
  // tmux stub: capture-pane prints a real-shaped permission prompt.
  const stub = path.join(state, 'tmux.sh');
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "capture-pane" ]; then
  # numbered PROSE above the real menu: the parser must answer the cursor-bearing menu, not the prose.
  printf '%s\\n' "Here's the plan:" '1. Drop everything' '2. Keep it' '' 'Do you want to proceed?' '❯ 1. Yes' '  2. No, and tell Claude what to do differently (esc)'
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  // a waiting, controlled session (no transcriptPath needed)
  fs.writeFileSync(path.join(state, 'sessions', 's1.json'),
    JSON.stringify({ sessionId: 's1', state: 'needs_you', chatName: 'ck-demo', needsYou: { message: 'waiting' } }));
  // a NON-controlled waiting session must NOT get pending
  fs.writeFileSync(path.join(state, 'sessions', 's2.json'),
    JSON.stringify({ sessionId: 's2', state: 'needs_you' }));

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_TMUX_BIN: stub },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
    const s1 = sessions.find(s => s.sessionId === 's1');
    const s2 = sessions.find(s => s.sessionId === 's2');
    assert.ok(s1.pending, 'controlled waiting session should have pending');
    assert.equal(s1.pending.kind, 'permission');
    assert.equal(s1.pending.options.length, 2);
    assert.equal(s1.pending.options[0].key, '1');
    assert.equal(s1.pending.options[0].label, 'Yes', 'must anchor to the real menu, not the prose above it');
    assert.equal(s2.pending, undefined, 'non-controlled session has no pending');
  } finally {
    srv.kill();
  }
});
