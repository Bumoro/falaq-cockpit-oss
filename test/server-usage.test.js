// ~/.claude/agent-dashboard/test/server-usage.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3897;
const BASE = `http://localhost:${PORT}`;

test('/api/usage serves the cache; /api/sessions includes context', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'srvusage-'));
  // seed a usage cache
  fs.writeFileSync(path.join(state, 'usage-cache.json'), JSON.stringify({ generatedAt: Date.now(), block: { totalTokens: 999, costUSD: 1.23 }, week: null }));
  // seed a session with a transcript that has usage
  fs.mkdirSync(path.join(state, 'sessions'), { recursive: true });
  const tr = path.join(state, 'tr.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 0, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0 } } }));
  fs.writeFileSync(path.join(state, 'sessions', 'a.json'), JSON.stringify({ sessionId: 'a', state: 'running', lastActivityAt: Date.now(), transcriptPath: tr }));

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const usage = await (await fetch(`${BASE}/api/usage`)).json();
    assert.equal(usage.block.totalTokens, 999);
    const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
    const a = sessions.find(s => s.sessionId === 'a');
    assert.ok(a.context, 'session should carry context');
    assert.equal(a.context.tokens, 500000);
    assert.equal(a.context.limit, 1000000);
    assert.equal(a.context.pct, 0.5);
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200);
  } finally { srv.kill(); }
});
