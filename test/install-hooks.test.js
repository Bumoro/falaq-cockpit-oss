const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'install-hooks.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-hooks-'));
  return { root, mirror: path.join(root, 'custom-mirror'), settings: path.join(root, 'settings.json') };
}

function run(f, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, CK_MIRROR_DIR: f.mirror }, encoding: 'utf8'
  });
}

test('fresh merge resolves hooks, preserves user settings, backs up, and is idempotent', () => {
  const f = fixture();
  fs.writeFileSync(f.settings, JSON.stringify({ theme: 'user', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } }, null, 2) + '\n');

  let res = run(f, ['--merge', '--settings', f.settings]);
  assert.equal(res.status, 0, res.stderr);
  const first = fs.readFileSync(f.settings, 'utf8');
  const merged = JSON.parse(first);
  assert.equal(merged.theme, 'user');
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'user-hook');
  assert.ok(merged.hooks.Stop.some(entry => entry.hooks[0].command.includes(f.mirror)));
  assert.ok(fs.readdirSync(f.root).some(name => name.startsWith('settings.json.bak-cockpit-')));

  res = run(f, ['--merge', '--settings', f.settings]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), first);
});

test('--print writes resolved, portable generated-hooks.json and --check reports both states', () => {
  const f = fixture();
  let res = run(f, ['--print']);
  assert.equal(res.status, 0, res.stderr);
  const output = fs.readFileSync(path.join(f.mirror, 'generated-hooks.json'), 'utf8');
  assert.deepEqual(JSON.parse(output), JSON.parse(res.stdout));
  assert.ok(!output.includes('__MIRROR__'));
  assert.ok(!output.includes('__MIRROR__'));

  res = run(f, ['--check', '--settings', f.settings]);
  assert.equal(res.status, 1);
  assert.equal(run(f, ['--merge', '--settings', f.settings]).status, 0);
  assert.equal(run(f, ['--check', '--settings', f.settings]).status, 0);
});

test('unparsable settings are refused without being clobbered', () => {
  const f = fixture();
  fs.writeFileSync(f.settings, '{ broken');
  const res = run(f, ['--merge', '--settings', f.settings]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /refusing to modify unparsable settings/);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), '{ broken');
});
