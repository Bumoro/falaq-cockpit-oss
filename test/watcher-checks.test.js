const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const os = require('os');

function withStubs(ghOut, gmailOut) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wchk-'));
  const gh = path.join(dir, 'gh.sh'); const gm = path.join(dir, 'gm.sh');
  fs.writeFileSync(gh, `#!/bin/bash\ncat <<'EOF'\n${ghOut}\nEOF\n`); fs.chmodSync(gh, 0o755);
  fs.writeFileSync(gm, `#!/bin/bash\ncat <<'EOF'\n${gmailOut}\nEOF\n`); fs.chmodSync(gm, 0o755);
  fs.writeFileSync(path.join(dir, 'watcher-config.json'), JSON.stringify({
    ci: { repos: ['owner/repo'] }, deploySha: { enabled: false },
    email: { 'meta-bm': { account: 'omar', query: 'from:meta subject:verification' } },
  }));
  process.env.COCKPIT_DIR = dir; process.env.CK_GH_CMD = gh; process.env.CK_GMAILX_CMD = gm;
  process.env.CK_WATCHER_CONFIG = path.join(dir, 'watcher-config.json');
  delete require.cache[require.resolve('../watchers/checks.js')];
  return require('../watchers/checks.js');
}

test('ci check maps a failing rollup to red', (t, done) => {
  const gh = JSON.stringify([{ number: 5, title: 'x', statusCheckRollup: [{ conclusion: 'FAILURE' }] }]);
  const checks = withStubs(gh, '').buildChecks();
  const ci = checks.find(c => c.name === 'ci');
  ci.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'red'); assert.match(r.summary, /repo/); done(); });
});

test('ci maps STARTUP_FAILURE/ACTION_REQUIRED and legacy failing state to red (no false green)', (t, done) => {
  const gh = JSON.stringify([
    { number: 1, title: 'a', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'STARTUP_FAILURE' }] },
    { number: 2, title: 'b', statusCheckRollup: [{ state: 'FAILURE' }] },
  ]);
  const ci = withStubs(gh, '').buildChecks().find(c => c.name === 'ci');
  ci.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'red'); done(); });
});

test('ci maps an all-SUCCESS rollup (checkrun + legacy status) to green', (t, done) => {
  const gh = JSON.stringify([{ number: 3, title: 'c', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] }]);
  const ci = withStubs(gh, '').buildChecks().find(c => c.name === 'ci');
  ci.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'green'); done(); });
});

test('email watcher state changes when newest id changes', (t, done) => {
  // real gmailx format: "<hexid>  <date>\n  From: ...\n  Subj: <subject>"
  let out = 'aaaaaaaaaaaa1111  Wed, 08 Jul 2026 11:23:12 +0000\n  From: Meta <x@facebookmail.com>\n  Subj: Verification pending';
  const mk = () => withStubs('[]', out).buildChecks().find(c => c.name === 'meta-bm');
  mk().check((e1, r1) => {
    assert.match(r1.summary, /pending/i);
    out = 'bbbbbbbbbbbb2222  Wed, 08 Jul 2026 12:00:00 +0000\n  From: Meta <x@facebookmail.com>\n  Subj: Verification approved';
    mk().check((e2, r2) => { assert.notEqual(r1.state, r2.state); assert.match(r2.summary, /approved/i); done(); });
  });
});

// ---- error vs. genuine no-mail: a failed gmailx must NOT read as a clean "none" ----

function emailStub(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wchk-'));
  const gm = path.join(dir, 'gm.sh');
  fs.writeFileSync(gm, script); fs.chmodSync(gm, 0o755);
  fs.writeFileSync(path.join(dir, 'watcher-config.json'), JSON.stringify({
    email: { 'meta-bm': { account: 'falaq', query: 'from:facebookmail.com verify' } },
  }));
  process.env.COCKPIT_DIR = dir; process.env.CK_GMAILX_CMD = gm;
  process.env.CK_WATCHER_CONFIG = path.join(dir, 'watcher-config.json');
  delete require.cache[require.resolve('../watchers/checks.js')];
  return require('../watchers/checks.js').buildChecks().find(c => c.name === 'meta-bm');
}

