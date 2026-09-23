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
  return { chats: require('../chats.js'), dir, log, stub };
}

test('validate rejects bad model, effort, cwd', () => {
  const { chats } = freshEnv();
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-5', effort: 'high' }), /model/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'ultra' }), /effort/);
  assert.match(chats.validate({ cwd: '/etc', model: 'sonnet', effort: 'high' }), /home/);
  assert.match(chats.validate({ cwd: '/nope-nope', model: 'sonnet', effort: 'high' }), /exist/);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'high' }), null);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'gpt-6-astra', effort: 'high', provider: 'codex' }), null);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-6-astra', effort: 'minimal', provider: 'codex' }), /effort/);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'gpt-6-astra', effort: 'xhigh', provider: 'codex' }), null);
  assert.equal(chats.validate({ cwd: os.homedir(), model: 'gpt-6-astra', effort: 'max', provider: 'codex' }), null);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'sonnet', effort: 'high', provider: 'codex' }), /model/);
  assert.match(chats.validate({ cwd: os.homedir(), model: 'gpt-6-astra', effort: 'high', provider: 'other' }), /provider/);
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

test('N chats use one cached tmux list-sessions liveness snapshot', () => {
  const { chats, dir, log, stub } = freshEnv();
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "list-sessions" ]; then
  printf 'ck-one\\nck-three\\n'
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify([
    { name: 'ck-one' },
    { name: 'ck-two' },
    { name: 'ck-three' },
  ]));

  const listed = chats.listChats();

  assert.deepEqual(listed.map(c => c.alive), [true, false, true]);
  assert.equal(chats.isAlive('ck-one'), true, 'isAlive keeps its signature and shares the cache');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter(line => line.startsWith('list-sessions ')).length, 1);
});

