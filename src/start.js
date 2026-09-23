#!/usr/bin/env node
// start.js — SessionStart hook: ensure the Falaq Cockpit dashboard server is running.
//
// The authoritative "is it up?" signal is the PORT, not the pid file. A stale or missing pid file
// must not block a needed start, and a live listener (whatever its pid) must not trigger a duplicate
// server. So we probe the port with a TCP connect: if something accepts, the server is up and we
// exit; otherwise we launch it. server.js owns server.pid (written only after it wins the bind) and
// exits on EADDRINUSE, so even a rare probe->spawn race self-heals to exactly one listener.

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847');
const SERVER_FILE = path.join(DIR, 'server.js');
const ERROR_LOG = path.join(DIR, 'error.log');

function fail(message) {
  try { fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} start ${message}\n`); } catch (_) {}
  process.exit(1);
}

function verify(attempt = 1) {
  let finished = false;
  const retry = () => {
    if (finished) return;
    finished = true;
    if (attempt >= 12) fail(`server failed to serve /live on port ${PORT}`);
    else setTimeout(() => verify(attempt + 1), 250);
  };
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/live' }, res => {
    res.resume();
    if (res.statusCode === 200) {
      finished = true;
      process.exit(0);
    } else {
      retry();
    }
  });
  req.on('error', retry);
  req.setTimeout(200, () => { req.destroy(); retry(); });
}

function launch() {
  if (!fs.existsSync(SERVER_FILE)) process.exit(0); // not installed yet
  let child;
  try {
    child = spawn(process.execPath, [SERVER_FILE], { detached: true, stdio: 'ignore', cwd: DIR });
  } catch (e) {
    fail(`spawn failed: ${e.message || e}`);
  }
  child.on('error', e => fail(`spawn failed: ${e.message || e}`));
  child.on('spawn', () => verify());
  child.unref();
}

const sock = net.createConnection({ port: PORT, host: '127.0.0.1' });
let settled = false;
function decide(isListening) {
  if (settled) return;
  settled = true;
  try { sock.destroy(); } catch (_) {}
  if (isListening) process.exit(0); // already serving — nothing to do
  else launch();                    // port is free — start the server
}
sock.on('connect', () => decide(true));
sock.on('error', () => decide(false));      // ECONNREFUSED etc. — nobody is listening
sock.setTimeout(1000, () => decide(false)); // unreachable in budget — treat as free (server.js guards EADDRINUSE)
