// ~/.claude/agent-dashboard/test/watchers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const sink = path.join(dir, 'sink.jsonl');
  process.env.COCKPIT_DIR = dir;
  process.env.CK_HTTP_SINK = sink;
  process.env.CK_WEBHOOK_FILE = path.join(dir, '.slack-webhook');
  fs.writeFileSync(process.env.CK_WEBHOOK_FILE, 'https://hooks.slack.test/xxx');
  delete require.cache[require.resolve('../watchers.js')];
  return { w: require('../watchers.js'), dir, sink };
}

test('readAll ignores watcher-config.json and non-record files', (t, done) => {
  const { w, dir } = fresh();
  fs.mkdirSync(path.join(dir, 'watchers'), { recursive: true });
  // a config file and a stray json that are NOT watcher records
  fs.writeFileSync(path.join(dir, 'watchers', 'watcher-config.json'), JSON.stringify({ ci: { repos: ['x'] } }));
  fs.writeFileSync(path.join(dir, 'watchers', 'junk.json'), JSON.stringify({ foo: 1 }));
  w.runAll([{ name: 'ci', check: (cb) => cb(null, { state: 'green', summary: 's' }) }], () => {
    const all = w.readAll();
    assert.equal(all.length, 1, 'only the real ci watcher record is returned');
    assert.equal(all[0].name, 'ci');
    done();
  });
});

test('first run records state, notifies on later change only', (t, done) => {
  const { w, dir, sink } = fresh();
  let phase = 'green';
  const checks = [{ name: 'ci', check: (cb) => cb(null, { state: phase, summary: 'PRs ' + phase, detail: '' }) }];
  w.runAll(checks, (res1) => {
    // first observation: changed=true (unknown -> green), one notify
    assert.equal(res1[0].changed, true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'ci.json'), 'utf8'));
    assert.equal(stored.state, 'green');
    w.runAll(checks, (res2) => {
      // same state -> no change, no new notify
      assert.equal(res2[0].changed, false);
      phase = 'red';
      w.runAll(checks, (res3) => {
        assert.equal(res3[0].changed, true);
        const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
        // notifies: green (first) + red (third) = 2
        assert.equal(lines.length, 2);
        assert.match(lines[1], /red/);
        done();
      });
    });
  });
});

test('no webhook file -> pendingNotify set, no sink write', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  process.env.COCKPIT_DIR = dir;
  process.env.CK_HTTP_SINK = path.join(dir, 'sink.jsonl');
  process.env.CK_WEBHOOK_FILE = path.join(dir, '.slack-webhook'); // does NOT exist
  delete require.cache[require.resolve('../watchers.js')];
  const w = require('../watchers.js');
  w.runAll([{ name: 'x', check: (cb) => cb(null, { state: 'green', summary: 's' }) }], (res) => {
    assert.equal(res[0].changed, true);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'x.json'), 'utf8'));
    assert.ok(stored.pendingNotify, 'pendingNotify recorded when no webhook');
    assert.ok(!fs.existsSync(process.env.CK_HTTP_SINK), 'no sink write without webhook');
    done();
  });
});

test('a throwing check is recorded as error state, does not crash the run', (t, done) => {
  const { w } = fresh();
  w.runAll([{ name: 'boom', check: (cb) => cb(new Error('nope')) }], (res) => {
    assert.equal(res[0].state, 'error');
    done();
  });
});

test('enabled:false makes the runner a no-op with no state writes', (t, done) => {
  const { w, dir, sink } = fresh();
  fs.mkdirSync(path.join(dir, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'watchers', 'watcher-config.json'), JSON.stringify({ enabled: false }));
  let called = false;
  w.runAll([{ name: 'x', check: () => { called = true; } }], (res) => {
    assert.deepEqual(res, []);
    assert.equal(called, false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'watchers')), ['watcher-config.json']);
    assert.equal(fs.existsSync(sink), false);
    done();
  });
});

test('absent enabled key preserves the existing run behavior', (t, done) => {
  const { w, dir } = fresh();
  fs.mkdirSync(path.join(dir, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'watchers', 'watcher-config.json'), JSON.stringify({ ci: { repos: [] } }));
  w.runAll([{ name: 'x', check: (cb) => cb(null, { state: 'green' }) }], (res) => {
    assert.equal(res.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'watchers', 'x.json')));
    done();
  });
});

// ---- sticky email watchers: a transient gmailx miss must never flap none<->hash ----
// NB: assertions run in the *awaited continuation*, not inside runAll's callback —
// runOne wraps a synchronous stub check in try/catch, which would otherwise swallow a
// failing assertion and hang the test. Real checks are async, so this is a test-only quirk.
const runP = (w, checks) => new Promise((res) => w.runAll(checks, res));

