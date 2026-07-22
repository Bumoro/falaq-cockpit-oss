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
