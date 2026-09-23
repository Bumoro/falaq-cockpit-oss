const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-sessions-cache-'));
const sessionsDir = path.join(state, 'sessions');
fs.mkdirSync(sessionsDir);
fs.writeFileSync(path.join(sessionsDir, 'one.json'), JSON.stringify({
  sessionId: 'one',
  state: 'running',
  lastActivityAt: Date.now(),
}));

const originalCreateServer = http.createServer;
const originalReaddirSync = fs.readdirSync;
const originalSetInterval = global.setInterval;
let handler;
let sessionReads = 0;

process.env.COCKPIT_DIR = state;
process.env.AGENT_DASHBOARD_PORT = '4953';
process.env.CK_CCUSAGE_CMD = '/usr/bin/false';

fs.readdirSync = (...args) => {
  if (args[0] === sessionsDir) sessionReads++;
  return originalReaddirSync(...args);
};
http.createServer = callback => {
  handler = callback;
  return { listening: false, on() { return this; }, listen() { return this; } };
};
global.setInterval = (callback, delay, ...args) => {
  const timer = originalSetInterval(callback, delay, ...args);
  timer.unref();
  return timer;
};

require('../server.js');
http.createServer = originalCreateServer;
global.setInterval = originalSetInterval;

after(() => {
  fs.readdirSync = originalReaddirSync;
  http.createServer = originalCreateServer;
  global.setInterval = originalSetInterval;
  fs.rmSync(state, { recursive: true, force: true });
});

function requestSessions() {
  const response = { status: 0, body: '' };
  const req = {
    url: '/api/sessions',
    method: 'GET',
    httpVersion: '1.1',
    headers: { host: 'localhost:4953' },
  };
  const res = {
    setHeader() {},
    writeHead(status) { response.status = status; },
    end(body = '') { response.body = String(body); },
  };
  handler(req, res);
  return response;
}

test('two buildSessions requests within the TTL read the sessions directory once', () => {
  sessionReads = 0;
  const first = requestSessions();
  const second = requestSessions();

  assert.equal(first.status, 200);
  assert.ok(JSON.parse(first.body).some(session => session.sessionId === 'one'));
  assert.equal(second.body, first.body);
  assert.equal(sessionReads, 1);
});
