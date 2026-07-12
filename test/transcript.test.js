// transcript.test.js — the "read the whole session" renderer + its read jail.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cktx-'));
  process.env.CK_PROJECTS_DIR = dir;
  delete require.cache[require.resolve('../transcript.js')];
  return { t: require('../transcript.js'), dir };
}
function writeJsonl(dir, name, rows) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, rows.map(o => JSON.stringify(o)).join('\n') + '\n');
  return f;
}

test('isAllowed jails reads to the projects dir', () => {
  const { t, dir } = fresh();
  const f = writeJsonl(dir, 't.jsonl', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(t.isAllowed(f), true);
  assert.equal(t.isAllowed('/etc/passwd'), false);
  assert.equal(t.isAllowed(path.join(os.tmpdir(), 'not-in-jail.jsonl')), false);
  assert.equal(t.isAllowed(''), false);
  assert.equal(t.isAllowed(null), false);
});

test('a symlink inside the jail pointing outside is refused (realpath escape)', () => {
  const { t, dir } = fresh();
  const outside = path.join(os.tmpdir(), 'ck-outside-' + Date.now() + '.txt');
  fs.writeFileSync(outside, 'SECRET');
  const link = path.join(dir, 'escape.jsonl');
  fs.symlinkSync(outside, link);                 // symlink lives in the jail, target does not
  assert.equal(t.isAllowed(link), false);
  assert.equal(t.readTranscript(link), '');      // and the read never leaks the target
});

test('renders user prompts, assistant text and tool calls; drops thinking/tool_result/noise', () => {
  const { t, dir } = fresh();
  const f = writeJsonl(dir, 's.jsonl', [
    { type: 'mode', message: {} },                                            // bookkeeping noise
    { type: 'ai-title', message: {} },                                        // bookkeeping noise
    { type: 'user', timestamp: '2026-07-09T15:00:00Z', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', timestamp: '2026-07-09T15:00:05Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'SECRET internal reasoning' },
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'HUGEOUTPUT'.repeat(9999) }] } },
  ]);
  const out = t.readTranscript(f);
  assert.match(out, /❯ you: do the thing/);
  assert.match(out, /● claude: On it\./);
  assert.match(out, /⛭ Bash/);
  assert.match(out, /ls -la/);
  assert.doesNotMatch(out, /SECRET internal reasoning/); // thinking dropped
  assert.doesNotMatch(out, /HUGEOUTPUT/);                // tool_result dropped
});

test('returns empty for a path outside the jail and for a missing file', () => {
  const { t } = fresh();
  assert.equal(t.readTranscript('/etc/hosts'), '');
  assert.equal(t.readTranscript(path.join(os.tmpdir(), 'ghost-' + Date.now() + '.jsonl')), '');
});

test('bounds the READ of a huge transcript to a tail window (never slurps the whole file)', () => {
  const { t, dir } = fresh();
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ type: 'user', message: { role: 'user', content: 'ROW' + i + ' '.repeat(200) } });
  const f = writeJsonl(dir, 'huge.jsonl', rows);
  assert.ok(fs.statSync(f).size > 4096, 'file exceeds the read cap');
  const out = t.readTranscript(f, { readCap: 4096 });   // force the tail-read path
  assert.match(out, /earlier session truncated/);         // truncation is disclosed
  assert.match(out, /ROW1999\b/);                          // newest content is present
  assert.doesNotMatch(out, /ROW0\b/);                      // earliest content was never read
});

test('caps very large transcripts and keeps the tail', () => {
  const { t, dir } = fresh();
  const many = [];
  for (let i = 0; i < 5000; i++) many.push({ type: 'user', message: { role: 'user', content: 'line ' + i } });
  const f = writeJsonl(dir, 'big.jsonl', many);
  const out = t.readTranscript(f, { maxTurns: 100 });
  assert.match(out, /earlier lines truncated/);
  assert.match(out, /line 4999/);                        // the tail is kept
  assert.ok(out.split('\n').length < 500);
});
