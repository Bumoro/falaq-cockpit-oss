const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const autowrap = require('../autowrap.js');
const dirs = [];

// autoWrap ships OFF by default, so tests that expect a wrap to FIRE must enable it explicitly —
// otherwise the gate assertions would pass for the wrong reason (disabled, not gated).
const ON = { autoWrap: { enabled: true, thresholdPct: 0.85 } };

function setup(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autowrap-'));
  dirs.push(dir);
  process.env.COCKPIT_DIR = dir;
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const calls = { sent: [], created: [] };
  const deps = {
    sendInput: (name, text) => calls.sent.push({ name, text }),
    createChat: (opts, cb) => { calls.created.push(opts); if (cb) cb(null, opts); },
    listChats: () => [{ name: 'ck-work', title: 'Work', model: 'opus', effort: 'high', cwd: os.homedir(), profile: 'dev' }],
    readTranscript: () => '',
  };
  return { dir, calls, deps };
}
function session(overrides = {}) {
  return { sessionId: 's1', state: 'idle', chatName: 'ck-work', transcriptPath: '/tmp/transcript', context: { pct: 0.9 }, ...overrides };
}
afterEach(() => {
  delete process.env.COCKPIT_DIR;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// The maintainer's live box runs on the DEFAULT threshold (enabled + autoRestart, no explicit thresholdPct), so
// prove the 0.50 default both APPLIES and FIRES through tick() — not just at the readConfig level.
test('production default (threshold omitted) wraps an idle session once it crosses 50% context', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, autoRestart: true } });
  autowrap.tick([session({ context: { pct: 0.60 } })], deps, 1000);
  assert.deepEqual(calls.sent, [{ name: 'ck-work', text: autowrap.WRAP_MSG }]);
});
test('production default does NOT wrap a session still under 50% context', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, autoRestart: true } });
  autowrap.tick([session({ context: { pct: 0.45 } })], deps, 1000);
  assert.deepEqual(calls.sent, []);
});

test('wraps a controlled high-context idle session exactly once with the canonical message', () => {
  const { calls, deps } = setup(ON);
  autowrap.tick([session()], deps, 1234);
  autowrap.tick([session()], deps, 5678);
  assert.deepEqual(calls.sent, [{ name: 'ck-work', text: autowrap.WRAP_MSG }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(autowrap._stateFile(), 'utf8')), { s1: { phase: 'wrapped', wrappedAt: 1234 } });
});

test('never injects unless every wrap gate passes, especially idle state', () => {
  for (const overrides of [
    { state: 'running' },
    { state: 'needs_you' },
    { context: { pct: 0.84 } },
    { chatName: '' },
  ]) {
    const { calls, deps } = setup(ON);
    autowrap.tick([session(overrides)], deps, 1);
    assert.equal(calls.sent.length, 0, JSON.stringify(overrides));
  }
  // disabled (the default) never injects
  const off = setup({ autoWrap: { enabled: false } });
  autowrap.tick([session()], off.deps, 1);
  assert.equal(off.calls.sent.length, 0);
  const dflt = setup();
  autowrap.tick([session()], dflt.deps, 1);
  assert.equal(dflt.calls.sent.length, 0, 'default (no config) is disabled');
});

test('Codex at high context is passive only and never wraps or relaunches', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.50, autoRestart: true } });
  const codex = session({ provider: 'codex', context: { pct: 0.99 } });
  autowrap.tick([codex], deps, 1);
  deps.readTranscript = () => '<RESUME>should never launch</RESUME>';
  autowrap.tick([codex], deps, 2);
  assert.deepEqual(calls.sent, []);
  assert.deepEqual(calls.created, []);
  assert.equal(fs.existsSync(autowrap._stateFile()), false);
});

test('every non-Claude provider stays passive above the wrap threshold', () => {
  for (const provider of ['ollama', 'antigravity', 'agy']) {
    const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.50, autoRestart: true } });
    autowrap.tick([session({ sessionId: provider, provider, context: { pct: 0.99 } })], deps, 1);
    assert.deepEqual(calls.sent, [], provider);
    assert.deepEqual(calls.created, [], provider);
  }
});

test('send failures are fail-soft and are not recorded as wrapped', () => {
  const { deps } = setup(ON);
  deps.sendInput = () => { throw new Error('tmux unavailable'); };
  assert.doesNotThrow(() => autowrap.tick([session()], deps, 1));
  assert.equal(fs.existsSync(autowrap._stateFile()), false);
});

test('autoRestart off never starts a continuation', () => {
  const { calls, deps } = setup(ON);
  autowrap.tick([session()], deps, 1);
  deps.readTranscript = () => '<RESUME>do the thing</RESUME>';
  autowrap.tick([session()], deps, 2);
  assert.equal(calls.created.length, 0);
});

