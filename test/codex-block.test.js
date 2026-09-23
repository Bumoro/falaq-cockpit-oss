const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshCodex(root) {
  process.env.CK_CODEX_DIR = root;
  delete require.cache[require.resolve('../codex.js')];
  return require('../codex.js');
}

function writeRollout(root, date, name, records) {
  const dir = path.join(root, ...date.split('-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, records.map(record =>
    typeof record === 'string' ? record : JSON.stringify(record)
  ).join('\n') + '\n');
  return file;
}

function count(timestamp, total) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { total_tokens: 999 },
      },
    },
  };
}

test('blockUsage subtracts the last cumulative value strictly before start from the last at end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-'));
  const codex = freshCodex(root);
  writeRollout(root, '2026-07-23', 'one', [
    count('2026-07-23T09:59:59.000Z', 100),
    count('2026-07-23T10:00:00.000Z', 125),
    count('2026-07-23T12:00:00.000Z', 400),
    count('2026-07-23T15:00:00.000Z', 650),
    count('2026-07-23T15:00:01.000Z', 900),
  ]);

  assert.deepEqual(codex.blockUsage(
    '2026-07-23T10:00:00.000Z',
    '2026-07-23T15:00:00.000Z',
  ), {
    totalTokens: 550,
    startTime: '2026-07-23T10:00:00.000Z',
    endTime: '2026-07-23T15:00:00.000Z',
    source: 'codex-rollouts',
  });
});

test('blockUsage sums rollouts across midnight and clamps a reset cumulative counter to zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-midnight-'));
  const codex = freshCodex(root);
  writeRollout(root, '2026-07-22', 'yesterday', [
    count('2026-07-22T21:59:00.000Z', 1000),
    count('2026-07-22T23:59:00.000Z', 1400),
    count('2026-07-23T02:00:00.000Z', 1700),
  ]);
  writeRollout(root, '2026-07-23', 'today', [
    count('2026-07-23T00:30:00.000Z', 75),
    count('2026-07-23T01:30:00.000Z', 225),
  ]);
  writeRollout(root, '2026-07-23', 'reset', [
    count('2026-07-22T21:00:00.000Z', 900),
    count('2026-07-23T01:00:00.000Z', 100),
  ]);

  const usage = codex.blockUsage('2026-07-22T22:00:00.000Z', '2026-07-23T02:00:00.000Z');
  assert.equal(usage.totalTokens, 700 + 225 + 0);
});

test('blockUsage skips malformed telemetry and returns null when no valid totals exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-bad-'));
  const codex = freshCodex(root);
  writeRollout(root, '2026-07-23', 'bad', [
    '{broken',
    { timestamp: 'not-a-time', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 10 } } } },
    count('2026-07-23T12:00:00.000Z', '10'),
    { timestamp: '2026-07-23T12:30:00.000Z', type: 'event_msg', payload: { type: 'other' } },
  ]);
  assert.equal(codex.blockUsage('2026-07-23T10:00:00.000Z', '2026-07-23T15:00:00.000Z'), null);
  assert.equal(codex.blockUsage('bad', '2026-07-23T15:00:00.000Z'), null);
});

test('usage refresh derives codexBlock from rollouts while preserving Claude ccusage block', (t, done) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-codex-block-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-codex-rollouts-'));
  const stub = path.join(state, 'ccusage.sh');
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "blocks" ]; then
  echo '{"blocks":[{"isActive":true,"totalTokens":9999,"costUSD":7,"startTime":"2026-07-23T10:00:00.000Z","endTime":"2026-07-23T15:00:00.000Z"}]}'
elif [ "$1" = "claude" ]; then
  echo '{"weekly":[]}'
else
  echo '{"weekly":[]}'
fi
`);
  fs.chmodSync(stub, 0o755);
  writeRollout(root, '2026-07-23', 'refresh', [
    count('2026-07-23T09:00:00.000Z', 200),
    count('2026-07-23T14:00:00.000Z', 725),
  ]);
  process.env.COCKPIT_DIR = state;
  process.env.CK_CODEX_DIR = root;
  process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = path.join(state, 'missing-plan.json');
  delete require.cache[require.resolve('../codex.js')];
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');

  usage.refresh((res) => {
    assert.equal(res.claudeBlock.totalTokens, 9999);
    assert.equal(res.claudeBlock.costUSD, 7);
    assert.deepEqual(res.codexBlock, {
      totalTokens: 525,
      startTime: '2026-07-23T10:00:00.000Z',
      endTime: '2026-07-23T15:00:00.000Z',
      source: 'codex-rollouts',
    });
    assert.equal('costUSD' in res.codexBlock, false, 'rollouts do not invent a dollar cost');
    done();
  });
});

test('a rollout whose telemetry all predates the window yields null, not a zero block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-'));
  const codex = freshCodex(root);
  writeRollout(root, '2026-07-23', 'stale', [
    count('2026-07-23T06:00:00.000Z', 300),
    count('2026-07-23T08:30:00.000Z', 500),
  ]);
  assert.equal(codex.blockUsage('2026-07-23T10:00:00.000Z', '2026-07-23T15:00:00.000Z', { root }), null);
});

test('a session started the previous day is found via the one-day lookback dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-block-'));
  const codex = freshCodex(root);
  // Rollout file lives in its session-start date dir (07-22) but emits inside the 07-23 window.
  writeRollout(root, '2026-07-22', 'longlived', [
    count('2026-07-22T20:00:00.000Z', 1000),
    count('2026-07-23T11:00:00.000Z', 1600),
  ]);
  const res = codex.blockUsage('2026-07-23T10:00:00.000Z', '2026-07-23T15:00:00.000Z', { root });
  assert.equal(res.totalTokens, 600);
});
