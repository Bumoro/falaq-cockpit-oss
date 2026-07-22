// session-hook-tmuxname.test.js — legacy controlled chats (no CK_CHAT marker) still link by deriving
// their tmux session name from the pane, so Full-log/dedup work without a restart.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK = path.join(__dirname, '..', 'session-hook.js');

function tmuxStub(dir, sessionName) {
  const stub = path.join(dir, 'tmux-stub.sh');
  // emulate `tmux display-message -p -t <pane> '#S'` -> the session name
  fs.writeFileSync(stub, `#!/bin/bash\nif [ "$1" = "display-message" ]; then echo "${sessionName}"; fi\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}
function run(payload, dir, env) {
  // generous tmux timeout so the bash stub never times out under full-suite concurrent load (flake-proof)
  const base = { ...process.env, COCKPIT_DIR: dir, CK_TMUX_TIMEOUT: '8000' };
  delete base.CK_CHAT; delete base.TMUX_PANE; delete base.CK_TMUX_BIN;
  execFileSync('node', [HOOK], { input: JSON.stringify(payload), env: { ...base, ...env } });
  const f = path.join(dir, 'sessions', payload.session_id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

test('marker-less session inside a ck-* tmux pane derives chatName from the pane', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cktn-'));
  const stub = tmuxStub(dir, 'ck-falaq-os');
  const s = run({ session_id: 'legacy1', hook_event_name: 'SessionStart', cwd: '/Users/omaralsumait' }, dir,
    { TMUX_PANE: '%5', CK_TMUX_BIN: stub });
  assert.equal(s.chatName, 'ck-falaq-os');
});

test('a tmux pane whose session is NOT a ck-* chat does not get a chatName', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cktn-'));
  const stub = tmuxStub(dir, 'my-random-tmux');
  const s = run({ session_id: 'legacy2', hook_event_name: 'SessionStart', cwd: '/x' }, dir,
    { TMUX_PANE: '%1', CK_TMUX_BIN: stub });
  assert.equal(s.chatName, undefined);
  assert.equal(s._tmuxTried, true); // and it won't retry the tmux call on later events
});

test('CK_CHAT marker still wins over the tmux-name fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cktn-'));
  const stub = tmuxStub(dir, 'ck-derived');
  const s = run({ session_id: 'both', hook_event_name: 'SessionStart', cwd: '/x' }, dir,
    { CK_CHAT: 'ck-marker', TMUX_PANE: '%2', CK_TMUX_BIN: stub });
  assert.equal(s.chatName, 'ck-marker');
});

test('a plain (non-tmux) session never shells out and has no chatName', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cktn-'));
  const s = run({ session_id: 'plain', hook_event_name: 'SessionStart', cwd: '/x' }, dir, {});
  assert.equal(s.chatName, undefined);
  assert.equal(s._tmuxTried, undefined); // no TMUX_PANE -> never attempted
});