test('tmux no-server failure means no live sessions', () => {
  const { chats, dir, log, stub } = freshEnv();
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
exit 1
`);
  fs.chmodSync(stub, 0o755);
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify([
    { name: 'ck-one' },
    { name: 'ck-two' },
  ]));

  assert.deepEqual(chats.listChats().map(c => c.alive), [false, false]);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('createChat launches Codex in a unique correlation cwd and persists its provider', (t, done) => {
  const { chats, dir, log } = freshEnv();
  delete process.env.CK_TEST_CMD;
  const requested = process.env.CK_REPO_ROOT;
  chats.createChat({ provider: 'codex', title: 'codex task', cwd: requested, model: 'gpt-6-astra', effort: 'high' }, (err, chat) => {
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
    assert.match(calls, /codex --model 'gpt-6-astra' --config model_reasoning_effort='high' --add-dir /);
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
        assert.equal(chat.model, 'gpt-6-astra');
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

// Stub factory for the 2.1.259 trust layout: capture-pane calls 1..noFrames render the dialog with
// the cursor on "No, exit", calls noFrames+1..noFrames+yesFrames render it with the cursor on "Yes"
// (as it looks after our Down landed), and from then on the real REPL footer.
function trustNoFirstEnv(noFrames, yesFrames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-trust259-'));
  const log = path.join(dir, 'tmux.log');
  const counter = path.join(dir, 'capture-count');
  const stub = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then
  n=$(cat "${counter}")
  n=$((n+1))
  echo "$n" > "${counter}"
  if [ "$n" -le ${noFrames} ]; then
    echo " Quick safety check: Is this a project you created or one you trust?"
    echo " ❯ No, exit"
    echo "   Yes, I trust this folder"
    echo " Enter to confirm · Esc to cancel"
  elif [ "$n" -le ${noFrames + yesFrames} ]; then
    echo " Quick safety check: Is this a project you created or one you trust?"
    echo "   No, exit"
    echo " ❯ Yes, I trust this folder"
    echo " Enter to confirm · Esc to cancel"
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
  return { chats: require('../chats.js'), log };
}

test('createChat steps the 2.1.259 trust dialog down to Yes before Enter, never a bare Enter on "No, exit"', (t, done) => {
  const { chats, log } = trustNoFirstEnv(2, 2);
  chats.createChat({ title: 'trust no first', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'COCKPIT-E2E-OK' }, (err) => {
    assert.ifError(err);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    const downIdx = calls.findIndex(l => /send-keys -t =ck-trust-no-first:0 Down$/.test(l));
    const enterIdx = calls.findIndex(l => /send-keys -t =ck-trust-no-first:0 Enter$/.test(l));
    const promptIdx = calls.findIndex(l => /send-keys -t =ck-trust-no-first:0 -l COCKPIT-E2E-OK/.test(l));
    assert.ok(downIdx >= 0, 'Down must be sent to move the cursor off "No, exit"');
    assert.ok(enterIdx > downIdx, 'the first Enter must come AFTER Down — a bare Enter on "No, exit" kills the chat');
    // Down and Enter written back-to-back arrive in one stdin read and the TUI swallows the Enter:
    // a capture-pane (= a later tick) must sit between them.
    assert.ok(calls.slice(downIdx + 1, enterIdx).some(l => /^capture-pane /.test(l)), 'Enter must be sent on a later tick than Down, never in the same tick');
    assert.ok(promptIdx > enterIdx, 'the prompt is only typed once the dialog was accepted and the REPL footer appeared');
    done();
  });
});

test('createChat re-sends the trust answer while the dialog stays on screen', (t, done) => {
  // 9 "No" frames then 9 "Yes" frames (≈4.5s each): a keystroke that landed before the dialog was
  // interactive is dropped by the TUI, so both Down and Enter must be re-sent (TRUST_RESEND_TICKS = 6).
  const { chats, log } = trustNoFirstEnv(9, 9);
  chats.createChat({ title: 'trust resend', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'COCKPIT-E2E-OK' }, (err) => {
    assert.ifError(err);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    const promptIdx = calls.findIndex(l => /send-keys -t =ck-trust-resend:0 -l COCKPIT-E2E-OK/.test(l));
    const downs = calls.filter(l => /send-keys -t =ck-trust-resend:0 Down$/.test(l)).length;
    const trustEnters = calls.slice(0, promptIdx).filter(l => /send-keys -t =ck-trust-resend:0 Enter$/.test(l)).length;
    const lastDown = calls.map((l, i) => /send-keys -t =ck-trust-resend:0 Down$/.test(l) ? i : -1).filter(i => i >= 0).pop();
    const firstEnter = calls.findIndex(l => /send-keys -t =ck-trust-resend:0 Enter$/.test(l));
    assert.ok(downs >= 2, 'expected Down to be re-sent while the frame still shows "No", got ' + downs);
    assert.ok(trustEnters >= 2, 'expected Enter to be re-sent while the frame still shows "Yes", got ' + trustEnters);
    assert.ok(firstEnter > lastDown, 'no Enter may be sent while the cursor is still on "No, exit"');
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
    chats.listChats(); // exercises the shared list-sessions liveness snapshot
    chats.killChat('ck-dead');
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    // kill ARCHIVES the record for the Closed-chats history instead of erasing it
    assert.equal(reg.length, 1);
    assert.ok(reg[0].closed > 0, 'killed chat carries a closed timestamp');
    const calls = fs.readFileSync(log, 'utf8');
    // list-sessions takes one global snapshot; kill-session remains window-unqualified.
    assert.match(calls, /list-sessions -F #\{session_name\}$/m);
    assert.match(calls, /kill-session -t =ck-dead$/m);
    assert.doesNotMatch(calls, /-session -t =ck-dead:0/);
    done();
  });
});

// Stub factory for a slow launch (e.g. Claude auto-updating itself on start, live 2026-09-06: the REPL
// footer appeared 90.3s after tmux new-session). capture-pane renders nothing for the first
// `blankFrames` calls, then the real REPL footer forever. readyAt = Infinity never renders it.
function slowLaunchEnv(blankFrames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-slow-'));
  const log = path.join(dir, 'tmux.log');
  const counter = path.join(dir, 'capture-count');
  const stub = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then
  n=$(cat "${counter}")
  n=$((n+1))
  echo "$n" > "${counter}"
  if [ "$n" -gt ${blankFrames} ]; then echo "manual mode on · ← for agents"; fi
fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = stub;
  process.env.CK_TEST_CMD = 'sleep 5';
  delete require.cache[require.resolve('../chats.js')];
  return { chats: require('../chats.js'), dir, log };
}

test('createChat never types the prompt blind: past the soft window it releases the caller as promptPending and delivers once the REPL footer appears', (t, done) => {
  process.env.CK_SETTLE_MAX_TICKS = '3';
  process.env.CK_SETTLE_HARD_MAX_TICKS = '40';
  t.after(() => { delete process.env.CK_SETTLE_MAX_TICKS; delete process.env.CK_SETTLE_HARD_MAX_TICKS; });
  const { chats, dir, log } = slowLaunchEnv(8);
  let cbs = 0;
  chats.createChat({ title: 'slow launch', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'COCKPIT-SLOW-OK' }, (err, chat) => {
    cbs++;
    assert.ifError(err);
    assert.equal(chat.promptPending, true, 'caller is released with promptPending once the soft window expires');
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /-l COCKPIT-SLOW-OK/, 'the prompt must NOT be typed blind at the soft window');
    const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    assert.equal(reg[0].pendingPrompt, 'COCKPIT-SLOW-OK', 'the prompt text is persisted while delivery is pending');
    const deadline = Date.now() + 15000;
    const poll = setInterval(() => {
      const calls = fs.readFileSync(log, 'utf8');
      if (!/-l COCKPIT-SLOW-OK/.test(calls)) { if (Date.now() > deadline) { clearInterval(poll); done(new Error('prompt never delivered')); } return; }
      clearInterval(poll);
      const lines = calls.trim().split('\n');
      assert.ok(lines.filter(l => /^capture-pane/.test(l)).length > 8, 'the prompt is typed only after the footer frame was observed');
      assert.equal(lines.filter(l => /-l COCKPIT-SLOW-OK/.test(l)).length, 1, 'typed exactly once');
      assert.equal(cbs, 1, 'callback fires exactly once');
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
      assert.equal(after[0].pendingPrompt, undefined, 'pendingPrompt is cleared on delivery');
      assert.equal(after[0].promptPending, undefined, 'promptPending never leaks into the registry');
      done();
    }, 50);
  });
});

test('createChat gives up at the hard cap without typing, and records promptUndelivered on the chat', (t, done) => {
  process.env.CK_SETTLE_MAX_TICKS = '2';
  process.env.CK_SETTLE_HARD_MAX_TICKS = '6';
  t.after(() => { delete process.env.CK_SETTLE_MAX_TICKS; delete process.env.CK_SETTLE_HARD_MAX_TICKS; });
  const { chats, dir, log } = slowLaunchEnv(Infinity);
  chats.createChat({ title: 'never ready', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'COCKPIT-NEVER' }, (err, chat) => {
    assert.ifError(err);
    assert.equal(chat.promptPending, true);
    const deadline = Date.now() + 15000;
    const poll = setInterval(() => {
      let reg;
      try { reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')); } catch (e) { return; }
      const rec = reg.find(c => c.name === chat.name);
      if (!rec || !rec.promptUndelivered) { if (Date.now() > deadline) { clearInterval(poll); done(new Error('hard cap never recorded')); } return; }
      clearInterval(poll);
      assert.equal(rec.pendingPrompt, 'COCKPIT-NEVER', 'the lost prompt text stays readable for manual recovery');
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /-l COCKPIT-NEVER/, 'a prompt the REPL never became ready for is never typed');
      assert.match(fs.readFileSync(path.join(dir, 'error.log'), 'utf8'), /promptUndelivered ck-never-ready/);
      assert.equal(chats.clearPromptState('ck-never-ready'), true, 'manual input clears the markers');
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).find(c => c.name === chat.name);
      assert.equal(after.promptUndelivered, undefined);
      assert.equal(after.pendingPrompt, undefined);
      done();
    }, 50);
  });
});

test('createChat records promptUndelivered when send-keys fails after the footer appeared', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-sendfail-'));
  const log = path.join(dir, 'tmux.log');
  const stub = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "❯ ? for shortcuts"; fi
if [ "$1" = "send-keys" ] && [ "$3" = "=ck-vanish:0" ]; then exit 1; fi
exit 0
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir; process.env.CK_TMUX_BIN = stub; process.env.CK_TEST_CMD = 'sleep 5';
  delete require.cache[require.resolve('../chats.js')];
  const chats = require('../chats.js');
  chats.createChat({ title: 'vanish', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'GONE' }, (err, chat) => {
    assert.ifError(err);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).find(c => c.name === chat.name);
    assert.equal(rec.promptUndelivered, true, 'a failed send is never reported as delivered');
    assert.equal(rec.pendingPrompt, 'GONE');
    assert.match(fs.readFileSync(path.join(dir, 'error.log'), 'utf8'), /send-keys failed/);
    done();
  });
});

test('killChat cancels a settle loop still waiting to type the first prompt', (t, done) => {
  process.env.CK_SETTLE_MAX_TICKS = '2';
  process.env.CK_SETTLE_HARD_MAX_TICKS = '400';
  t.after(() => { delete process.env.CK_SETTLE_MAX_TICKS; delete process.env.CK_SETTLE_HARD_MAX_TICKS; });
  const { chats, dir, log } = slowLaunchEnv(6);
  chats.createChat({ title: 'killed early', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'TOO-LATE' }, (err, chat) => {
    assert.ifError(err);
    assert.equal(chat.promptPending, true);
    chats.killChat(chat.name);
    setTimeout(() => {
      const calls = fs.readFileSync(log, 'utf8');
      assert.doesNotMatch(calls, /-l TOO-LATE/, 'no prompt may be typed into a chat the operator closed');
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).find(c => c.name === chat.name);
      assert.ok(rec.closed > 0);
      assert.equal(rec.promptUndelivered, undefined, 'a cancelled launch is not an undelivered one');
      done();
    }, 1500);
  });
});

test('tick overrides reject malformed or non-positive values', () => {
  process.env.CK_SETTLE_MAX_TICKS = '-5';
  process.env.CK_SETTLE_HARD_MAX_TICKS = '3abc';
  delete require.cache[require.resolve('../chats.js')];
  require('../chats.js');
  delete process.env.CK_SETTLE_MAX_TICKS; delete process.env.CK_SETTLE_HARD_MAX_TICKS;
  // loads without throwing and, with both overrides rejected, keeps the soft window strictly below the cap
  const { chats } = freshEnv();
  assert.ok(chats.createChat, 'module reloads with defaults');
});

test('killChat terminates the pane process and its children, not just the tmux session (Claude ignores tmux SIGHUP)', (t, done) => {
  // Live 2026-09-07: six chats killed via tmux kill-session left six `claude` processes running
  // for 4–7 days (~1.2 GB). The stub reports a real process-group leader (with a child, like the MCP
  // servers claude spawns) as the pane pid; killChat must reap the whole group.
  const { spawn } = require('child_process');
  const victim = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore', detached: true });
  victim.unref();
  t.after(() => { try { process.kill(-victim.pid, 'SIGKILL'); } catch (e) {} });
  const { chats, log, stub } = freshEnv();
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${log}"
if [ "$1" = "capture-pane" ]; then echo "❯ ? for shortcuts"; fi
if [ "$1" = "list-panes" ]; then echo "${victim.pid}"; fi
exit 0
`);
  const exited = new Promise(resolve => victim.on('exit', resolve));
  chats.createChat({ title: 'orphan', cwd: os.homedir(), model: 'sonnet', effort: 'medium' }, () => {
    setTimeout(() => {
      chats.killChat('ck-orphan');
      const calls = fs.readFileSync(log, 'utf8');
      assert.match(calls, /list-panes -t =ck-orphan -F #\{pane_pid\}/, 'pane pid is read before the session is killed');
      assert.match(calls, /kill-session -t =ck-orphan$/m);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('pane process still alive after 3s')), 3000));
      Promise.race([exited, timeout]).then(() => {
        // the child `sleep` must be gone too — it shares the group
        const { execSync } = require('child_process');
        const kids = execSync('pgrep -P ' + victim.pid + ' || true', { encoding: 'utf8' }).trim();
        assert.equal(kids, '', 'children of the pane process are terminated with it');
        done();
      }).catch(done);
    }, 200);
  });
});

