const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-route-guards-'));
const originalCreateServer = http.createServer;
const originalSetInterval = global.setInterval;
const usageMod = require('../usage.js');
const duplicatesMod = require('../duplicates.js');
const originalReadCache = usageMod.readCache;
const originalStructuralPairs = duplicatesMod.structuralPairs;
let handler;

process.env.COCKPIT_DIR = state;
process.env.AGENT_DASHBOARD_PORT = '4954';
process.env.CK_CCUSAGE_CMD = '/usr/bin/false';

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
  usageMod.readCache = originalReadCache;
  duplicatesMod.structuralPairs = originalStructuralPairs;
  http.createServer = originalCreateServer;
  global.setInterval = originalSetInterval;
  fs.rmSync(state, { recursive: true, force: true });
});

function request(pathname, options = {}) {
  const response = { status: 0, headers: {}, body: '', ended: false };
  const body = options.body || '';
  const req = {
    url: pathname,
    method: options.method || 'GET',
    headers: { host: 'localhost:4954', ...(options.headers || {}) },
    rawHeaders: ['Host', 'localhost:4954'],
    on(event, callback) {
      if (event === 'data' && body) callback(Buffer.from(body));
      if (event === 'end') callback();
      return this;
    },
  };
  const res = {
    headersSent: false,
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      this.headersSent = true;
      response.status = status;
      for (const [name, value] of Object.entries(headers)) response.headers[name.toLowerCase()] = value;
    },
    end(value = '') { response.body = String(value); response.ended = true; },
  };
  handler(req, res);
  return response;
}

test('/api/usage completes with empty JSON when reading the usage cache throws', () => {
  usageMod.readCache = () => { throw new Error('cache unavailable'); };
  const response = request('/api/usage');
  usageMod.readCache = originalReadCache;

  assert.equal(response.status, 200);
  assert.equal(response.ended, true);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), {});
});

test('/api/sessions/save-kill returns 500 JSON when duplicate re-pairing throws', () => {
  duplicatesMod.structuralPairs = () => { throw new Error('re-pair failed'); };
  const token = fs.readFileSync(path.join(state, '.token'), 'utf8').trim();
  const response = request('/api/sessions/save-kill', {
    method: 'POST',
    headers: { 'x-cockpit-token': token },
    body: JSON.stringify({ sessionId: 'one' }),
  });
  duplicatesMod.structuralPairs = originalStructuralPairs;

  assert.equal(response.status, 500);
  assert.equal(response.ended, true);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), { error: 'save-kill failed' }, 'internal error text must not be echoed to the client');
});
