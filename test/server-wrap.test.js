const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WRAP_MSG } = require('../autowrap.js');

const DIR = path.join(__dirname, '..');
const PORT = 3942;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(proc, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode} before becoming ready`);
    try { if ((await fetch(`${BASE}/api/token`)).ok) return; } catch (e) {}
    if (Date.now() >= deadline) throw new Error(`server did not start within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('manual wrap is gated and sends the exported autowrap message only to a live controlled Claude chat', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-wrap-route-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  // Liveness is derived from ONE cached `list-sessions` snapshot rather than a `has-session` probe
  // per chat, so the stub must report the live session names. ck-dead is deliberately absent — the
  // same "dead chat" semantics the old `has-session` exit-1 branch expressed.
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "list-sessions" ]; then
  printf 'ck-claude\\nck-legacy\\n'
  exit 0
fi
if [[ "$*" == *"=ck-dead:0"* ]] || [[ "$*" == *"=ck-dead"* ]]; then exit 1; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(state, 'chats.json'), JSON.stringify([
    { name: 'ck-claude', title: 'Claude', cwd: os.homedir(), model: 'sonnet', effort: 'medium', provider: 'claude', createdAt: Date.now() },
    { name: 'ck-legacy', title: 'Legacy Claude', cwd: os.homedir(), model: 'sonnet', effort: 'medium', createdAt: Date.now() },
    { name: 'ck-ollama', title: 'Ollama', cwd: os.homedir(), model: 'qwen2.5-coder:7b', effort: 'medium', provider: 'ollama', mediated: true, createdAt: Date.now() },
    { name: 'ck-dead', title: 'Dead Claude', cwd: os.homedir(), model: 'sonnet', effort: 'medium', provider: 'claude', createdAt: Date.now() },
  ]));
  // A live session tracked for the controlled chat — the manual wrap must register it in
  // autowrap's per-session state (no double-inject, autoRestart continuation).
  fs.mkdirSync(path.join(state, 'sessions'));
  fs.writeFileSync(path.join(state, 'sessions', 'sess-1.json'), JSON.stringify({
    sessionId: 'sess-1', chatName: 'ck-claude', provider: 'claude', state: 'idle', lastActivityAt: Date.now(),
  }));

  const server = spawn('node', [path.join(DIR, 'server.js')], {
    env: {
      ...process.env,
      AGENT_DASHBOARD_PORT: String(PORT),
      COCKPIT_DIR: state,
      CK_TMUX_BIN: stub,
      CK_CCUSAGE_CMD: '/usr/bin/false',
    },
    stdio: 'ignore',
  });

  try {
    await waitForServer(server);
    assert.equal((await fetch(`${BASE}/api/chats/ck-claude/wrap`, { method: 'POST' })).status, 403);
    const token = await (await fetch(`${BASE}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };

    const wrapped = await fetch(`${BASE}/api/chats/ck-claude/wrap`, { method: 'POST', headers, body: '{}' });
    assert.equal(wrapped.status, 200);
    assert.deepEqual(await wrapped.json(), { ok: true });
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`send-keys -t =ck-claude:0 -l ${WRAP_MSG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const wrapState = JSON.parse(fs.readFileSync(path.join(state, 'autowrap-state.json'), 'utf8'));
    assert.equal(wrapState['sess-1'].phase, 'wrapped', 'manual wrap must register in autowrap per-session state');

    assert.equal((await fetch(`${BASE}/api/chats/ck-legacy/wrap`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await fetch(`${BASE}/api/chats/ck-ollama/wrap`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${BASE}/api/chats/ck-dead/wrap`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${BASE}/api/chats/ck-unknown/wrap`, { method: 'POST', headers, body: '{}' })).status, 400);
  } finally {
    server.kill();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('manual wrap refuses a chat whose session has not received its first prompt (2026-09-06: promptless fresh chat was wrapped)', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-wrap-fresh-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "list-sessions" ]; then printf 'ck-fresh\\nck-lost\\n'; exit 0; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(state, 'chats.json'), JSON.stringify([
    { name: 'ck-fresh', title: 'Fresh', cwd: os.homedir(), model: 'sonnet', effort: 'medium', provider: 'claude', createdAt: Date.now() },
    { name: 'ck-lost', title: 'Lost prompt', cwd: os.homedir(), model: 'sonnet', effort: 'medium', provider: 'claude', createdAt: Date.now(), promptUndelivered: true },
  ]));
  // A transcript that exists but holds NO assistant usage yet: the REPL is up, nothing was ever
  // submitted. contextForTranscript() returns null for it — exactly the fresh-chat shape.
  const projects = path.join(state, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const transcript = path.join(projects, 'fresh.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'attachment', timestamp: new Date().toISOString() }) + '\n');
  fs.mkdirSync(path.join(state, 'sessions'));
  fs.writeFileSync(path.join(state, 'sessions', 'sess-fresh.json'), JSON.stringify({
    sessionId: 'sess-fresh', chatName: 'ck-fresh', provider: 'claude', state: 'idle', lastActivityAt: Date.now(), transcriptPath: transcript,
  }));

  const PORT2 = 3943, BASE2 = `http://127.0.0.1:${PORT2}`;
  const server = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT2), COCKPIT_DIR: state, CK_TMUX_BIN: stub, CK_PROJECTS_DIR: projects, CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(`${BASE2}/api/token`)).ok) break; } catch (e) {}
      if (Date.now() >= deadline) throw new Error('server did not start');
      await new Promise(r => setTimeout(r, 50));
    }
    const token = await (await fetch(`${BASE2}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };

    const fresh = await fetch(`${BASE2}/api/chats/ck-fresh/wrap`, { method: 'POST', headers, body: '{}' });
    assert.equal(fresh.status, 409);
    assert.match((await fresh.json()).error, /first prompt/);
    const lost = await fetch(`${BASE2}/api/chats/ck-lost/wrap`, { method: 'POST', headers, body: '{}' });
    assert.equal(lost.status, 409);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(calls, /send-keys -t =ck-(fresh|lost):0 -l/, 'nothing may be typed into a chat that never got its prompt');
    assert.ok(!fs.existsSync(path.join(state, 'autowrap-state.json')), 'no wrap state is recorded for a refused wrap');
  } finally {
    server.kill();
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('manual input clears promptUndelivered and re-enables /wrap (recovery path)', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-wrap-recover-'));
  const log = path.join(state, 'tmux.log');
  const stub = path.join(state, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "list-sessions" ]; then printf 'ck-lost\\n'; exit 0; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(state, 'chats.json'), JSON.stringify([
    { name: 'ck-lost', title: 'Lost prompt', cwd: os.homedir(), model: 'sonnet', effort: 'medium', provider: 'claude', createdAt: Date.now(), promptUndelivered: true, pendingPrompt: 'the lost text' },
  ]));
  const PORT3 = 3944, BASE3 = `http://127.0.0.1:${PORT3}`;
  const server = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT3), COCKPIT_DIR: state, CK_TMUX_BIN: stub, CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (server.exitCode !== null) throw new Error('server exited early');
      try { if ((await fetch(`${BASE3}/api/token`)).ok) break; } catch (e) {}
      if (Date.now() >= deadline) throw new Error('server did not start');
      await new Promise(r => setTimeout(r, 50));
    }
    const token = await (await fetch(`${BASE3}/api/token`)).text();
    const headers = { 'x-cockpit-token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${BASE3}/api/chats/ck-lost/wrap`, { method: 'POST', headers, body: '{}' })).status, 409);
    assert.equal((await fetch(`${BASE3}/api/chats/ck-lost/input`, { method: 'POST', headers, body: JSON.stringify({ text: 'the lost text' }) })).status, 200);
    const rec = JSON.parse(fs.readFileSync(path.join(state, 'chats.json'), 'utf8'))[0];
    assert.equal(rec.promptUndelivered, undefined);
    assert.equal(rec.pendingPrompt, undefined);
    assert.equal((await fetch(`${BASE3}/api/chats/ck-lost/wrap`, { method: 'POST', headers, body: '{}' })).status, 200, 'wrap works again after manual recovery');
  } finally {
    server.kill();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