test('reconcilePendingPrompts flags restart-orphaned pending prompts as undelivered, keeps the text, skips closed/active ones', () => {
  const { chats, dir } = freshEnv();
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify([
    { name: 'ck-orphaned', title: 'o', cwd: os.homedir(), model: 'sonnet', effort: 'medium', createdAt: 1, pendingPrompt: 'lost on restart' },
    { name: 'ck-closed', title: 'c', cwd: os.homedir(), model: 'sonnet', effort: 'medium', createdAt: 1, pendingPrompt: 'x', closed: 5 },
    { name: 'ck-done', title: 'd', cwd: os.homedir(), model: 'sonnet', effort: 'medium', createdAt: 1 },
  ]));
  assert.deepEqual(chats.reconcilePendingPrompts(), ['ck-orphaned']);
  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
  assert.equal(reg[0].promptUndelivered, true);
  assert.equal(reg[0].pendingPrompt, 'lost on restart', 'text retained for manual recovery');
  assert.equal(reg[1].promptUndelivered, undefined, 'closed records are left alone');
  assert.equal(reg[2].promptUndelivered, undefined);
  assert.match(fs.readFileSync(path.join(dir, 'error.log'), 'utf8'), /promptUndelivered ck-orphaned \(delivery interrupted by a cockpit restart\)/);
  assert.deepEqual(chats.reconcilePendingPrompts(), [], 'idempotent');
});

