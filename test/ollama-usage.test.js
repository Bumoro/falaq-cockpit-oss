const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function forbiddenMoneyKey(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('$') || /cost/i.test(key)) return key;
    const nested = forbiddenMoneyKey(child);
    if (nested) return nested;
  }
  return null;
}

function setup(outputs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-usage-'));
  const stub = path.join(dir, 'ccusage.sh');
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "blocks" ]; then
  echo '${JSON.stringify({ blocks: [outputs.block] })}'
elif [ "$1" = "claude" ]; then
  echo '${JSON.stringify({ weekly: [outputs.week] })}'
else
  echo '{"weekly":[]}'
fi
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  process.env.CK_CODEX_DIR = path.join(dir, 'codex-sessions');
  delete require.cache[require.resolve('../usage.js')];
  return { dir, usage: require('../usage.js') };
}

function refresh(usage) {
  return new Promise(resolve => usage.refresh(resolve));
}

test('refresh sums Ollama ledger tokens in the active Claude block and current week', async () => {
  const now = Date.now();
  const blockStart = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const blockEnd = new Date(now + 3 * 60 * 60 * 1000).toISOString();
  const weekStart = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const weekLabel = [
    weekStart.getFullYear(),
    String(weekStart.getMonth() + 1).padStart(2, '0'),
    String(weekStart.getDate()).padStart(2, '0'),
  ].join('-');
  const { dir, usage } = setup({
    block: { isActive: true, startTime: blockStart, endTime: blockEnd, totalTokens: 1 },
    week: { week: weekLabel, totalTokens: 1 },
  });
  const entries = [
    { ts: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), model: 'old-week', prompt: 100, eval: 1 },
    { ts: new Date(now - 3 * 60 * 60 * 1000).toISOString(), model: 'week-only', prompt: 20, eval: 3 },
    { ts: new Date(now - 60 * 60 * 1000).toISOString(), model: 'in-block', prompt: 11, eval: 7 },
    { ts: new Date(now - 10 * 60 * 1000).toISOString(), model: 'in-block-2', prompt: 5, eval: 2 },
    { ts: new Date(now + 4 * 60 * 60 * 1000).toISOString(), model: 'future', prompt: 999, eval: 999 },
    { ts: new Date(now - 30 * 60 * 1000).toISOString(), model: 'bad', prompt: '9', eval: 1 },
  ];
  fs.writeFileSync(path.join(dir, 'ollama-usage.jsonl'),
    entries.map(entry => JSON.stringify(entry)).join('\n') + '\n{broken\n');

  const result = await refresh(usage);
  assert.deepEqual(result.ollamaBlock, {
    totalTokens: 25,
    startTime: blockStart,
    endTime: blockEnd,
  });
  assert.deepEqual(result.ollamaWeek, { totalTokens: 48 });
  assert.equal(forbiddenMoneyKey({ ollamaBlock: result.ollamaBlock, ollamaWeek: result.ollamaWeek }), null);
  assert.deepEqual(usage.readCache().ollamaWeek, { totalTokens: 48 });
});

test('refresh prunes ledger entries older than eight days', async () => {
  const now = Date.now();
  const blockStart = new Date(now - 60 * 60 * 1000).toISOString();
  const blockEnd = new Date(now + 4 * 60 * 60 * 1000).toISOString();
  const today = new Date(now);
  const label = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  const { dir, usage } = setup({
    block: { isActive: true, startTime: blockStart, endTime: blockEnd },
    week: { week: label, totalTokens: 1 },
  });
  const old = { ts: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(), model: 'old', prompt: 100, eval: 10 };
  const fresh = { ts: new Date(now - 10 * 60 * 1000).toISOString(), model: 'fresh', prompt: 4, eval: 2 };
  fs.writeFileSync(path.join(dir, 'ollama-usage.jsonl'),
    `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);

  await refresh(usage);
  const retained = fs.readFileSync(path.join(dir, 'ollama-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(retained, [fresh]);
});

test('refreshPreserving keeps Ollama provider usage when ccusage windows fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-usage-preserve-'));
  const stub = path.join(dir, 'bad.sh');
  fs.writeFileSync(stub, '#!/bin/bash\nexit 3\n');
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  process.env.CK_CODEX_DIR = path.join(dir, 'codex-sessions');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  const prior = {
    generatedAt: Date.now() - 1000,
    block: { startTime: '2026-07-23T10:00:00.000Z', endTime: '2026-07-23T15:00:00.000Z' },
    week: { week: '2026-07-20', totalTokens: 1 },
    ollamaBlock: { totalTokens: 13, startTime: '2026-07-23T10:00:00.000Z', endTime: '2026-07-23T15:00:00.000Z' },
    ollamaWeek: { totalTokens: 34 },
  };
  fs.writeFileSync(path.join(dir, 'usage-cache.json'), JSON.stringify(prior));

  const result = await new Promise(resolve => usage.refreshPreserving(resolve));
  assert.deepEqual(result.ollamaBlock, prior.ollamaBlock);
  assert.deepEqual(result.ollamaWeek, prior.ollamaWeek);
  assert.equal(forbiddenMoneyKey({ ollamaBlock: result.ollamaBlock, ollamaWeek: result.ollamaWeek }), null);
});
