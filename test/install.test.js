const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const REPO = process.env.CK_REPO_ROOT;
const INSTALL = path.join(REPO, 'install.sh');
const roots = [];
const ports = [];
let nextPort = 4700 + (process.pid % 300);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-install-'));
  roots.push(root);
  return { root, home: path.join(root, 'home'), mirror: path.join(root, 'mirror'), settings: path.join(root, 'settings.json') };
}

function run(f, args, port = nextPort++) {
  return spawnSync('bash', [INSTALL, ...args], {
    env: { ...process.env, HOME: f.home, CK_MIRROR_DIR: f.mirror, CK_SETTINGS_FILE: f.settings, AGENT_DASHBOARD_PORT: String(port) },
    encoding: 'utf8', timeout: 15000
  });
}

function status(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/live', timeout: 1000 }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

after(() => {
  for (const port of ports) {
    const found = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    for (const pid of found.stdout.trim().split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {} }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('fresh --no-start install syncs whitelist, seeds config, and generates portable hooks', () => {
  const f = fixture();
  const res = run(f, ['--no-start']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const whitelist = fs.readFileSync(path.join(REPO, 'files.whitelist'), 'utf8').trim().split(/\s+/);
  for (const file of whitelist) assert.deepEqual(fs.readFileSync(path.join(f.mirror, file)), fs.readFileSync(path.join(REPO, 'src', file)));
  assert.ok(fs.existsSync(path.join(f.mirror, 'config.json')));
  assert.ok(fs.existsSync(path.join(f.mirror, 'watchers', 'watcher-config.json')));
  const hooks = fs.readFileSync(path.join(f.mirror, 'generated-hooks.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(hooks));
  assert.ok(!hooks.includes('__MIRROR__'));
});

test('reinstall never overwrites personalized config', () => {
  const f = fixture();
  assert.equal(run(f, ['--no-start']).status, 0);
  const config = path.join(f.mirror, 'config.json');
  fs.writeFileSync(config, '{"personal":true}\n');
  const res = run(f, ['--no-start']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"personal":true}\n');
});

test('--merge-hooks installs settings idempotently', () => {
  const f = fixture();
  let res = run(f, ['--no-start', '--merge-hooks']);
  assert.equal(res.status, 0, res.stderr);
  const first = fs.readFileSync(f.settings, 'utf8');
  res = run(f, ['--no-start', '--merge-hooks']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), first);
});

test('full install starts the cockpit and serves /live', async () => {
  const f = fixture();
  const port = nextPort++;
  ports.push(port);
  const res = run(f, [], port);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(await status(port), 200);
});