test('clearPromptState cancels a settle loop still waiting, so manual recovery is never followed by an automatic second send', (t, done) => {
  process.env.CK_SETTLE_MAX_TICKS = '2';
  process.env.CK_SETTLE_HARD_MAX_TICKS = '400';
  t.after(() => { delete process.env.CK_SETTLE_MAX_TICKS; delete process.env.CK_SETTLE_HARD_MAX_TICKS; });
  const { chats, dir, log } = slowLaunchEnv(6);
  chats.createChat({ title: 'recovered', cwd: os.homedir(), model: 'sonnet', effort: 'medium', prompt: 'AUTO-COPY' }, (err, chat) => {
    assert.ifError(err);
    assert.equal(chat.promptPending, true);
    assert.equal(chats.clearPromptState(chat.name), true);
    setTimeout(() => {
      assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /-l AUTO-COPY/, 'the automatic delivery must not fire after manual recovery');
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).find(c => c.name === chat.name);
      assert.equal(rec.pendingPrompt, undefined);
      assert.equal(rec.promptUndelivered, undefined, 'the cancelled loop must not re-mark the chat undelivered later');
      done();
    }, 1500);
  });
});

test('loadChatsStrict: missing file is an empty registry, unreadable/corrupt registry throws (loadChats swallows both)', () => {
  const { chats, dir } = freshEnv();
  assert.deepEqual(chats.loadChatsStrict(), []);
  fs.writeFileSync(path.join(dir, 'chats.json'), '{not json');
  assert.throws(() => chats.loadChatsStrict(), /JSON|Unexpected/);
  assert.deepEqual(chats.listChats(), [], 'the lenient reader still degrades to []');
  fs.writeFileSync(path.join(dir, 'chats.json'), '{"a":1}');
  assert.throws(() => chats.loadChatsStrict(), /not an array/);
});
