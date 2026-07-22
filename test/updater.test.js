const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Updater, decideUpdate, normalizeUpdateConfig, readUpdateConfig,
  readStateFile, writeStateFile, sanitizeText,
} = require('../updater.js');

function fixture(t, overrides) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-updater-state-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-updater-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(stateDir, '.repo-root'), repo);
  t.after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const values = {
    'fetch --quiet origin': '',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main',
    'rev-parse HEAD': '1111111111111111111111111111111111111111',
    'rev-parse origin/main': '2222222222222222222222222222222222222222',
    'status --porcelain': '',
    'merge-base --is-ancestor HEAD origin/main': '',
    'rev-list --count HEAD..origin/main': '2',
    'rev-list --count origin/main..HEAD': '0',
    'log --oneline -5 HEAD..origin/main': '2222222 add feature\n3333333 fix bug',
    'pull --ff-only': '',
    ...(overrides || {}),
  };
  const calls = [];
  const runGit = async (_repo, args, options) => {
    const key = args.join(' ');
    calls.push({ key, options });
    const value = values[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected git call: ${key}`);
    return value;
  };
  return { stateDir, repo, values, calls, runGit };
}

test('decision logic only allows a clean, strictly-behind fast-forward', () => {
  assert.equal(decideUpdate({ behind: 2, ahead: 0, dirty: false, ffPossible: true, current: 'a', latest: 'b' }).canApply, true);

  const dirty = decideUpdate({ behind: 2, ahead: 0, dirty: true, ffPossible: true, current: 'a', latest: 'b' });
  assert.equal(dirty.canApply, false);
  assert.equal(dirty.blocked, 'dirty-tree');

  const diverged = decideUpdate({ behind: 2, ahead: 1, dirty: false, ffPossible: false, current: 'a', latest: 'b' });
  assert.equal(diverged.canApply, false);
  assert.equal(diverged.aheadOrDiverged, true);
  assert.equal(diverged.blocked, 'diverged');

  const current = decideUpdate({ behind: 0, ahead: 0, dirty: false, ffPossible: true, current: 'a', latest: 'a' });
  assert.equal(current.canApply, false);
  assert.equal(current.blocked, undefined);
});

test('update config defaults on and honors either kill switch', (t) => {
  assert.deepEqual(normalizeUpdateConfig(), { check: true, auto: true });
  assert.deepEqual(normalizeUpdateConfig({ update: { auto: false } }), { check: true, auto: false });
  assert.deepEqual(normalizeUpdateConfig({ update: { check: false } }), { check: false, auto: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-update-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readUpdateConfig(dir), { check: true, auto: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ update: { check: false, auto: false } }));
  assert.deepEqual(readUpdateConfig(dir), { check: false, auto: false });
  fs.writeFileSync(path.join(dir, 'config.json'), '{bad');
  assert.deepEqual(readUpdateConfig(dir), { check: true, auto: true });
});

test('state round-trip is atomic and invalid state reads empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-update-roundtrip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'update-state.json');
  assert.equal(writeStateFile(file, { behind: 3, dirty: false }), true);
  assert.deepEqual(readStateFile(file), { behind: 3, dirty: false });
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(readStateFile(file), {});
});

test('check fetches origin, records availability, and sanitizes the log', async (t) => {
  const f = fixture(t, { 'log --oneline -5 HEAD..origin/main': '\u001b[31m2222222  add\tfeature\u001b[0m\n3333333 fix\u0001 bug' });
  const updater = new Updater({ stateDir: f.stateDir, runGit: f.runGit, auto: false, now: () => 1234 });
  const state = await updater.check();
  assert.deepEqual(state, {
    checkedAt: 1234, behind: 2, aheadOrDiverged: false, dirty: false,
    current: '1111111111111111111111111111111111111111',
    latest: '2222222222222222222222222222222222222222',
    log: ['2222222 add feature', '3333333 fix bug'], ffPossible: true,
  });
  assert.deepEqual(updater.readState(), state);
  assert.equal(f.calls[0].key, 'fetch --quiet origin');
  assert.ok(f.calls.every(call => call.options.timeoutMs > 0));
});

test('check falls back to origin/current-branch without an upstream', async (t) => {
  const noUpstream = Object.assign(new Error('no upstream'), { code: 128 });
  const f = fixture(t, {
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': noUpstream,
    'rev-parse --abbrev-ref HEAD': 'trunk',
    'rev-parse origin/trunk': '2222222222222222222222222222222222222222',
    'merge-base --is-ancestor HEAD origin/trunk': '',
    'rev-list --count HEAD..origin/trunk': '1',
    'rev-list --count origin/trunk..HEAD': '0',
    'log --oneline -5 HEAD..origin/trunk': '2222222 next',
  });
  const state = await new Updater({ stateDir: f.stateDir, runGit: f.runGit, auto: false }).check();
  assert.equal(state.behind, 1);
  assert.ok(f.calls.some(call => call.key === 'rev-parse origin/trunk'));
});

test('checks and updates are serialized', async (t) => {
  const f = fixture(t);
  let releaseFirstFetch;
  let firstFetchStarted;
  const started = new Promise(resolve => { firstFetchStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirstFetch = resolve; });
  let fetches = 0;
  const runGit = async (repo, args, options) => {
    if (args.join(' ') === 'fetch --quiet origin' && ++fetches === 1) {
      firstFetchStarted();
      await gate;
    }
    return f.runGit(repo, args, options);
  };
  const updater = new Updater({ stateDir: f.stateDir, runGit, auto: false });
  const first = updater.check();
  await started;
  const second = updater.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1, 'the second check must wait for the first');
  releaseFirstFetch();
  await Promise.all([first, second]);
  assert.equal(fetches, 2);
});

test('manual update re-checks guards, records the transition, pulls, then detaches deploy', async (t) => {
  const f = fixture(t);
  const spawned = [];
  const updater = new Updater({ stateDir: f.stateDir, runGit: f.runGit, auto: false, now: () => 5678, spawnDeploy: repo => spawned.push(repo) });
  const state = await updater.applyUpdate();
  assert.equal(state.status, 'started');
  assert.equal(state.updateStartedAt, 5678);
  assert.equal(state.from, '1111111111111111111111111111111111111111');
  assert.equal(state.to, '2222222222222222222222222222222222222222');
  assert.deepEqual(spawned, [f.repo]);
  assert.equal(f.calls.at(-1).key, 'pull --ff-only');
});

test('a failed pull clears the optimistic updated marker and stays fail-soft', async (t) => {
  const f = fixture(t, { 'pull --ff-only': new Error('pull failed') });
  const updater = new Updater({ stateDir: f.stateDir, runGit: f.runGit, auto: false, now: () => 5678, spawnDeploy: () => assert.fail('deploy must not start') });
  const state = await updater.applyUpdate();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'pull failed');
  assert.equal(state.updateStartedAt, undefined);
  assert.equal(state.from, undefined);
  assert.equal(state.to, undefined);
  assert.deepEqual(updater.readState(), state);
});

test('auto mode applies a safe update immediately after checking', async (t) => {
  const f = fixture(t);
  const spawned = [];
  const state = await new Updater({
    stateDir: f.stateDir, runGit: f.runGit, auto: true,
    spawnDeploy: repo => spawned.push(repo), now: () => 7000,
  }).check();
  assert.equal(state.status, 'started');
  assert.equal(state.updateStartedAt, 7000);
  assert.equal(f.calls.filter(call => call.key === 'fetch --quiet origin').length, 1);
  assert.equal(f.calls.filter(call => call.key === 'pull --ff-only').length, 1);
  assert.deepEqual(spawned, [f.repo]);
});

test('manual update refuses dirty and diverged repositories without pulling', async (t) => {
  const dirty = fixture(t, { 'status --porcelain': ' M src/server.js' });
  const dirtyResult = await new Updater({ stateDir: dirty.stateDir, runGit: dirty.runGit, auto: false }).applyUpdate();
  assert.equal(dirtyResult.blocked, 'dirty-tree');
  assert.equal(dirtyResult.status, 'blocked');
  assert.equal(dirty.calls.some(call => call.key === 'pull --ff-only'), false);

  const exitOne = Object.assign(new Error('not ancestor'), { code: 1 });
  const diverged = fixture(t, {
    'merge-base --is-ancestor HEAD origin/main': exitOne,
    'rev-list --count origin/main..HEAD': '1',
  });
  const divergedResult = await new Updater({ stateDir: diverged.stateDir, runGit: diverged.runGit, auto: false }).applyUpdate();
  assert.equal(divergedResult.blocked, 'diverged');
  assert.equal(diverged.calls.some(call => call.key === 'pull --ff-only'), false);
});

test('missing repo and git failures are persisted and never thrown', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-update-none-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const noRepo = new Updater({ stateDir: dir, auto: false });
  assert.deepEqual(await noRepo.check(), { status: 'no-repo' });

  const f = fixture(t, { 'fetch --quiet origin': new Error('network offline\nretry later') });
  const failed = await new Updater({ stateDir: f.stateDir, runGit: f.runGit, auto: false, now: () => 99 }).check();
  assert.deepEqual(failed, { checkedAt: 99, status: 'error', error: 'network offline retry later' });
  assert.deepEqual(readStateFile(path.join(f.stateDir, 'update-state.json')), failed);
});

test('sanitizeText strips terminal controls and flattens untrusted output', () => {
  assert.equal(sanitizeText('\u001b[1mhello\u001b[0m\nworld\u0000'), 'hello world');
});

test('_reconcile: started resolves to ok only after a restart, failed after 10min, else stays pending', () => {
  const mk = (bootAt, now) => new Updater({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ck-up-')), runGit: () => { throw new Error('no git'); }, auto: false, bootAt, now: () => now });
  const started = { status: 'started', updateStartedAt: 1000, from: 'aaa', to: 'bbb' };
  // restarted after the update began + HEAD is the target -> ok
  assert.deepEqual(mk(2000, 5000)._reconcile(started, 'bbb'), { status: 'ok', from: 'aaa', to: 'bbb', at: 1000 });
  // server never restarted (bootAt before start) -> not ok; young -> pending (undefined lastUpdate)
  assert.equal(mk(500, 5000)._reconcile(started, 'bbb'), undefined);
  // stale (>10min) without confirmation -> failed
  assert.deepEqual(mk(500, 1000 + 10 * 60 * 1000 + 1)._reconcile(started, 'aaa'), { status: 'failed', from: 'aaa', to: 'bbb', at: 1000 });
  // non-started state passes through its lastUpdate
  assert.deepEqual(mk(1, 2)._reconcile({ status: 'blocked', lastUpdate: { status: 'ok', at: 5 } }, 'x'), { status: 'ok', at: 5 });
});
