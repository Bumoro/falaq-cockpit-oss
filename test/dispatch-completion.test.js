const { test } = require('node:test');
const assert = require('node:assert');
const { checkCompletion } = require('../dispatch/completion.js');

const task = { id: 't1', repo: 'Bumoro/client-os', branch: 'auto/t1-fix' };
// fake gh: returns a canned `gh pr list --head` json (out) with meta.ok
const fakeGh = (out, ok = true) => (args, cb) => cb(out, { ok });

test('PR with all-green rollup → green', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => {
    assert.strictEqual(r.state, 'green'); assert.strictEqual(r.pr, 42);
  });
});
test('PR with a FAILURE check → red (never green)', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'red'));
});
test('PR with an in-progress check → pending', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [{ status: 'IN_PROGRESS' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'pending'));
});
test('no PR yet → none', () => {
  checkCompletion(task, { gh: fakeGh('[]') }, (_e, r) => assert.strictEqual(r.state, 'none'));
});
test('gh failure → error (so the runner holds prior state, never false-done)', () => {
  checkCompletion(task, { gh: fakeGh('', false) }, (_e, r) => assert.strictEqual(r.state, 'error'));
});
test('empty statusCheckRollup → pending, NEVER a false green', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'pending'));
});
test('a legacy EXPECTED status is pending, not green', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [{ state: 'EXPECTED' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'pending'));
});
test('success + an unknown conclusion → pending (green requires ALL affirmatively successful)', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'STALE' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'pending'));
});
test('a malformed (non-array) statusCheckRollup fails closed to pending, never throws/hangs', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: {} }]);
  let called = false;
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => { called = true; assert.strictEqual(r.state, 'pending'); });
  assert.ok(called, 'callback must fire (no throw before cb)');
});
test('a rollup containing a null element does not throw (null filtered)', () => {
  const out = JSON.stringify([{ number: 42, statusCheckRollup: [null, { conclusion: 'SUCCESS' }] }]);
  checkCompletion(task, { gh: fakeGh(out) }, (_e, r) => assert.strictEqual(r.state, 'green'));
});