test('email watcher returns error (not none) when gmailx exits non-zero', (t, done) => {
  const c = emailStub('#!/bin/bash\necho "gmailx: auth token expired" >&2\nexit 1\n');
  c.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'error'); done(); });
});

test('email watcher returns none on a clean empty result (exit 0, no mail)', (t, done) => {
  const c = emailStub('#!/bin/bash\nexit 0\n');
  c.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'none'); done(); });
});

test('email watchers are tagged sticky; ci/deploy are not', (t) => {
  const checks = withStubs('[]', '').buildChecks();
  assert.equal(checks.find(c => c.name === 'meta-bm').sticky, true, 'email watcher is sticky');
  assert.ok(!checks.find(c => c.name === 'ci').sticky, 'ci is not sticky');
  assert.ok(!checks.find(c => c.name === 'deploy-sha').sticky, 'deploy-sha is not sticky');
});

// ---- the sorted-set hash: gmailx result ORDER must not change the state (the live salla flap) ----

test('email watcher state is stable under gmailx result reordering (sorted-set hash)', (t, done) => {
  const orderA = 'aaaaaaaaaaaa1111  Wed, 08 Jul 2026 11:00:00 +0000\n  Subj: one\n'
               + 'bbbbbbbbbbbb2222  Wed, 08 Jul 2026 12:00:00 +0000\n  Subj: two';
  const orderB = 'bbbbbbbbbbbb2222  Wed, 08 Jul 2026 12:00:00 +0000\n  Subj: two\n'
               + 'aaaaaaaaaaaa1111  Wed, 08 Jul 2026 11:00:00 +0000\n  Subj: one';
  withStubs('[]', orderA).buildChecks().find(c => c.name === 'meta-bm').check((e1, r1) => {
    assert.ifError(e1);
    withStubs('[]', orderB).buildChecks().find(c => c.name === 'meta-bm').check((e2, r2) => {
      assert.ifError(e2);
      assert.equal(r1.state, r2.state, 'same id set in any order -> identical state hash (no flap)');
      assert.deepEqual(r1.ids, ['aaaaaaaaaaaa1111', 'bbbbbbbbbbbb2222'], 'all ids collected + sorted');
      assert.deepEqual(r2.ids, r1.ids);
      done();
    });
  });
});

test('ci reports error (not a false all-clear) when gh fails', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wchk-'));
  const gh = path.join(dir, 'gh.sh');
  fs.writeFileSync(gh, '#!/bin/bash\necho "gh: could not connect to api.github.com" >&2\nexit 1\n'); fs.chmodSync(gh, 0o755);
  fs.writeFileSync(path.join(dir, 'watcher-config.json'), JSON.stringify({ ci: { repos: ['owner/repo'] } }));
  process.env.COCKPIT_DIR = dir; process.env.CK_GH_CMD = gh;
  process.env.CK_WATCHER_CONFIG = path.join(dir, 'watcher-config.json');
  delete require.cache[require.resolve('../watchers/checks.js')];
  const ci = require('../watchers/checks.js').buildChecks().find(c => c.name === 'ci');
  ci.check((err, r) => { assert.ifError(err); assert.equal(r.state, 'error'); assert.equal(r.error, true); done(); });
});

test('missing watcher binaries report error without an unhandled spawn event', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wchk-missing-'));
  const config = path.join(dir, 'watcher-config.json');
  fs.writeFileSync(config, JSON.stringify({ email: { missing: { query: 'anything' } } }));
  process.env.CK_WATCHER_CONFIG = config;
  process.env.CK_GMAILX_CMD = path.join(dir, 'definitely-not-installed');
  delete require.cache[require.resolve('../watchers/checks.js')];
  const check = require('../watchers/checks.js').buildChecks().find(c => c.name === 'missing');
  check.check((err, result) => {
    assert.ifError(err);
    assert.equal(result.state, 'error');
    assert.equal(result.error, true);
    done();
  });
});
