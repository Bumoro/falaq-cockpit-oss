const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckcodex-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckstate-'));
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ clientMap: { 'my-app': 'My App' } }));
  process.env.CK_CODEX_DIR = root;
  process.env.COCKPIT_DIR = state;
  delete require.cache[require.resolve('../codex.js')];
  return { codex: require('../codex.js'), root, state };
}
function writeRollout(root, y, m, d, name, meta, mtimeMs) {
  const dir = path.join(root, y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ timestamp: 't', type: 'session_meta', payload: meta }) + '\n{"type":"event"}\n');
  if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}

test('activeTasks lists a fresh rollout with meta + resolved client, sorted newest first', () => {
  const { codex, root } = setup();
  const now = 1783520000000;
  writeRollout(root, '2026', '07', '08', 'rollout-fresh-1.jsonl',
    { id: 'cx-1', cwd: '/Users/o/work/my-app', originator: 'Claude Code' }, now - 30 * 1000);
  writeRollout(root, '2026', '07', '08', 'rollout-fresh-2.jsonl',
    { id: 'cx-2', cwd: '/Users/o/other', originator: 'Claude Code' }, now - 90 * 1000);
  const tasks = codex.activeTasks({ now, freshMs: 3 * 60 * 1000 });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, 'cx-1', 'newest (most recently written) first');
  assert.equal(tasks[0].client, 'My App', 'cwd mapped to client via config.json');
  assert.equal(tasks[1].id, 'cx-2');
});

test('activeTasks ignores stale rollouts (past the freshness window)', () => {
  const { codex, root } = setup();
  const now = 1783520000000;
  writeRollout(root, '2026', '07', '08', 'rollout-stale.jsonl',
    { id: 'old', cwd: '/x', originator: 'Claude Code' }, now - 40 * 60 * 1000); // 40 min old
  const tasks = codex.activeTasks({ now, freshMs: 3 * 60 * 1000 });
  assert.equal(tasks.length, 0, 'a 40-min-old rollout is not an active task');
});

test('activeTasks skips a fresh rollout with no session_meta, and falls back to cwd basename for client', () => {
  const { codex, root } = setup();
  const now = 1783520000000;
  const dir = path.join(root, '2026', '07', '08'); fs.mkdirSync(dir, { recursive: true });
  const bad = path.join(dir, 'rollout-bad.jsonl');
  fs.writeFileSync(bad, '{"type":"event","payload":{}}\n'); fs.utimesSync(bad, new Date(now - 1000), new Date(now - 1000));
  writeRollout(root, '2026', '07', '08', 'rollout-good.jsonl',
    { id: 'g', cwd: '/Users/o/some-repo', originator: 'Claude Code' }, now - 2000); // unmapped cwd
  const tasks = codex.activeTasks({ now, freshMs: 3 * 60 * 1000 });
  assert.equal(tasks.length, 1, 'the malformed (no session_meta) rollout is skipped');
  assert.equal(tasks[0].id, 'g');
  assert.equal(tasks[0].client, 'some-repo', 'an unmapped cwd resolves to its basename');
});

test('activeTasks parses a real-shaped meta line whose base_instructions overflows the read buffer', () => {
  const { codex, root } = setup();
  const now = 1783520000000;
  const dir = path.join(root, '2026', '07', '08'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'rollout-big.jsonl');
  // a REAL rollout embeds the whole system prompt here — bigger than the read buffer
  const huge = 'system prompt '.repeat(4000); // ~56 KB
  const line = JSON.stringify({ timestamp: 't', type: 'session_meta', payload: {
    id: 'cx-big', cwd: '/Users/o/my-app', originator: 'Codex Desktop',
    cli_version: '0.140.0', base_instructions: { text: huge },
  } });
  fs.writeFileSync(f, line + '\n{"type":"event"}\n');
  fs.utimesSync(f, new Date(now - 1000), new Date(now - 1000));
  const tasks = codex.activeTasks({ now, freshMs: 3 * 60 * 1000 });
  assert.equal(tasks.length, 1, 'the oversized meta line is still parsed, not dropped');
  assert.equal(tasks[0].id, 'cx-big');
  assert.equal(tasks[0].client, 'My App', 'cwd still resolves despite the overflow');
  assert.equal(tasks[0].originator, 'Codex Desktop');
});

test('readMeta ignores session_meta on a LATER line — only the first record defines a task', () => {
  const { codex, root } = setup();
  const now = 1783520000000;
  const dir = path.join(root, '2026', '07', '08'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'rollout-weird.jsonl');
  // first line is NOT session_meta (an event with its own id/cwd); a LATER line IS session_meta —
  // the fallback must anchor to line 1 and not mine ids from anywhere in the buffer.
  fs.writeFileSync(f,
    '{"type":"event","payload":{"id":"evt-1","cwd":"/x"}}\n' +
    '{"type":"session_meta","payload":{"id":"cx-late","cwd":"/Users/o/my-app","originator":"x"}}\n');
  fs.utimesSync(f, new Date(now - 1000), new Date(now - 1000));
  const tasks = codex.activeTasks({ now, freshMs: 3 * 60 * 1000 });
  assert.equal(tasks.length, 0, 'a non-meta first line is not a task, even if a later line is session_meta');
});

test('activeTasks tolerates a missing/empty codex dir', () => {
  const { codex } = setup();
  process.env.CK_CODEX_DIR = path.join(os.tmpdir(), 'does-not-exist-' + Math.round(1e6 * 0.5));
  assert.deepEqual(codex.activeTasks({ now: 1783520000000 }), []);
});
