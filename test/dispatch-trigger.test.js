const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadTrigger(dir) {
  process.env.COCKPIT_DIR = dir;
  delete require.cache[require.resolve('../dispatch/trigger.js')];
  return require('../dispatch/trigger.js');
}
function poll(mod, deps) {
  return new Promise((resolve, reject) => mod.pollTrigger(deps, (err, result) => err ? reject(err) : resolve(result)));
}
function response(messages) { return async () => ({ json: async () => ({ ok: true, messages }) }); }
const config = { slackChannelId: 'C123', slackTriggerUserIds: ['U1'] };

test('newest fresh allowlisted dispatch fires intake once and advances lastTs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-trigger-'));
  try {
    fs.writeFileSync(path.join(dir, 'trigger-state.json'), JSON.stringify({ lastTs: '100.0' }));
    const mod = loadTrigger(dir), calls = [];
    const result = await poll(mod, { config, token: 'x', fetch: response([
      { ts: '99.0', user: 'U1', text: 'dispatch old' },
      { ts: '101.0', user: 'U1', text: ' dispatch tonight' },
      { ts: '102.0', user: 'U1', text: 'dispatch newest' },
    ]), spawnBridge: mode => calls.push(mode) });
    assert.deepEqual(calls, ['intake']);
    assert.equal(result.lastTs, '102.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'trigger-state.json'))).lastTs, '102.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-allowlisted and old messages do nothing; a second empty poll does not refire', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-trigger-'));
  try {
    fs.writeFileSync(path.join(dir, 'trigger-state.json'), JSON.stringify({ lastTs: '100.0' }));
    const mod = loadTrigger(dir), calls = [];
    await poll(mod, { config, token: 'x', fetch: response([{ ts: '101.0', user: 'U2', text: 'dispatch' }, { ts: '100.0', user: 'U1', text: 'dispatch' }]), spawnBridge: m => calls.push(m) });
    await poll(mod, { config, token: 'x', fetch: response([]), spawnBridge: m => calls.push(m) });
    assert.deepEqual(calls, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'trigger-state.json'))).lastTs, '100.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spawnBridge strips cockpit instance env (39xx-zombie regression) and honors CK_CLAUDE_BIN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-trigger-'));
  const out = path.join(dir, 'env.txt');
  const stub = path.join(dir, 'claude-stub.sh');
  fs.writeFileSync(stub, `#!/bin/sh\nenv > "${out}"\n`);
  fs.chmodSync(stub, 0o755);
  const saved = { CK_CLAUDE_BIN: process.env.CK_CLAUDE_BIN, AGENT_DASHBOARD_PORT: process.env.AGENT_DASHBOARD_PORT, COCKPIT_DIR: process.env.COCKPIT_DIR };
  process.env.CK_CLAUDE_BIN = stub;
  process.env.AGENT_DASHBOARD_PORT = '3999';
  try {
    const mod = loadTrigger(dir); // sets COCKPIT_DIR=dir
    mod.spawnBridge('report');
    // Wait generously: the child is a real spawned process, and under a full parallel suite run the
    // machine is loaded enough that the old 3s budget expired before it started — which surfaced as a
    // baffling ENOENT on env.txt and blocked deploys (deploy.sh gates on the suite). Isolation always
    // passed, which is what made it look like an unfixable flake. Fail with a clear message instead.
    for (let i = 0; i < 400 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(out), 'claude stub never ran: spawnBridge produced no env dump within 20s');
    const dump = fs.readFileSync(out, 'utf8');
    assert.doesNotMatch(dump, /^AGENT_DASHBOARD_PORT=/m, 'child must not inherit the instance port (SessionStart hook would resurrect a server on it)');
    assert.doesNotMatch(dump, /^COCKPIT_DIR=/m, 'child must not inherit the instance state dir');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
