const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-host-'));
const originalCreateServer = http.createServer;
const originalSetInterval = global.setInterval;
let handler;

process.env.COCKPIT_DIR = state;
process.env.AGENT_DASHBOARD_PORT = '4952';
process.env.CK_ALLOWED_HOSTS = 'cockpit.tail.example';
process.env.CK_CCUSAGE_CMD = '/usr/bin/false';

// config.json is the DURABLE source of extra hosts: the SessionStart hook auto-starts start.js
// without the user's shell env, so a Tailscale-fronted host set only via CK_ALLOWED_HOSTS would
// start 403ing the phone on the next auto-start. Seed it before server.js is required.
fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
  clientMap: { keep: 'Me' },
  allowedHosts: ['my-mac.tail0000.ts.net'],
}));

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
  http.createServer = originalCreateServer;
  global.setInterval = originalSetInterval;
  fs.rmSync(state, { recursive: true, force: true });
});

function request(host, pathname = '/api/token', options = {}) {
  const response = { status: 0, headers: {}, body: '' };
  const headers = { ...(options.headers || {}) };
  if (host !== undefined) headers.host = host;
  const req = {
    url: pathname,
    method: options.method || 'GET',
    httpVersion: options.httpVersion || '1.1',
    headers,
    // Mirror Node: rawHeaders keeps every occurrence, headers.host keeps only the first.
    rawHeaders: options.rawHeaders || (host === undefined ? [] : ['Host', host]),
  };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    writeHead(status, responseHeaders = {}) {
      response.status = status;
      for (const [name, value] of Object.entries(responseHeaders)) response.headers[name.toLowerCase()] = value;
    },
    end(body = '') { response.body = String(body); },
  };
  handler(req, res);
  return response;
}

test('rejects an untrusted Host before token and mutating routes', () => {
  const token = request('127.0.0.1:4952').body;
  assert.equal(request('evil.com').status, 403);
  const mutation = request('evil.com', '/api/chats', {
    method: 'POST',
    headers: { 'x-cockpit-token': token, 'Content-Type': 'application/json' },
  });
  assert.equal(mutation.status, 403);
});

test('accepts loopback Host headers with the actual server port', () => {
  assert.equal(request('127.0.0.1:4952').status, 200);
  assert.equal(request('localhost:4952').status, 200);
  assert.equal(request('[::1]:4952').status, 200);
  assert.equal(request('localhost:4953').status, 403);
});

test('accepts a hostname configured through CK_ALLOWED_HOSTS', () => {
  assert.equal(request('cockpit.tail.example:4952').status, 200);
});

test('accepts a hostname configured through config.json allowedHosts', () => {
  // The real Tailscale-fronted case: `tailscale serve` proxies to 127.0.0.1:3847 but forwards its
  // OWN hostname in Host, so without this the phone view 403s. Bare and :port forms both count —
  // a TLS front-end forwards no port.
  assert.equal(request('my-mac.tail0000.ts.net').status, 200);
  assert.equal(request('my-mac.tail0000.ts.net:4952').status, 200);
  assert.equal(request('MY-MAC.TAIL0000.TS.NET').status, 200, 'Host is case-insensitive');
  assert.equal(request('other.tail0000.ts.net').status, 403, 'a different tailnet host is not implied');
});

test('rejects a smuggled duplicate Host header even when the first one is trusted', () => {
  // Node keeps the FIRST Host and discards the rest, so req.headers.host reads as trusted while a
  // second, attacker-chosen Host rode along. Verified against a real server: it answered 200 before
  // this guard. rawHeaders is the only place the duplicate is still visible.
  const response = request('127.0.0.1:4952', '/api/token', {
    rawHeaders: ['Host', '127.0.0.1:4952', 'Host', 'evil.com'],
  });
  assert.equal(response.status, 403);
});

test('fails closed on a missing Host, including HTTP/1.0 where Host is optional', () => {
  // Host is optional in HTTP/1.0, so exempting it looks harmless — but nothing here speaks 1.0
  // (browsers and curl are 1.1), and the exemption would be a standing bypass for any front-end
  // that downgrades and drops the header.
  assert.equal(request(undefined, '/api/token', { httpVersion: '1.0' }).status, 403);
  assert.equal(request(undefined).status, 403);
  assert.equal(request('').status, 403);
});
