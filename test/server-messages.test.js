// server-messages.test.js — structured chat messages: token gate, whitelist, jail, and /chat.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3903;
const BASE = `http://localhost:${PORT}`;

test('messages route enforces token + whitelist and /chat serves the friendly view', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmsgproj-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmsgstate-'));
  fs.mkdirSync(path.join(state, 'sessions'));

  const tx = path.join(proj, 'good.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-07-11T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: '2026-07-11T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
  ];
  fs.writeFileSync(tx, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'sessions', 'x.json'), JSON.stringify({ sessionId: 'x', transcriptPath: tx, state: 'running' }));

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_PROJECTS_DIR: proj, CK_TMUX_BIN: '/bin/echo', CK_TEST_CMD: 'sleep 5' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const H = { 'x-cockpit-token': token };
    const q = (p) => `${BASE}/api/chats/ck-x/messages?path=${encodeURIComponent(p)}`;

    assert.equal((await fetch(q(tx))).status, 403);

    const ok = await fetch(q(tx), { headers: H });
    assert.equal(ok.status, 200);
    const turns = await ok.json();
    assert.equal(turns.length, 2);
    assert.deepStrictEqual(turns[0], { role: 'you', ts: '2026-07-11T10:00:00.000Z', blocks: [{ type: 'text', text: 'hello' }] });
    assert.deepStrictEqual(turns[1], { role: 'claude', ts: '2026-07-11T10:00:01.000Z', blocks: [{ type: 'text', text: 'hi there' }] });

    // whitelist gate: a path NOT belonging to any tracked session -> [] (never read)
    const unknown = await fetch(q(path.join(state, '.token')), { headers: H });
    assert.equal(unknown.status, 200);
    assert.deepStrictEqual(await unknown.json(), []);

    // jail gate (independent of the whitelist): a path that IS a tracked session's transcriptPath but
    // resolves OUTSIDE ~/.claude/projects must still yield [] — parseTranscript's realpath jail, not
    // just the whitelist, is what stops it. knownTranscriptPaths re-reads sessions/ per request.
    const outside = path.join(state, 'outside.jsonl');
    fs.writeFileSync(outside, JSON.stringify(lines[0]) + '\n');
    fs.writeFileSync(path.join(state, 'sessions', 'y.json'), JSON.stringify({ sessionId: 'y', transcriptPath: outside, state: 'running' }));
    const jailed = await fetch(`${BASE}/api/chats/ck-y/messages?path=${encodeURIComponent(outside)}`, { headers: H });
    assert.equal(jailed.status, 200);
    assert.deepStrictEqual(await jailed.json(), []);

    const chat = await fetch(`${BASE}/chat`);
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /id="composer"/);
  } finally {
    srv.kill();
  }
});
