const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-pages-route-'));
const originalCreateServer = http.createServer;
const originalSetInterval = global.setInterval;
let handler;

process.env.COCKPIT_DIR = state;
process.env.AGENT_DASHBOARD_PORT = '4988';
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
  http.createServer = originalCreateServer;
  global.setInterval = originalSetInterval;
  fs.rmSync(state, { recursive: true, force: true });
});

function request(pathname) {
  const response = { status: 0, headers: {}, body: '' };
  const req = { url: pathname, method: 'GET', headers: {} };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      response.status = status;
      for (const [name, value] of Object.entries(headers)) response.headers[name.toLowerCase()] = value;
    },
    end(body = '') { response.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body); },
  };
  handler(req, res);
  return response;
}

test('friendly pages are routed while the old dashboard remains at /classic', () => {
  const cases = [
    ['/', 'home.html', /What do you want to do\?/],
    ['/help', 'help.html', /What “Needs you” means/],
    ['/classic', 'index.html', /Falaq Agent Dashboard/],
    ['/index.html', 'index.html', /Falaq Agent Dashboard/],
  ];

  for (const [url, file, marker] of cases) {
    const served = request(url);
    assert.equal(served.status, 200, url);
    assert.match(served.headers['content-type'], /^text\/html/, url);
    assert.equal(served.body, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), url);
    assert.match(served.body, marker, url);
  }
});
