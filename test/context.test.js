const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { contextForTranscript, limitFor } = require('../context.js');

function fixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.map(o => JSON.stringify(o)).join('\n'));
  return f;
}

test('limitFor: 1M default, 200k for haiku', () => {
  assert.equal(limitFor('claude-fable-5'), 1000000);
  assert.equal(limitFor('claude-opus-4-8'), 1000000);
  assert.equal(limitFor('claude-haiku-4-5'), 200000);
  assert.equal(limitFor(null), 1000000);
});

test('reads last assistant usage as current context', () => {
  const f = fixture([
    { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 50 } } },
    { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 2, cache_read_input_tokens: 308817, cache_creation_input_tokens: 1134, output_tokens: 818 } } },
  ]);
  const c = contextForTranscript(f);
  assert.equal(c.tokens, 2 + 308817 + 1134); // last message wins, input side only
  assert.equal(c.limit, 1000000);
  assert.ok(Math.abs(c.pct - 0.30995) < 0.001);
  assert.equal(c.model, 'claude-opus-4-8');
});

test('haiku uses 200k limit', () => {
  const f = fixture([{ message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }]);
  assert.equal(contextForTranscript(f).limit, 200000);
  assert.equal(contextForTranscript(f).pct, 0.5);
});

test('missing/empty/garbled transcript -> null', () => {
  assert.equal(contextForTranscript('/no/such/file'), null);
  const empty = fixture([]);
  assert.equal(contextForTranscript(empty), null);
  const noUsage = fixture([{ message: { role: 'user' } }, { type: 'summary' }]);
  assert.equal(contextForTranscript(noUsage), null);
});
