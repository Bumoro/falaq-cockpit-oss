// ~/.claude/agent-dashboard/test/chats.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-'));
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
  process.env.CK_CODEX_LAUNCH_ROOT = path.join(dir, 'codex-launches');
  delete require.cache[require.resolve('../chats.js')];
  return { chats: require('../chats.js'), dir, log };
}

test('validate rejects bad model, effort, cwd', () => {
  const { chats } = freshEnv();
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-5', effort: 'high' }), /model/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'ultra' }), /effort/);
  assert.match(chats.validate({ cwd: '/etc', model: 'sonnet', effort: 'high' }), /home/);
  assert.match(chats.validate({ cwd: '/nope-nope', model: 'sonnet', effort: 'high' }), /exist/);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'high' }), null);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'gpt-5.6-sol', effort: 'high', provider: 'codex' }), null);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'gpt-5.6-sol', effort: 'minimal', provider: 'codex' }), null);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-5.6-sol', effort: 'xhigh', provider: 'codex' }), /effort/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-5.6-sol', effort: 'max', provider: 'codex' }), /effort/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'high', provider: 'codex' }), /model/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-5.6-sol', effort: 'high', provider: 'other' }), /provider/);
});

test('createChat registers chat and passes cwd + command to tmux', (t, done) => {
  const { chats, dir, log } = freshEnv();
  chats.createChat({ title: 'My Test Task!', cwd: os.homedir(), model: 'haiku', effort: 'low', prompt: 'hello world' }, (err, chat) => {
    assert.ifError(err);
    assert.match(chat.name, /^ck-my-test-task/);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    assert.equal(reg.length, 1);
    assert.equal(reg[0].model, 'haiku');
    assert.equal(reg[0].provider, 'claude');
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /new-session -d -s ck-my-test-task/);
    assert.match(calls, new RegExp('-c ' + os.homedir()));
    assert.match(calls, /sleep 5/);            // CK_TEST_CMD used
    assert.match(calls, /send-keys .* -l hello world/); // prompt typed literally
    done();
  });
});

test('legacy chats default to the claude provider when loaded', () => {
  const { chats, dir } = freshEnv();
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify([{ name: 'ck-old', title: 'old' }]));
  assert.equal(chats.listChats()[0].provider, 'claude');
});

