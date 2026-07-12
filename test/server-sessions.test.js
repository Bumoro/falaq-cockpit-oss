// ~/.claude/agent-dashboard/test/server-sessions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');

test('/api/sessions returns live sessions, excludes old ended ones', async () => {
  const sessionsDir = path.join(DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sessionsDir, 'test-live.json'),
    JSON.stringify({ sessionId: 'test-live', state: 'running', lastActivityAt: now }));
  fs.writeFileSync(path.join(sessionsDir, 'test-old-ended.json'),
    JSON.stringify({ sessionId: 'test-old-ended', state: 'ended', endedAt: now - 2 * 3600e3, lastActivityAt: now - 2 * 3600e3 }));

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: '3899' }, stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const res = await fetch('http://localhost:3899/api/sessions');
    assert.equal(res.status, 200);
    const sessions = await res.json();
    const ids = sessions.map(s => s.sessionId);
    assert.ok(ids.includes('test-live'));
    assert.ok(!ids.includes('test-old-ended'));
  } finally {
    srv.kill();
    fs.unlinkSync(path.join(sessionsDir, 'test-live.json'));
    fs.unlinkSync(path.join(sessionsDir, 'test-old-ended.json'));
    // server.js is port-aware: with AGENT_DASHBOARD_PORT=3899 it writes server-3899.pid
    // (cleaned up by srv.kill() -> SIGTERM handler), leaving the live server.pid untouched.
  }
});
