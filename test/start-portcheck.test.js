// test/start-portcheck.test.js — start.js is the SessionStart-hook launcher. It must gate on the
// PORT (not the pid file): don't spawn a duplicate when a server already listens, and do spawn when
// the port is free — always exiting promptly (a hung hook would delay every new Claude session).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..');       // flat layout: server.js + start.js live at the root
const SERVER = path.join(DIR, 'server.js');
const START = path.join(DIR, 'start.js');

const wait = ms => new Promise(r => setTimeout(r, ms));

function listening(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    let done = false;
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    s.setTimeout(500, () => fin(false));
  });
}
async function waitListen(port, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await listening(port)) return true; await wait(50); }
  return false;
}
function killPidFile(port) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DIR, `server-${port}.pid`), 'utf8').trim());
    if (pid) process.kill(pid, 'SIGTERM');
  } catch (_) {}
}

test('start.js does NOT spawn a duplicate when the port is already served', async () => {
  const PORT = '3961';
  const seed = spawn('node', [SERVER], { env: { ...process.env, AGENT_DASHBOARD_PORT: PORT }, stdio: 'ignore' });
  try {
    assert.ok(await waitListen(3961), 'seed server should come up');
    const res = spawnSync('node', [START], { env: { ...process.env, AGENT_DASHBOARD_PORT: PORT }, timeout: 5000 });
    assert.equal(res.status, 0, 'start.js exits 0 when the port is held');
    assert.equal(res.signal, null, 'start.js returned on its own (not killed by the 5s watchdog) — never hangs');
    assert.ok(await listening(3961), 'the original server is still the one serving the port');
  } finally {
    seed.kill();
    await wait(200);
  }
});

test('start.js spawns exactly one server when the port is free', async () => {
  const PORT = '3963';
  assert.equal(await listening(3963), false, 'port must be free before the test');
  const res = spawnSync('node', [START], { env: { ...process.env, AGENT_DASHBOARD_PORT: PORT }, timeout: 5000 });
  try {
    assert.equal(res.status, 0, 'start.js exits 0 on a free port');
    assert.equal(res.signal, null, 'start.js returned before the 5s watchdog — never hangs');
    assert.ok(await waitListen(3963), 'start.js should have launched a detached server that comes up');
  } finally {
    killPidFile(3963);
    await wait(200);
  }
});