test('createChat launches Codex in a unique correlation cwd and persists its provider', (t, done) => {
  const { chats, dir, log } = freshEnv();
  delete process.env.CK_TEST_CMD;
  const requested = process.env.CK_REPO_ROOT;
  chats.createChat({ provider: 'codex', title: 'codex task', cwd: requested, model: 'gpt-5.6-sol', effort: 'high' }, (err, chat) => {
    assert.ifError(err);
    assert.equal(chat.provider, 'codex');
    assert.equal(chat.requestedCwd, requested);
    assert.match(chat.cwd, new RegExp('^' + path.join(dir, 'codex-launches', 'run-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.notEqual(chat.cwd, requested);
    assert.equal(fs.realpathSync(path.join(chat.cwd, 'workspace')), requested);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    assert.equal(reg[0].provider, 'codex');
    assert.equal(reg[0].cwd, chat.cwd);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, new RegExp('-c ' + chat.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(calls, /codex --model gpt-5\.6-sol --config model_reasoning_effort=high --add-dir /);
    assert.match(calls, new RegExp(requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    chats.killChat(chat.name);
    assert.equal(fs.existsSync(chat.cwd), false);
    done();
  });
});

test('Codex defaults its model and rejects unknown providers or Claude-only profiles', (t, done) => {
  const { chats } = freshEnv();
  chats.createChat({ provider: 'wat' }, err => {
    assert.match(err.message, /invalid provider/);
    chats.createChat({ provider: 'codex', profile: 'nondev' }, err2 => {
      assert.match(err2.message, /only the dev/);
      chats.createChat({ provider: 'codex', cwd: os.homedir(), effort: 'medium' }, (err3, chat) => {
        assert.ifError(err3);
        assert.equal(chat.model, 'gpt-5.6-sol');
        assert.equal(chat.provider, 'codex');
        chats.killChat(chat.name);
        done();
      });
    });
  });
});

test('slugify dedupes against registry', (t, done) => {
  const { chats } = freshEnv();
  chats.createChat({ title: 'same', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, (e1) => {
    assert.ifError(e1);
    assert.notEqual(chats.slugify('same'), 'ck-same');
    done();
  });
});

test('sendKey allows only the allowlist; sendInput strips newlines', () => {
  const { chats, log } = freshEnv();
  chats.createChat({ title: 'k', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, () => {});
  chats.sendKey('ck-k', 'esc');
  chats.sendKey('ck-k', 'y');
  assert.throws(() => chats.sendKey('ck-k', 'q'), /not allowed/);
  assert.throws(() => chats.sendKey('bad name', 'enter'), /bad name/);
  chats.sendInput('ck-k', 'line1\nline2');
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /send-keys -t =ck-k:0 Escape/);
  assert.match(calls, /send-keys -t =ck-k:0 -l line1 line2/);
  // session-level command (new-session) must stay window-unqualified (bare name, no =)
  assert.match(calls, /new-session -d -s ck-k /);
});

test('createChat accepts the trust dialog with Enter and only sends the prompt once the real REPL is ready', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-trust-'));
  const log = path.join(dir, 'tmux.log');
  const counter = path.join(dir, 'capture-count');
  const stub = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(counter, '0');
  // Stateful stub: the first 2 capture-pane calls render Claude Code's first-run
  // trust dialog (which also happens to contain a "❯"); only from the 3rd call on
  // does it render the real REPL footer marker.
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then
  n=$(cat "${counter}")
  n=$((n+1))
  echo "$n" > "${counter}"
  if [ "$n" -le 2 ]; then
    echo "Is this a project you created or one you trust?"
    echo "❯ 1. Yes, I trust this folder"
    echo "  2. No, exit"
  else
    echo "manual mode on · ← for agents"
  fi
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = stub;
  process.env.CK_TEST_CMD = 'sleep 5';
  delete require.cache[require.resolve('../chats.js')];
  const chats = require('../chats.js');

  chats.createChat({ title: 'trust dialog', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'COCKPIT-E2E-OK' }, (err) => {
    assert.ifError(err);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    const enterIdx = calls.findIndex(l => /send-keys -t =ck-trust-dialog:0 Enter$/.test(l));
    const promptIdx = calls.findIndex(l => /send-keys -t =ck-trust-dialog:0 -l COCKPIT-E2E-OK/.test(l));
    assert.ok(enterIdx >= 0, 'Enter should have been sent to accept the trust dialog');
    assert.ok(promptIdx >= 0, 'the prompt should eventually be sent');
    assert.ok(enterIdx < promptIdx, 'Enter (accepting the trust dialog) must be sent before the real prompt');
    done();
  });
});

test('createChat with ultracode:true prepends the keyword to the first prompt sent', (t, done) => {
  const { chats, dir, log } = freshEnv();
  chats.createChat({ title: 'ultra task', cwd: os.homedir(), model: 'sonnet', effort: 'medium', ultracode: true, prompt: 'do X' }, (err, chat) => {
    assert.ifError(err);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    assert.equal(reg[0].ultracode, true);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    const sendLine = calls.find(l => /send-keys .* -l /.test(l) && /ultracode/.test(l));
    assert.ok(sendLine, 'expected a send-keys line containing ultracode');
    const idxUltra = sendLine.indexOf('ultracode');
    const idxX = sendLine.indexOf('do X');
    assert.ok(idxX > idxUltra, 'ultracode should come before the prompt text in the sent line');
    done();
  });
});

test('createChat with ultracode:true and empty prompt still sends "ultracode" as the first message', (t, done) => {
  const { chats, log } = freshEnv();
  chats.createChat({ title: 'ultra empty', cwd: os.homedir(), model: 'sonnet', effort: 'medium', ultracode: true }, (err) => {
    assert.ifError(err);
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /send-keys .* -l ultracode$/m);
    done();
  });
});

test('sendTermKey: literal text uses -l; named keys pass the allowlist; junk is rejected', () => {
  const { chats, log } = freshEnv();
  chats.createChat({ title: 't', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, () => {});
  chats.sendTermKey('ck-t', { t: 'text', v: 'x' });
  chats.sendTermKey('ck-t', { t: 'key', v: 'C-c' });   // ctrl-c
  chats.sendTermKey('ck-t', { t: 'key', v: 'Up' });     // arrow
  chats.sendTermKey('ck-t', { t: 'key', v: 'BSpace' }); // backspace
  chats.sendTermKey('ck-t', { t: 'key', v: 'M-b' });    // alt-b (word back)
  chats.sendTermKey('ck-t', { t: 'key', v: 'F5' });
  assert.throws(() => chats.sendTermKey('ck-t', { t: 'key', v: 'Enter; rm -rf ~' }), /not allowed/);
  assert.throws(() => chats.sendTermKey('ck-t', { t: 'key', v: 'DoesNotExist' }), /not allowed/);
  assert.throws(() => chats.sendTermKey('bad name', { t: 'text', v: 'x' }), /bad name/);
  assert.throws(() => chats.sendTermKey('ck-t', { t: 'bogus', v: 'x' }), /bad key spec/);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /send-keys -t =ck-t:0 -l x/);
  assert.match(calls, /send-keys -t =ck-t:0 C-c$/m);
  assert.match(calls, /send-keys -t =ck-t:0 Up$/m);
  assert.match(calls, /send-keys -t =ck-t:0 BSpace$/m);
  assert.match(calls, /send-keys -t =ck-t:0 M-b$/m);
  assert.match(calls, /send-keys -t =ck-t:0 F5$/m);
});

test('sendTermKey: text is length-capped, empty text is a no-op', () => {
  const { chats, log } = freshEnv();
  chats.createChat({ title: 'cap', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, () => {});
  chats.sendTermKey('ck-cap', { t: 'text', v: 'A'.repeat(20000) });
  chats.sendTermKey('ck-cap', { t: 'text', v: '' }); // no-op, no throw
  const line = fs.readFileSync(log, 'utf8').split('\n').find(l => / -l A+/.test(l));
  assert.ok(line, 'literal send present');
  const sent = line.split(' -l ')[1];
  assert.ok(sent.length <= 8192, 'text capped to 8192, got ' + sent.length);
});

test('killChat removes from registry', (t, done) => {
  const { chats, dir, log } = freshEnv();
  chats.createChat({ title: 'dead', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, () => {
    chats.listChats(); // exercises isAlive() -> has-session
    chats.killChat('ck-dead');
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    assert.equal(reg.length, 0);
    const calls = fs.readFileSync(log, 'utf8');
    // has-session/kill-session are session-level and must remain window-unqualified
    assert.match(calls, /has-session -t =ck-dead$/m);
    assert.match(calls, /kill-session -t =ck-dead$/m);
    assert.doesNotMatch(calls, /-session -t =ck-dead:0/);
    done();
  });
});
