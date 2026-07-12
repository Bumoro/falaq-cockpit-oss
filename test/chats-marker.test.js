// chats-marker.test.js — the controlled-chat identity marker + taller pane passed to tmux.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmark-'));
  const log = path.join(dir, 'tmux.log');
  const stub = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "❯ ? for shortcuts"; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = stub;
  process.env.CK_TEST_CMD = 'sleep 5';
  delete require.cache[require.resolve('../chats.js')];
  return { chats: require('../chats.js'), dir, log };
}

test('createChat stamps -e CK_CHAT=<name> and a tall -y 200 pane on new-session', (t, done) => {
  const { chats, log } = freshEnv();
  chats.createChat({ title: 'marker test', cwd: os.homedir(), model: 'haiku', effort: 'low' }, (err, chat) => {
    try {
      assert.ifError(err);
      const calls = fs.readFileSync(log, 'utf8');
      const line = calls.split('\n').find(l => l.startsWith('new-session'));
      assert.ok(line, 'a new-session call was logged');
      assert.match(line, new RegExp('-s ' + chat.name + '\\b'));
      assert.match(line, /-y 200\b/);                                  // taller pane
      assert.match(line, new RegExp('-e CK_CHAT=' + chat.name + '\\b')); // identity marker
      done();
    } catch (e) { done(e); }
  });
});