test('autoRestart starts one continuation from the last resume block with original settings', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.85, autoRestart: true } });
  autowrap.tick([session()], deps, 1);
  deps.readTranscript = () => '<RESUME>old</RESUME> tail <RESUME> do the thing </RESUME>';
  autowrap.tick([session()], deps, 2);
  autowrap.tick([session()], deps, 3);
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.created[0], {
    title: '(cont) Work', prompt: 'do the thing', model: 'opus', effort: 'high', cwd: os.homedir(), profile: 'dev',
  });
  assert.equal(JSON.parse(fs.readFileSync(autowrap._stateFile(), 'utf8')).s1.phase, 'restarted');
});

test('autoRestart ignores the WRAP_MSG placeholder <RESUME> and only uses Claude\'s real block', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.85, autoRestart: true } });
  autowrap.tick([session()], deps, 1);
  // A realistic transcript: the injected WRAP_MSG (with its literal placeholder) THEN Claude's real block.
  deps.readTranscript = () => autowrap.WRAP_MSG + '\nSaved the log.\n<RESUME>continue the migration</RESUME>';
  autowrap.tick([session()], deps, 2);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].prompt, 'continue the migration', 'must not use the placeholder text');
});

test('autoRestart does NOT restart when Claude emits no real resume block (only WRAP_MSG present)', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.85, autoRestart: true } });
  autowrap.tick([session()], deps, 1);
  // Claude replied without a real <RESUME>; the only <RESUME> in the transcript is WRAP_MSG's placeholder.
  deps.readTranscript = () => autowrap.WRAP_MSG + '\nSaved. Done.';
  autowrap.tick([session()], deps, 2);
  autowrap.tick([session()], deps, 3);
  assert.equal(calls.created.length, 0, 'placeholder-only transcript must not spawn a continuation');
});

test('markWrapped registers a manual wrap: tick never double-injects and autoRestart continues it', () => {
  const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.85, autoRestart: true } });
  autowrap.markWrapped('s1', 42);
  assert.deepEqual(JSON.parse(fs.readFileSync(autowrap._stateFile(), 'utf8')), { s1: { phase: 'wrapped', wrappedAt: 42 } });
  // Over-threshold AND idle — the exact case that would double-inject without the registration.
  autowrap.tick([session()], deps, 100);
  assert.deepEqual(calls.sent, []);
  deps.readTranscript = () => '<RESUME>continue after manual wrap</RESUME>';
  autowrap.tick([session()], deps, 200);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].prompt, 'continue after manual wrap');
});

test('markWrapped without a sessionId is a no-op', () => {
  setup(ON);
  autowrap.markWrapped('', 1);
  autowrap.markWrapped(undefined, 1);
  assert.equal(fs.existsSync(autowrap._stateFile()), false);
});

test('readConfig supplies defaults (disabled) and rejects invalid thresholds', () => {
  setup();
  assert.deepEqual(autowrap.readConfig(), { enabled: false, thresholdPct: 0.50, autoRestart: false });
  fs.writeFileSync(path.join(process.env.COCKPIT_DIR, 'config.json'), JSON.stringify({ autoWrap: { enabled: true, thresholdPct: 4, autoRestart: true } }));
  assert.deepEqual(autowrap.readConfig(), { enabled: true, thresholdPct: 0.50, autoRestart: true });
});

test('persistent state round-trips and vanished sessions are pruned', () => {
  const { deps } = setup(ON);
  autowrap.tick([session(), session({ sessionId: 's2' })], deps, 99);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(autowrap._stateFile(), 'utf8'))).sort(), ['s1', 's2']);
  autowrap.tick([session()], deps, 100);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(autowrap._stateFile(), 'utf8'))), ['s1']);
});

test('continuation falls back to the provider default when the saved model/effort is no longer valid', () => {
  const models = require('../models.js');
  models._setCatalogForTests({
    claude: { models: [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }, { id: 'opus', label: 'Opus', efforts: ['low', 'high'] }],
      default: 'sonnet', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    codex: { models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
      default: 'gpt-6-astra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  });
  try {
    // retired codex model → provider default + its default effort
    assert.deepEqual(autowrap._continuationModel({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }), { model: 'gpt-6-astra', effort: 'medium' });
    // model still offered but the effort is not valid for it → default effort for that model
    assert.deepEqual(autowrap._continuationModel({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }), { model: 'gpt-6-astra', effort: 'medium' });
    assert.deepEqual(autowrap._continuationModel({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' }), { model: 'gpt-6-astra', effort: 'high' });
    // through tick(): a Claude chat on a retired model restarts on the provider default
    const { calls, deps } = setup({ autoWrap: { enabled: true, thresholdPct: 0.85, autoRestart: true } });
    deps.listChats = () => [{ name: 'ck-work', title: 'Work', model: 'claude-retired-1', effort: 'max', cwd: os.homedir(), profile: 'dev' }];
    autowrap.tick([session()], deps, 1);
    deps.readTranscript = () => '<RESUME>go on</RESUME>';
    autowrap.tick([session()], deps, 2);
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].model, 'sonnet');
    assert.equal(calls.created[0].effort, 'medium');
  } finally {
    models._setCatalogForTests(null);
  }
});
