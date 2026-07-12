// session-hook-chatname.test.js — the hook binds a session to its controlled chat via CK_CHAT.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK = path.join(__dirname, '..', 'session-hook.js');

function run(payload, dir, extraEnv) {
  const env = { ...process.env, COCKPIT_DIR: dir };
  // isolate from the runner's real environment (these tests may run INSIDE a ck-* tmux pane)
  delete env.CK_CHAT; delete env.TMUX_PANE; delete env.CK_TMUX_BIN;
  Object.assign(env, extraEnv || {});
  execFileSync('node', [HOOK], { input: JSON.stringify(payload), env });
  const f = path.join(dir, 'sessions', payload.session_id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

test('records chatName from the CK_CHAT env (controlled-chat binding)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckcn-'));
  const s = run({ session_id: 'ckx', hook_event_name: 'SessionStart', cwd: '/x', model: 'claude-opus-4-8' }, dir, { CK_CHAT: 'ck-my-chat' });
  assert.equal(s.chatName, 'ck-my-chat');
});

test('no chatName for an ordinary (terminal-launched) session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckcn-'));
  const s = run({ session_id: 'plain', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  assert.equal(s.chatName, undefined);
});
