const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { contextForTranscript, limitFor, usedFraction, usableLimitFor } = require('../context.js');

function fixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.map(o => JSON.stringify(o)).join('\n'));
  return f;
}

function usage(input, cacheRead, cacheCreation, model) {
  return {
    message: {
      role: 'assistant',
      model: model || 'claude-opus-4-8',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  };
}

function oldFullReadContext(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    const model = (o.message && o.message.model) || o.model || null;
    if (model === '<synthetic>') continue;
    const u = o.message && o.message.usage;
    if (!u || (u.input_tokens == null && u.cache_read_input_tokens == null)) continue;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!tokens) return null;
    const limit = limitFor(model);
    return { tokens, limit, usableLimit: usableLimitFor(limit), pct: usedFraction(tokens, limit), model };
  }
  return null;
}

test('limitFor: 1M default, 200k for haiku', () => {
  assert.equal(limitFor('claude-fable-5'), 1000000);
  assert.equal(limitFor('claude-opus-4-8'), 1000000);
  assert.equal(limitFor('claude-haiku-4-5'), 200000);
  assert.equal(limitFor(null), 1000000);
});

// pct is normalized to the USABLE window (full - 16.5% auto-compact buffer) so it matches
// exactly what Claude Code's gsd-statusline shows the user. A raw tokens/window ratio
// under-reports and the gap widens as context fills (the "context% lags reality" bug).
test('usedFraction matches gsd-statusline normalization (1M window, default buffer)', () => {
  assert.equal(Math.round(usedFraction(309953, 1000000) * 100), 37); // raw 31% -> 37%
  assert.equal(Math.round(usedFraction(516634, 1000000) * 100), 62); // raw 52% -> 62%
  assert.equal(Math.round(usedFraction(800000, 1000000) * 100), 96); // raw 80% -> 96%
  assert.equal(Math.round(usedFraction(50000, 1000000) * 100), 6);   // raw 5%  -> 6%
});

test('usedFraction clamps to 1.0 at/after the auto-compact point', () => {
  assert.equal(usedFraction(900000, 1000000), 1); // raw 90% is past usable -> 100%
  assert.equal(usedFraction(1000000, 1000000), 1);
});

test('usableLimitFor: full window minus the default 16.5% buffer', () => {
  assert.equal(usableLimitFor(1000000), 835000);
  assert.equal(usableLimitFor(200000), 167000);
});

test('CLAUDE_CODE_AUTO_COMPACT_WINDOW overrides the buffer', () => {
  const prev = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000'; // 50% buffer on a 1M window
  try {
    assert.equal(usableLimitFor(1000000), 500000);
    // raw 30% used, buffer 50% -> usableRemaining=((70-50)/50)*100=40 -> used=60
    assert.equal(Math.round(usedFraction(300000, 1000000) * 100), 60);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prev;
  }
});

test('reads last real assistant usage as current context (input side only, normalized pct)', () => {
  const f = fixture([
    { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 50 } } },
    { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 308817, cache_creation_input_tokens: 1134, output_tokens: 818 } } },
  ]);
  const c = contextForTranscript(f);
  assert.equal(c.tokens, 2 + 308817 + 1134); // last message wins, input side only (no output_tokens)
  assert.equal(c.limit, 1000000);
  assert.equal(c.usableLimit, 835000);
  assert.equal(Math.round(c.pct * 100), 37); // normalized to usable window, matches statusline
  assert.equal(c.model, 'claude-opus-4-8');
});

test('skips <synthetic> assistant turns (matches Claude Code current-context counter)', () => {
  const f = fixture([
    { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0, output_tokens: 10 } } },
    { message: { role: 'assistant', model: '<synthetic>', usage: { input_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  ]);
  const c = contextForTranscript(f);
  assert.equal(c.tokens, 2 + 500000); // synthetic tail skipped, real line used
  assert.equal(c.model, 'claude-opus-4-8');
});

test('haiku uses 200k window', () => {
  const f = fixture([{ message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]);
  const c = contextForTranscript(f);
  assert.equal(c.limit, 200000);
  assert.equal(c.usableLimit, 167000);
  assert.equal(Math.round(c.pct * 100), 60); // raw 50% -> statusline 60%
});

test('missing/empty/garbled transcript -> null', () => {
  assert.equal(contextForTranscript('/no/such/file'), null);
  const empty = fixture([]);
  assert.equal(contextForTranscript(empty), null);
  const noUsage = fixture([{ message: { role: 'user' } }, { type: 'summary' }]);
  assert.equal(contextForTranscript(noUsage), null);
});

test('rejects string usage fields instead of returning string tokens', () => {
  const f = fixture([{
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: '123', cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }]);
  assert.equal(contextForTranscript(f), null);
});

test('large tail-read returns the same context as the old full-read implementation', () => {
  const filler = Array.from({ length: 400 }, (_, i) => ({ type: 'progress', i, data: 'x'.repeat(1024) }));
  const f = fixture([...filler, usage(3, 345678, 9012), { type: 'summary' }]);
  assert.ok(fs.statSync(f).size > 256 * 1024);
  assert.deepEqual(contextForTranscript(f), oldFullReadContext(f));
});

test('unchanged transcript is not read again', () => {
  const f = fixture([usage(4, 5000, 60)]);
  const readFileSync = fs.readFileSync;
  const readSync = fs.readSync;
  let reads = 0;
  fs.readFileSync = function () { reads++; return readFileSync.apply(this, arguments); };
  fs.readSync = function () { reads++; return readSync.apply(this, arguments); };
  try {
    const first = contextForTranscript(f);
    const afterFirst = reads;
    assert.ok(afterFirst > 0, 'first call reads transcript bytes');
    assert.strictEqual(contextForTranscript(f), first);
    assert.equal(reads, afterFirst, 'memo hit performs only the identity stat');
  } finally {
    fs.readFileSync = readFileSync;
    fs.readSync = readSync;
  }
});

test('falls back once when the only usage record is older than the tail window', () => {
  const filler = Array.from({ length: 400 }, (_, i) => ({ type: 'progress', i, data: 'y'.repeat(1024) }));
  const f = fixture([usage(5, 222222, 3333), ...filler]);
  assert.ok(fs.statSync(f).size > 256 * 1024);
  const expected = oldFullReadContext(f);
  assert.ok(expected);
  assert.deepEqual(contextForTranscript(f), expected);
});

test('tail read discards a partial first JSON line and parses later usage', () => {
  const f = fixture([
    { type: 'progress', data: 'z'.repeat(300 * 1024) },
    usage(6, 123456, 789),
  ]);
  assert.ok(fs.statSync(f).size > 256 * 1024);
  const context = contextForTranscript(f);
  assert.equal(context.tokens, 6 + 123456 + 789);
  assert.equal(context.model, 'claude-opus-4-8');
});
