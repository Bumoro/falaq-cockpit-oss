const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchBriefLine } = require('../dispatch.js');

test('dispatchBriefLine counts terminal phases', () => {
  assert.equal(dispatchBriefLine({ runs: { a: { phase: 'done' }, b: { phase: 'done' }, c: { phase: 'stuck' }, d: { phase: 'failed' }, e: { phase: 'running' } } }), '🌙 dispatch: 2 PR-ready, 1 needs-you, 1 failed');
});

test('dispatchBriefLine is empty without runs', () => {
  assert.equal(dispatchBriefLine({}), '');
  assert.equal(dispatchBriefLine({ runs: {} }), '');
});
