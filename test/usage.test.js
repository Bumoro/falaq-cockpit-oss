// ~/.claude/agent-dashboard/test/usage.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function stubEnv(planSample) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const stub = path.join(dir, 'ccusage-stub.sh');
  // Active blocks have no per-model split. Claude weekly is Claude-only; top-level weekly is blended.
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "blocks" ]; then
  echo '{"blocks":[{"isActive":true,"totalTokens":7368406,"costUSD":6.47,"startTime":"2026-07-08T10:00:00.000Z","endTime":"2026-07-08T15:00:00.000Z","projection":{"remainingMinutes":285},"burnRate":{"tokensPerMinute":50000},"models":["claude-opus-4-8","gpt-5.6-sol"],"tokenCounts":{"inputTokens":1000,"outputTokens":200}}]}'
elif [ "$1" = "claude" ] && [ "$2" = "weekly" ]; then
  echo '{"weekly":[{"week":"2026-07-06","totalTokens":358543858,"totalCost":180.5,"modelBreakdowns":[{"modelName":"claude-opus-4-8","inputTokens":100,"outputTokens":20,"cacheCreationTokens":40,"cacheReadTokens":50,"cost":1.25}]}]}'
elif [ "$1" = "weekly" ]; then
  echo '{"weekly":[{"week":"2026-07-06","totalTokens":358544158,"totalCost":180.92,"modelBreakdowns":[{"modelName":"claude-opus-4-8","inputTokens":100,"outputTokens":20,"cacheCreationTokens":40,"cacheReadTokens":50,"cost":1.25},{"modelName":"gpt-5.6-sol","inputTokens":210,"outputTokens":30,"cacheReadTokens":60,"cost":0.42}]}]}'
