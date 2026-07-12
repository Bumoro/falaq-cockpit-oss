// ~/.claude/agent-dashboard/test/usage.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function stubEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const stub = path.join(dir, 'ccusage-stub.sh');
  // arg 1 is the subcommand: 'blocks' -> block json, 'weekly' -> week json
  fs.writeFileSync(stub, `#!/bin/bash
if [ "$1" = "blocks" ]; then
  echo '{"blocks":[{"isActive":true,"totalTokens":7368406,"costUSD":6.47,"startTime":"2026-07-08T10:00:00.000Z","endTime":"2026-07-08T15:00:00.000Z","projection":{"remainingMinutes":285},"burnRate":{"tokensPerMinute":50000}}]}'
elif [ "$1" = "weekly" ]; then
  echo '{"weekly":[{"week":"2026-07-06","totalTokens":358543858,"totalCost":180.5}]}'
fi
`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_CCUSAGE_CMD = stub;
  delete require.cache[require.resolve('../usage.js')];
  return { usage: require('../usage.js'), dir };
}

test('refresh spawns ccusage and writes parsed cache; readCache returns it', (t, done) => {
  const { usage, dir } = stubEnv();
  assert.equal(usage.readCache(), null); // nothing yet
  usage.refresh((res) => {
    assert.equal(res.block.totalTokens, 7368406);
    assert.equal(res.block.projection.remainingMinutes, 285);
    assert.equal(res.week.totalTokens, 358543858);
    const cached = usage.readCache();
    assert.equal(cached.block.costUSD, 6.47);
    assert.ok(cached.generatedAt > 0);
    assert.ok(fs.existsSync(path.join(dir, 'usage-cache.json')));
    done();
  });
});

test('refresh tolerates a failing ccusage (null block, no throw)', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const stub = path.join(dir, 'bad.sh');
  fs.writeFileSync(stub, "#!/bin/bash\nexit 3\n"); fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir; process.env.CK_CCUSAGE_CMD = stub;
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
  delete require.cache[require.resolve('../usage.js')];
  const usage = require('../usage.js');
  usage.refresh((res) => {
    assert.equal(res.block, null);
    assert.equal(res.week, null);
    assert.ok(fs.existsSync(path.join(dir, 'usage-cache.json')), 'empty cache is written once without crashing');
    done();
  });
});