test('sticky watcher: a transient none never downgrades a known hash (no flap, no notify)', async () => {
  const { w, dir, sink } = fresh();
  let phase = { state: 'h1abcdef', summary: 'Your D-U-N-S Number is enclosed.' };
  const checks = [{ name: 'duns', sticky: true, check: (cb) => cb(null, phase) }];
  const r1 = await runP(w, checks);
  assert.equal(r1[0].changed, true, 'none -> hash is a real arrival');
  assert.equal(r1[0].state, 'h1abcdef');
  phase = { state: 'none', summary: 'no matching mail (duns)' }; // transient gmailx miss
  const r2 = await runP(w, checks);
  assert.equal(r2[0].changed, false, 'no flap on transient none');
  assert.equal(r2[0].state, 'h1abcdef', 'hash stays sticky');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'duns.json'), 'utf8'));
  assert.equal(stored.state, 'h1abcdef');
  assert.match(stored.summary, /D-U-N-S/, 'keeps the real subject, not "no matching mail"');
  assert.ok(stored.stale, 'flagged stale for observability');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'only the arrival notify fired, never the flap');
});

test('sticky watcher: a genuinely new hash still notifies (status update)', async () => {
  const { w, sink } = fresh();
  let phase = { state: 'under_rev', summary: 'under review' };
  const checks = [{ name: 'salla', sticky: true, check: (cb) => cb(null, phase) }];
  await runP(w, checks);
  phase = { state: 'approved1', summary: 'approved' };
  const r2 = await runP(w, checks);
  assert.equal(r2[0].changed, true, 'hash -> different hash is real signal');
  assert.equal(r2[0].state, 'approved1');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /approved/);
});

test('sticky watcher: an error result keeps the prior hash, marks stale, never notifies', async () => {
  const { w, dir, sink } = fresh();
  let phase = { state: 'h9real', summary: 'real mail subject' };
  const checks = [{ name: 'm', sticky: true, check: (cb) => cb(null, phase) }];
  await runP(w, checks);
  phase = { state: 'error', error: true, summary: 'gmailx failed' }; // token blip / non-zero exit
  const r2 = await runP(w, checks);
  assert.equal(r2[0].state, 'h9real', 'error must not clobber the hash');
  assert.equal(r2[0].changed, false);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'm.json'), 'utf8'));
  assert.equal(stored.state, 'h9real');
  assert.match(stored.summary, /real mail/, 'keeps the last good summary');
  assert.ok(stored.stale, 'flagged stale so a silently-broken token surfaces');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'no error ping');
});

test('sticky watcher: a first-seen none never pings (no arrival yet)', async () => {
  const { w, sink } = fresh();
  const checks = [{ name: 'q', sticky: true, check: (cb) => cb(null, { state: 'none', summary: 'no mail' }) }];
  const r1 = await runP(w, checks);
  assert.equal(r1[0].state, 'none');
  const lines = fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(lines.length, 0, 'a none baseline is boring — never ping');
});

test('sticky watcher: a queued arrival ping survives a later transient none (no webhook yet)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  process.env.COCKPIT_DIR = dir;
  process.env.CK_HTTP_SINK = path.join(dir, 'sink.jsonl');
  process.env.CK_WEBHOOK_FILE = path.join(dir, '.slack-webhook'); // absent -> queue
  delete require.cache[require.resolve('../watchers.js')];
  const w = require('../watchers.js');
  let phase = { state: 'hZarrive', summary: 'arrived' };
  const checks = [{ name: 'p', sticky: true, check: (cb) => cb(null, phase) }];
  await runP(w, checks);
  let stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'p.json'), 'utf8'));
  assert.ok(stored.pendingNotify, 'arrival queued while webhook absent');
  phase = { state: 'none', summary: 'no mail' };
  await runP(w, checks);
  stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'p.json'), 'utf8'));
  assert.equal(stored.state, 'hZarrive');
  assert.ok(stored.pendingNotify, 'queued arrival ping survives the transient none');
});

test('sticky watcher: a queued arrival is drained (not lost) when the webhook returns mid-change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const sink = path.join(dir, 'sink.jsonl');
  const hook = path.join(dir, '.slack-webhook');
  process.env.COCKPIT_DIR = dir;
  process.env.CK_HTTP_SINK = sink;
  process.env.CK_WEBHOOK_FILE = hook; // absent at first -> the arrival queues
  delete require.cache[require.resolve('../watchers.js')];
  const w = require('../watchers.js');
  let phase = { state: 'hArr', summary: 'arrived' };
  const checks = [{ name: 'd', sticky: true, check: (cb) => cb(null, phase) }];
  await runP(w, checks);
  assert.ok(!fs.existsSync(sink), 'nothing sent while webhook absent');
  fs.writeFileSync(hook, 'https://hooks.slack.test/xxx'); // webhook appears...
  phase = { state: 'hApproved', summary: 'approved' };     // ...the same cycle the state moves on
  await runP(w, checks);
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'both the queued arrival and the new state were sent, none dropped');
  assert.match(lines[0], /arrived/, 'queued arrival drained first');
  assert.match(lines[1], /approved/);
});

