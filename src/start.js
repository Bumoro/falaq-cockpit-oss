#!/usr/bin/env node
// start.js — SessionStart hook: ensure the Falaq Cockpit dashboard server is running.
//
// The authoritative "is it up?" signal is the PORT, not the pid file. A stale or missing pid file
// must not block a needed start, and a live listener (whatever its pid) must not trigger a duplicate
// server. So we probe the port with a TCP connect: if something accepts, the server is up and we
// exit; otherwise we launch it. server.js owns server.pid (written only after it wins the bind) and
// exits on EADDRINUSE, so even a rare probe->spawn race self-heals to exactly one listener.

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PORT = parseInt(process.env.AGENT_DASHBOARD_PORT || '3847');
const SERVER_FILE = path.join(DIR, 'server.js');

function launch() {
  if (!fs.existsSync(SERVER_FILE)) process.exit(0); // not installed yet
  spawn('node', [SERVER_FILE], { detached: true, stdio: 'ignore', cwd: DIR }).unref();
  process.exit(0);
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