fi
`);
  fs.chmodSync(stub, 0o755);
  const planFile = path.join(dir, 'plan-usage-history.json');
  if (planSample) fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [planSample] }));
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = planFile;
  delete require.cache[require.resolve('../usage.js')];
  return { usage: require('../usage.js'), dir, planFile };
}

test('refresh gets Claude week from claude weekly and Codex week from blended weekly', (t, done) => {
  const sample = { t: Date.now() - 1000, org: 'org-1', u: { fh: 42, sd: 89, xu: 3 } };
  const { usage, dir } = stubEnv(sample);
  assert.equal(usage.readCache(), null); // nothing yet
  usage.refresh((res) => {
    assert.equal(res.block.totalTokens, 7368406);
    assert.equal(res.block.projection.remainingMinutes, 285);
    assert.equal(res.claudeBlock.totalTokens, 7368406);
    assert.equal(res.codexBlock, null);
    assert.equal(res.week.totalTokens, 358543858);
    assert.deepEqual(res.week.modelBreakdowns.map(b => b.modelName), ['claude-opus-4-8']);
    assert.deepEqual(res.codexWeek, {
      totalTokens: 300,
      totalCost: 0.42,
      costUSD: 0.42,
      modelBreakdowns: [{ modelName: 'gpt-5.6-sol', inputTokens: 210, outputTokens: 30, cacheReadTokens: 60, cost: 0.42 }],
    });
    assert.equal(res.planUsage.weeklyPct, 89);
    const cached = usage.readCache();
    assert.equal(cached.block.costUSD, 6.47);
    assert.equal(cached.planUsage.fiveHourPct, 42);
    assert.ok(cached.generatedAt > 0);
    assert.ok(fs.existsSync(path.join(dir, 'usage-cache.json')));
    done();
  });
});

test('codexUsage filters only gpt-5.6-sol tokens and cost without changing the Claude week', () => {
  const week = {
    week: '2026-07-13',
    totalTokens: 9999,
    totalCost: 99,
    modelBreakdowns: [
      { modelName: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 100, cost: 9 },
      { modelName: 'gpt-5.6-sol', inputTokens: 200, outputTokens: 30, cacheCreationTokens: 40, cacheReadTokens: 50, cost: 1.75 },
      { modelName: 'gpt-5.6-sol', totalTokens: 25, totalCost: 0.25 },
    ],
  };
  const before = structuredClone(week);
  const got = um.codexUsage(week);
  assert.equal(got.totalTokens, 345);
  assert.equal(got.totalCost, 2);
  assert.equal(got.costUSD, 2);
  assert.equal(got.modelBreakdowns.length, 2);
  assert.deepEqual(week, before, 'filter does not mutate the source row used by Claude');
});

test('codexUsage returns null when the row has no exact gpt-5.6-sol breakdown', () => {
  assert.equal(um.codexUsage(null), null);
  assert.equal(um.codexUsage({ modelBreakdowns: [{ modelName: 'claude-sonnet-5', totalTokens: 10, cost: 1 }] }), null);
  assert.equal(um.codexUsage({ modelBreakdowns: [{ modelName: 'gpt-5.6-sol-preview', totalTokens: 10, cost: 1 }] }), null);
});

test('refresh tolerates a failing ccusage (null block, no throw)', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const stub = path.join(dir, 'bad.sh');
  fs.writeFileSync(stub, "#!/bin/bash\nexit 3\n"); fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir; process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  usage.refresh((res) => {
    assert.equal(res.block, null);
    assert.equal(res.week, null);
    done();
  });
});

test('refresh contains a missing ccusage binary spawn error', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-missing-'));
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = path.join(dir, 'not-installed');
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  usage.refresh((res) => {
    assert.equal(res.block, null);
    assert.equal(res.week, null);
    assert.ok(fs.existsSync(path.join(dir, 'usage-cache.json')), 'empty cache is written once without crashing');
    done();
  });
});

test('readPlanUsage maps the last well-formed sample and finite optional fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-plan-'));
  const planFile = path.join(dir, 'plan.json');
  const now = Date.now();
  fs.writeFileSync(planFile, JSON.stringify({
    version: 2,
    samples: [
      { t: now - 5000, org: 'old', u: { fh: 1, sd: 2, xu: 3 } },
      { t: now - 1000, org: 'org-latest', u: { fh: 45, sd: 89, xu: 7 } },
    ],
  }));
  process.env.CK_PLAN_USAGE_FILE = planFile;
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  const result = usage.readPlanUsage();
  assert.equal(result.weeklyPct, 89);
  assert.equal(result.fiveHourPct, 45);
  assert.equal(result.overagePct, 7);
  assert.equal(result.asOf, now - 1000);
  assert.equal(result.org, 'org-latest');
  assert.ok(result.ageMs >= 0);
});

test('readPlanUsage returns null for missing, empty, malformed, or non-numeric weekly data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-plan-bad-'));
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  assert.equal(usage.readPlanUsage(), null);

  const cases = [
    ['empty samples', { version: 2, samples: [] }],
    ['malformed JSON', '{broken'],
    ['non-numeric sd', { version: 2, samples: [{ t: Date.now(), u: { sd: '89' } }] }],
  ];
  for (const [name, value] of cases) {
    await t.test(name, () => {
      fs.writeFileSync(process.env.CK_PLAN_USAGE_FILE, typeof value === 'string' ? value : JSON.stringify(value));
      assert.equal(usage.readPlanUsage(), null);
    });
  }
});

test('refreshPreserving keeps prior plan usage when the latest local read misses', (t, done) => {
  const { usage, dir } = stubEnv();
  const prior = { weeklyPct: 77, fiveHourPct: 31, asOf: Date.now() - 2000, ageMs: 2000, org: 'org-prior' };
  fs.writeFileSync(path.join(dir, 'usage-cache.json'), JSON.stringify({
    generatedAt: Date.now() - 5000,
    block: { totalTokens: 1 },
    week: { totalTokens: 2 },
    planUsage: prior,
  }));
  usage.refreshPreserving((res) => {
    assert.deepEqual(res.planUsage, prior);
    assert.deepEqual(usage.readCache().planUsage, prior);
    done();
  });
});

test('refreshPreserving keeps provider-specific usage when ccusage fails', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-preserve-provider-'));
  const stub = path.join(dir, 'bad.sh');
  fs.writeFileSync(stub, '#!/bin/bash\nexit 3\n');
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = stub;
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  const prior = {
    generatedAt: Date.now() - 5000,
    block: { totalTokens: 100 },
    week: { totalTokens: 1000 },
    codexBlock: { totalTokens: 30, totalCost: 0.3 },
    claudeBlock: { totalTokens: 70, totalCost: 0.7 },
    codexWeek: { totalTokens: 300, totalCost: 3 },
  };
  fs.writeFileSync(path.join(dir, 'usage-cache.json'), JSON.stringify(prior));
  usage.refreshPreserving((res) => {
    assert.deepEqual(res.codexBlock, prior.codexBlock);
    assert.deepEqual(res.claudeBlock, prior.claudeBlock);
    assert.deepEqual(res.codexWeek, prior.codexWeek);
    done();
  });
});

test('readWeeklyCap reads a positive configured number and otherwise returns null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cap-'));
  process.env.COCKPIT_DIR = dir;
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'missing-plan.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ usage: { weeklyTokenCap: 400000000 } }));
  assert.equal(usage.readWeeklyCap(), 400000000);
  for (const value of [null, 0, -1, '400000000']) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ usage: { weeklyTokenCap: value } }));
    assert.equal(usage.readWeeklyCap(), null);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), '{bad');
  assert.equal(usage.readWeeklyCap(), null);
});

// weekTileMode is pure (takes the cache object directly, no file reads) — require it plainly.
const um = require('../usage.js');
// Local-time timestamps (no 'Z') so they line up with weekTileMode's local-midnight week parsing → tz-robust.
const T = (s) => new Date(s).getTime();

test('weekTileMode: a within-week sample >24h old still shows the REAL % (the w.period→w.week regression guard)', () => {
  const now = T('2026-07-15T10:00:00');            // Wed
  const asOf = T('2026-07-13T08:00:00');           // Mon, ~50h old but inside the Sun 2026-07-12 week
  const wt = um.weekTileMode({ week: { week: '2026-07-12', totalTokens: 100 }, planUsage: { weeklyPct: 40, asOf } }, now);
  assert.equal(wt.mode, 'real');
  assert.equal(wt.pct, 40);
  assert.equal(wt.stale, true);                    // >6h → flagged stale, still shown
});
test('weekTileMode: a PRIOR-week sample is rejected even with a high %, never shown as this week', () => {
  const now = T('2026-07-13T12:00:00');
  const asOf = T('2026-07-10T12:00:00');           // Fri, before the Sun 2026-07-12 week start
  const wt = um.weekTileMode({ week: { week: '2026-07-12', totalTokens: 100 }, planUsage: { weeklyPct: 95, asOf } }, now);
  assert.notEqual(wt.mode, 'real');
  assert.equal(wt.mode, 'volume');                 // no cap configured → volume, not last week's 95%
});
test('weekTileMode: no in-week sample + configured cap → estimate', () => {
  const wt = um.weekTileMode({ week: { week: '2026-07-12', totalTokens: 200000000 }, weeklyTokenCap: 400000000, planUsage: null }, T('2026-07-15T10:00:00'));
  assert.equal(wt.mode, 'est');
  assert.equal(wt.pct, 50);
});
test('weekTileMode: no sample + no cap → volume only', () => {
  const wt = um.weekTileMode({ week: { week: '2026-07-12', totalTokens: 12345 }, planUsage: null, weeklyTokenCap: null }, T('2026-07-15T10:00:00'));
  assert.equal(wt.mode, 'volume');
});
test('weekTileMode: an unparseable week label falls back to the 24h age window (NaN guard, not silent-off)', () => {
  const now = T('2026-07-15T10:00:00');
  const wt = um.weekTileMode({ week: { week: 'not-a-date', totalTokens: 100 }, planUsage: { weeklyPct: 33, asOf: now - 1000 } }, now);
  assert.equal(wt.mode, 'real');                   // fresh sample still shows despite the bad label
  assert.equal(wt.pct, 33);
});
test('weekTileMode: a sample with no timestamp cannot be proven in-week → not real', () => {
  const wt = um.weekTileMode({ week: { week: '2026-07-12', totalTokens: 100 }, planUsage: { weeklyPct: 50 } }, T('2026-07-15T10:00:00'));
  assert.equal(wt.mode, 'volume');
});

test('weeklyFraming computes runway from average daily burn and caps it at reset', () => {
  const now = T('2026-07-14T00:00:00'); // two days into the week
  assert.equal(
    um.weeklyFraming({ week: { week: '2026-07-12', totalTokens: 250 }, weeklyTokenCap: 1000 }, now),
    '≈5 days of weekly limit left at the current pace', // pace says six days; reset is in five
  );
  assert.equal(
    um.weeklyFraming({ week: { week: '2026-07-12', totalTokens: 500 }, weeklyTokenCap: 1000 }, T('2026-07-15T00:00:00')),
    '≈3 days of weekly limit left at the current pace',
  );
});

test('weeklyFraming supports real plan usage and omits unknowable framing', () => {
  const now = T('2026-07-15T00:00:00');
  assert.equal(
    um.weeklyFraming({ week: { week: '2026-07-12' }, planUsage: { weeklyPct: 75, asOf: now } }, now),
    '≈1 day of weekly limit left at the current pace',
  );
  assert.equal(um.weeklyFraming({ week: { week: '2026-07-12', totalTokens: 10 } }, now), null, 'volume mode');
  assert.equal(um.weeklyFraming({ week: { week: '2026-07-12', totalTokens: 0 }, weeklyTokenCap: 1000 }, now), null, 'zero burn');
  assert.equal(um.weeklyFraming({ week: { week: 'not-a-date', totalTokens: 50 }, weeklyTokenCap: 100 }, now), null, 'bad week');
});

test('readPlanUsage: omits optional fields when absent/non-numeric, and null on a missing u / null sample', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-plan-edge-'));
  process.env.CK_PLAN_USAGE_FILE = path.join(dir, 'plan.json');
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  const write = (v) => fs.writeFileSync(process.env.CK_PLAN_USAGE_FILE, JSON.stringify(v));

  write({ version: 2, samples: [{ u: { sd: 55 } }] });          // sd only, no t/fh/xu
  let r = usage.readPlanUsage();
  assert.equal(r.weeklyPct, 55);
  assert.equal(r.asOf, undefined);
  assert.equal(r.ageMs, undefined);
  assert.equal(r.fiveHourPct, undefined);

  write({ version: 2, samples: [{ t: Date.now(), u: { sd: 60, fh: 'x' } }] }); // fh non-numeric → omitted
  r = usage.readPlanUsage();
  assert.equal(r.weeklyPct, 60);
  assert.equal(r.fiveHourPct, undefined);

  write({ version: 2, samples: [{ t: Date.now() }] });          // missing u → null
  assert.equal(usage.readPlanUsage(), null);
  write({ version: 2, samples: [null] });                       // null sample → null
  assert.equal(usage.readPlanUsage(), null);
});

test('weeklyProjection computes token cap, percentage, and exhaustion weekday', () => {
  const now = T('2026-07-15T00:00:00'); // Wednesday, three days into a Sunday bucket
  const got = um.weeklyProjection({ week: { week: '2026-07-12', totalTokens: 300 }, weeklyTokenCap: 600 }, now);
  assert.equal(got.tokens, 300);
  assert.equal(got.cap, 600);
  assert.equal(got.pct, 50);
  assert.equal(got.exhaustionDay, 'Saturday');
});

test('weeklyProjection can infer the limit from an in-week plan percentage and rejects missing data', () => {
  const now = T('2026-07-15T00:00:00');
  const got = um.weeklyProjection({ week: { week: '2026-07-12', totalTokens: 250 }, planUsage: { weeklyPct: 25, asOf: now } }, now);
  assert.equal(got.cap, 1000);
  assert.equal(got.pct, 25);
  assert.equal(um.weeklyProjection({ week: null }, now), null);
});

test('weeklyProjection reports limit reached once tokens meet or exceed the cap', () => {
  const now = T('2026-07-15T00:00:00');
  for (const totalTokens of [600, 700]) {
    const got = um.weeklyProjection({ week: { week: '2026-07-12', totalTokens }, weeklyTokenCap: 600 }, now);
    assert.equal(got.withinLimit, false);
    assert.equal(got.exhaustionDay, 'limit reached');
  }
});
