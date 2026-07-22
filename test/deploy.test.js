const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const REAL_REPO = process.env.CK_REPO_ROOT;
assert.ok(REAL_REPO, 'run-tests.sh must export CK_REPO_ROOT');
const DEPLOY = path.join(REAL_REPO, 'deploy.sh');

const roots = [];
const ports = [];
const whitelist = [
  'server.js',
  'start.js',
  'session-hook.js',
  'chats.js',
  'autowrap.js',
  'prompt-reader.js',
  'codex.js',
  'agents.js',
  'context.js',
  'usage.js',
  'transcript.js',
  'watchers.js',
  'live.html',
  'mobile.html',
  'home.html',
  'help.html',
  'index.html',
  'dashboard-state.js',
  'purpose.js',
  'duplicates.js',
  'updater.js',
  'chat.html',
  'nondev-profile.json',
  'watchers/checks.js',
  'dispatch.js',
  'dispatch/eligibility.js',
  'dispatch/completion.js',
  'dispatch/trigger.js',
  'dispatch-profile.json.template',
  'config.json.template',
];

test('deploy fixture whitelist covers every runtime file and config template', () => {
  for (const file of ['dispatch.js', 'dispatch/eligibility.js', 'dispatch/completion.js', 'dispatch/trigger.js', 'dispatch-profile.json.template', 'live.html', 'mobile.html', 'home.html', 'help.html', 'index.html', 'dashboard-state.js', 'purpose.js', 'duplicates.js', 'updater.js', 'config.json.template']) {
    assert.ok(whitelist.includes(file), `${file} missing from deploy fixture whitelist`);
    assert.match(fs.readFileSync(path.join(REAL_REPO, 'files.whitelist'), 'utf8'), new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let nextPort = 4210 + (process.pid % 200);

function throwawayPort() {
  const port = nextPort++;
  assert.equal(listenerPids(port).length, 0, `throwaway port ${port} must be free`);
  return port;
}

function listenerPids(port) {
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (res.status !== 0 && !res.stdout.trim()) return [];
  return res.stdout.trim().split(/\s+/).filter(Boolean);
}

async function waitListen(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (listenerPids(port).length > 0) return true;
    await wait(50);
  }
  return false;
}

function requestStatus(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}

function killPort(port) {
  for (const pid of listenerPids(port)) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
  }
}

after(async () => {
  for (const port of ports) killPort(port);
  await wait(200);
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

function serverSource() {
  return `#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847', 10);
const DIR = __dirname;
const PID_FILE = path.join(DIR, process.env.AGENT_DASHBOARD_PORT ? 'server-' + PORT + '.pid' : 'server.pid');
const server = http.createServer((req, res) => {
  if (req.url === '/live') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('live');
    return;
  }
  if (req.url === '/api/chats/x/transcript') {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('auth');
    return;
  }
  res.writeHead(404);
  res.end('missing');
});
function cleanup() { try { fs.unlinkSync(PID_FILE); } catch (_) {} }
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
server.on('error', () => { if (!server.listening) process.exit(1); });
server.listen(PORT, '127.0.0.1', () => fs.writeFileSync(PID_FILE, String(process.pid)));
`;
}

function startSource() {
  return `#!/usr/bin/env node
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847', 10);
const DIR = __dirname;
function launch() {
  spawn('node', [path.join(DIR, 'server.js')], { detached: true, stdio: 'ignore', cwd: DIR, env: process.env }).unref();
  process.exit(0);
}
const sock = net.createConnection({ port: PORT, host: '127.0.0.1' });
let settled = false;
function decide(up) {
  if (settled) return;
  settled = true;
  try { sock.destroy(); } catch (_) {}
  if (up) process.exit(0);
  launch();
}
sock.on('connect', () => decide(true));
sock.on('error', () => decide(false));
sock.setTimeout(500, () => decide(false));
`;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-deploy-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const mirror = path.join(root, 'mirror');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(mirror, { recursive: true });

  writeFile(path.join(repo, 'run-tests.sh'), '#!/bin/bash\nexit 0\n', 0o755);
  writeFile(path.join(repo, 'files.whitelist'), whitelist.join('\n') + '\n');
  writeFile(path.join(repo, 'src/server.js'), serverSource(), 0o755);
  writeFile(path.join(repo, 'src/start.js'), startSource(), 0o755);
  writeFile(path.join(repo, 'src/config.json'), '{"source":true}\n');
  for (const file of whitelist) {
    if (file === 'server.js' || file === 'start.js') continue;
    writeFile(path.join(repo, 'src', file), `NEW ${file}\n`);
  }

  for (const file of whitelist) {
    writeFile(path.join(mirror, file), `OLD ${file}\n`);
  }
  writeFile(path.join(mirror, 'config.json'), '{"CUSTOM_MARKER":true}\n');
  writeFile(path.join(mirror, 'sessions/x.json'), 'STATE session\n');
  writeFile(path.join(mirror, 'watchers/salla.json'), 'STATE watcher\n');
  writeFile(path.join(mirror, '.token'), 'STATE token\n');

  return { root, repo, mirror };
}

function runDeploy(fixture, port, args = []) {
  return spawnSync('bash', [DEPLOY, ...args], {
    env: {
      ...process.env,
      CK_REPO: fixture.repo,
      CK_MIRROR_DIR: fixture.mirror,
      AGENT_DASHBOARD_PORT: String(port),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('deploy.sh performs a full whitelist sync, preserves state, restarts, and verifies pid ownership', async () => {
  const fixture = makeFixture();
  const port = throwawayPort();
  ports.push(port);

  const res = runDeploy(fixture, port);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  for (const file of whitelist) {
    const content = fs.readFileSync(path.join(fixture.mirror, file), 'utf8');
    if (file === 'server.js') assert.match(content, /server\.listen/);
    else if (file === 'start.js') assert.match(content, /net\.createConnection/);
    else assert.equal(content, `NEW ${file}\n`);
  }
  assert.match(fs.readFileSync(path.join(fixture.mirror, 'config.json'), 'utf8'), /CUSTOM_MARKER/);
  assert.equal(fs.readFileSync(path.join(fixture.mirror, 'sessions/x.json'), 'utf8'), 'STATE session\n');
  assert.equal(fs.readFileSync(path.join(fixture.mirror, 'watchers/salla.json'), 'utf8'), 'STATE watcher\n');
  assert.equal(fs.readFileSync(path.join(fixture.mirror, '.token'), 'utf8'), 'STATE token\n');
  assert.ok(fs.readdirSync(fixture.mirror).some(name => name.startsWith('.deploy-backup-')));

  assert.ok(await waitListen(port), 'server should listen after deploy');
  const pids = listenerPids(port);
  assert.equal(pids.length, 1, 'exactly one listener should remain');
  assert.equal(fs.readFileSync(path.join(fixture.mirror, `server-${port}.pid`), 'utf8'), pids[0]);
  assert.equal(await requestStatus(port, '/live'), 200);
});

test('deploy.sh --dry-run prints a plan without mutating files or starting a server', async () => {
  const fixture = makeFixture();
  const port = throwawayPort();
  ports.push(port);
  const before = new Map(whitelist.map(file => [file, fs.readFileSync(path.join(fixture.mirror, file), 'utf8')]));

  const res = runDeploy(fixture, port, ['--dry-run']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /Planned source sync:/);
  assert.match(res.stdout, /Planned restart:/);

  for (const file of whitelist) {
    assert.equal(fs.readFileSync(path.join(fixture.mirror, file), 'utf8'), before.get(file));
  }
  assert.equal(fs.readdirSync(fixture.mirror).filter(name => name.startsWith('.deploy-backup-')).length, 0);
  assert.equal(listenerPids(port).length, 0);
});

test('deploy.sh --no-restart syncs whitelisted files without starting the server', async () => {
  const fixture = makeFixture();
  const port = throwawayPort();
  ports.push(port);

  const res = runDeploy(fixture, port, ['--no-restart']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /Synced, not restarted/);
  assert.equal(fs.readFileSync(path.join(fixture.mirror, 'chats.js'), 'utf8'), 'NEW chats.js\n');
  assert.match(fs.readFileSync(path.join(fixture.mirror, 'config.json'), 'utf8'), /CUSTOM_MARKER/);
  assert.equal(listenerPids(port).length, 0);
});

test('deploy.sh SIGTERMs a live listener and hands off to exactly one NEW server (the core EADDRINUSE-safety path)', async () => {
  const fixture = makeFixture();
  const port = throwawayPort();
  ports.push(port);

  // Simulate the real pre-deploy state: a running server already holding the port.
  writeFile(path.join(fixture.mirror, 'server.js'), serverSource());
  const old = spawn('node', [path.join(fixture.mirror, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(port) },
    detached: true,
    stdio: 'ignore',
  });
  old.unref();
  assert.ok(await waitListen(port), 'pre-deploy server should be listening');
  const oldPids = listenerPids(port);
  assert.equal(oldPids.length, 1, 'exactly one pre-deploy listener');
  const oldPid = oldPids[0];

  const res = runDeploy(fixture, port);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  // The kill loop + wait_port_empty + relaunch must yield exactly one NEW listener.
  assert.ok(await waitListen(port), 'a server should be listening after redeploy');
  const newPids = listenerPids(port);
  assert.equal(newPids.length, 1, 'exactly one listener after redeploy');
  assert.notEqual(newPids[0], oldPid, 'a NEW server must have replaced the old listener');
  assert.equal(fs.readFileSync(path.join(fixture.mirror, `server-${port}.pid`), 'utf8'), newPids[0]);
  assert.equal(await requestStatus(port, '/live'), 200);

  // The old process must actually be gone (SIGTERM took effect), not merely unbound.
  let dead = false;
  for (let i = 0; i < 40 && !dead; i++) {
    try { process.kill(Number(oldPid), 0); await wait(50); } catch (_) { dead = true; }
  }
  assert.ok(dead, 'the old server process should have exited after SIGTERM');
});
