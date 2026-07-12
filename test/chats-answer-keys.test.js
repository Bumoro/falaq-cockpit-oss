const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub tmux so sendKey never touches a real session.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckkeys-'));
const stub = path.join(dir, 'tmux.sh');
fs.writeFileSync(stub, '#!/bin/bash\nexit 0\n');
fs.chmodSync(stub, 0o755);
process.env.CK_TMUX_BIN = stub;
const { sendKey } = require('../chats.js');

test('sendKey accepts digits 1-9 (choice options) and y/n', () => {
  for (const k of ['1', '4', '9', 'y', 'n']) {
    assert.doesNotThrow(() => sendKey('ck-x', k), `key ${k} should be allowed`);
  }
});

test('sendKey still rejects non-answer characters', () => {
  assert.throws(() => sendKey('ck-x', 'q'), /key not allowed/);
  assert.throws(() => sendKey('ck-x', '0'), /key not allowed/);
});