// ---- monotonic set watchers (email emits `ids`): kills the reorder flap + the aging-out false ping ----

test('set watcher: reordering the same id set never re-pings (sorted-set hash + seen)', async () => {
  const { w, sink } = fresh();
  const entry = (ids, hash) => ({ name: 'mail', sticky: true, check: (cb) => cb(null, { state: hash, ids, summary: 'm' }) });
  const r1 = await runP(w, [entry(['a', 'b'], 'h_ab')]);
  assert.equal(r1[0].changed, true, 'first sight of {a,b} is a real arrival');
  const r2 = await runP(w, [entry(['b', 'a'], 'h_ab')]); // reordered, same set, same set-hash
  assert.equal(r2[0].changed, false, 'a reorder is not a change');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'only the first arrival pinged, never the reorder flap');
});

test('set watcher: a new id pings once; an aged-out id never pings', async () => {
  const { w, sink } = fresh();
  const entry = (ids, hash) => ({ name: 'mail', sticky: true, check: (cb) => cb(null, { state: hash, ids, summary: 'm' }) });
  await runP(w, [entry(['a'], 'h_a')]);                  // first: a -> ping
  await runP(w, [entry(['a'], 'h_a')]);                  // same -> no ping
  const r3 = await runP(w, [entry(['a', 'b'], 'h_ab')]); // new id b -> ping
  assert.equal(r3[0].changed, true, 'a genuinely new id fires');
  const r4 = await runP(w, [entry(['b'], 'h_b')]);       // a aged out of window, b already seen -> no ping
  assert.equal(r4[0].changed, false, 'an id leaving the query window never fires');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'pinged only on first-a and new-b');
});

test('set watcher migration: a legacy record (no seen) adopts current ids without re-firing', async () => {
  const { w, dir } = fresh();
  fs.mkdirSync(path.join(dir, 'watchers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'watchers', 'mail.json'),
    JSON.stringify({ name: 'mail', state: 'legacyhash', summary: 'old subject', history: [] }));
  const entry = { name: 'mail', sticky: true, check: (cb) => cb(null, { state: 'h_a', ids: ['a'], summary: 'still here' }) };
  const r1 = await runP(w, [entry]);
  assert.equal(r1[0].changed, false, 'no re-fire on the one-time migration from a pre-seen record');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'mail.json'), 'utf8'));
  assert.deepEqual(stored.seen, ['a'], 'current ids adopted into the seen set');
  const lines = fs.existsSync(process.env.CK_HTTP_SINK) ? fs.readFileSync(process.env.CK_HTTP_SINK, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(lines.length, 0, 'migration is silent');
});

// ---- panel-found regressions (2026-07-09 review): seen must survive errors; no silent hash churn ----

test('set watcher: `seen` survives an error run — mail that arrived during the error still pings on recovery', async () => {
  const { w, sink } = fresh();
  const mk = (r) => [{ name: 'mail', sticky: true, check: (cb) => cb(null, r) }];
  await runP(w, mk({ state: 'h_a', ids: ['a'], summary: 'a' }));                       // baseline: a seen -> ping
  await runP(w, mk({ state: 'error', error: true, summary: 'gmailx token blip' }));    // transient failure
  const r3 = await runP(w, mk({ state: 'h_ab', ids: ['a', 'b'], summary: 'b arrived' })); // recover: b is genuinely new
  assert.equal(r3[0].changed, true, 'b arrived during the error window and still fires on recovery');
  const lines = fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'ping for a (baseline) + b (post-error); none silently swallowed by a re-seed');
  assert.match(lines[1], /b arrived/);
});

test('set watcher: an id aging out never churns the stored state hash (only a ping moves state)', async () => {
  const { w, dir } = fresh();
  const mk = (r) => [{ name: 'mail', sticky: true, check: (cb) => cb(null, r) }];
  await runP(w, mk({ state: 'h_ab', ids: ['a', 'b'], summary: 'ab subject' })); // fires -> state h_ab
  await runP(w, mk({ state: 'h_b', ids: ['b'], summary: 'b only' }));           // a aged out, no NEW id -> no fire
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'watchers', 'mail.json'), 'utf8'));
  assert.equal(stored.state, 'h_ab', 'state holds at the last fired hash, does not churn to h_b');
  assert.match(stored.summary, /ab subject/, 'the last fired summary is held too');
});
