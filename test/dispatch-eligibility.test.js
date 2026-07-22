const { test } = require('node:test');
const assert = require('node:assert');
const { isEligible } = require('../dispatch/eligibility.js');

const base = () => ({
  id: 't1', title: 'Fix checkout bug', status: 'active',
  tags: ['auto:eligible'], blockedBy: [], owner: null,
  repo: 'Bumoro/client-os', cwd: '/Users/o/client-os', hasPlan: true,
});
const ctx = (over = {}) => ({ runningCwds: new Set(), runningCount: 0, config: { concurrency: 1 }, ...over });

test('happy path is eligible', () => {
  assert.deepStrictEqual(isEligible(base(), ctx()), { ok: true, reason: 'eligible' });
});
test('GATE title is vetoed FIRST, even if otherwise eligible', () => {
  const t = base(); t.title = '🔒 GATE: paste the secret';
  assert.strictEqual(isEligible(t, ctx()).reason, 'gate-veto');
});
test('GATE veto beats a missing tag (checked first)', () => {
  const t = base(); t.title = '🔒 GATE: x'; t.tags = [];
  assert.strictEqual(isEligible(t, ctx()).reason, 'gate-veto');
});
test('untagged task is skipped', () => {
  const t = base(); t.tags = [];
  assert.deepStrictEqual(isEligible(t, ctx()), { ok: false, reason: 'not-tagged' });
});
test('paused workstream is never auto-resumed', () => {
  const t = base(); t.status = 'paused';
  assert.strictEqual(isEligible(t, ctx()).reason, 'status:paused');
});
test('open blockers skip', () => {
  const t = base(); t.blockedBy = ['t0'];
  assert.strictEqual(isEligible(t, ctx()).reason, 'has-blockers');
});
test('claimed task skips', () => {
  const t = base(); t.owner = 'someone';
  assert.strictEqual(isEligible(t, ctx()).reason, 'claimed');
});
test('a live session already on the repo cwd blocks it', () => {
  const t = base();
  assert.strictEqual(isEligible(t, ctx({ runningCwds: new Set([t.cwd]) })).reason, 'repo-busy');
});
test('no plan skips (coding-only needs an executable task)', () => {
  const t = base(); t.hasPlan = false;
  assert.strictEqual(isEligible(t, ctx()).reason, 'no-plan');
});
test('at capacity skips', () => {
  assert.strictEqual(isEligible(base(), ctx({ runningCount: 1 })).reason, 'at-capacity');
});
test('a malformed (non-array) blockedBy fails CLOSED → skip', () => {
  const t = base(); t.blockedBy = 't0';   // e.g. a bare string from the MCP bridge, not an array
  assert.strictEqual(isEligible(t, ctx()).reason, 'has-blockers');
});
test('a null/absent blockedBy means no blockers (eligible)', () => {
  const t = base(); t.blockedBy = null;
  assert.strictEqual(isEligible(t, ctx()).ok, true);
});
