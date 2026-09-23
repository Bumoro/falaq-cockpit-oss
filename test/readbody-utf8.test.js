const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const readBody = vm.runInNewContext(`(${functionSource(SERVER, 'readBody')})`, { Buffer, Error, JSON });

function parseChunks(chunks, maxBytes) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    readBody(req, (body, bodyError) => resolve({ body, bodyError }), maxBytes);
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
}

test('readBody preserves Arabic and emoji split across real Buffer boundaries', async t => {
  const original = 'مرحبا بكم في فلق 🚀';
  const payload = Buffer.from(JSON.stringify({ text: original }));
  const emojiStart = payload.indexOf(Buffer.from('🚀'));
  const splitOffsets = [2, 8, 15, emojiStart + 1, emojiStart + 3];

  for (const offset of splitOffsets) {
    await t.test(`split at byte ${offset}`, async () => {
      const chunks = [payload.subarray(0, offset), payload.subarray(offset)];
      assert.ok(chunks.every(Buffer.isBuffer), 'the request emits Buffer slices');
      const { body, bodyError } = await parseChunks(chunks);
      assert.equal(bodyError, null);
      assert.deepStrictEqual(body, { text: original });
      assert.ok(Buffer.from(body.text).equals(Buffer.from(original)), 'parsed text is byte-identical');
    });
  }
});

test('readBody also accepts string chunks and treats an empty body as an object', async () => {
  const original = 'مرحبا بكم في فلق 🚀';
  const json = JSON.stringify({ text: original });
  const parsed = await parseChunks([json.slice(0, 10), json.slice(10)]);
  assert.equal(parsed.bodyError, null);
  assert.deepStrictEqual(parsed.body, { text: original });

  const empty = await parseChunks([]);
  assert.equal(empty.bodyError, null);
  assert.deepStrictEqual(empty.body, {});
});

test('readBody reports over-limit and invalid JSON errors through the second callback arg', async () => {
  const overLimit = await parseChunks([Buffer.from('{}')], 1);
  assert.equal(JSON.stringify(overLimit.body), '{}');
  assert.equal(overLimit.bodyError && overLimit.bodyError.message, 'request body is too large');

  const invalid = await parseChunks([Buffer.from('{')]);
  assert.equal(JSON.stringify(invalid.body), '{}');
  assert.equal(invalid.bodyError && invalid.bodyError.message, 'invalid JSON');
});

test('readBody retains its default limit and the upload route retains its 24 MiB override', () => {
  assert.match(SERVER, /function readBody\(req, cb, maxBytes = 1e5\)/);
  assert.match(SERVER, /}, 24 \* 1024 \* 1024\);/);
});
