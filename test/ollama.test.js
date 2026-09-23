const { test } = require('node:test');
const assert = require('node:assert');

function fresh() {
  delete require.cache[require.resolve('../providers/ollama.js')];
  return require('../providers/ollama.js');
}

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function forbiddenMoneyKey(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes('$') || /cost/i.test(key)) return key;
    const nested = forbiddenMoneyKey(child);
    if (nested) return nested;
  }
  return null;
}

test('activeSessions returns one tokens-only card per loaded model', async () => {
  const ollama = fresh();
  const calls = [];
  const sessions = await ollama.activeSessions({
    now: 1784800000000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ models: [
        { name: 'qwen2.5-coder:32b', expires_at: '2026-07-23T10:00:00Z', context_length: 32768 },
        { name: 'qwen2.5-coder:7b', context_length: 16384 },
      ] });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/ps');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(sessions, [
    {
      id: 'ollama:qwen2.5-coder:32b',
      cwd: '',
      client: 'Ollama',
      lastActivity: 1784800000000,
      context: {
        tokens: null,
        limit: 32768,
        pct: null,
        model: 'qwen2.5-coder:32b',
      },
      provider: 'ollama',
      generating: false,
    },
    {
      id: 'ollama:qwen2.5-coder:7b',
      cwd: '',
      client: 'Ollama',
      lastActivity: 1784800000000,
      context: {
        tokens: null,
        limit: 16384,
        pct: null,
        model: 'qwen2.5-coder:7b',
      },
      provider: 'ollama',
      generating: false,
    },
  ]);
  assert.equal(forbiddenMoneyKey(sessions), null);
});

test('activeSessions keeps unknown occupancy honest and tolerates malformed models', async () => {
  const ollama = fresh();
  const sessions = await ollama.activeSessions({
    fetch: async () => response({ models: [
      null,
      {},
      { name: '' },
      { name: 'gemma3:latest', context_length: 'not-a-number' },
    ] }),
  });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].context, {
    tokens: null,
    limit: null,
    pct: null,
    model: 'gemma3:latest',
  });
  assert.equal(forbiddenMoneyKey(sessions), null);
});

test('activeSessions fills mediated context occupancy for the matching loaded model', async () => {
  const ollama = fresh();
  const sessions = await ollama.activeSessions({
    fetch: async () => response({ models: [
      { name: 'qwen2.5-coder:7b', context_length: 16384 },
      { name: 'gemma3:latest', context_length: 8192 },
    ] }),
    contextFor: model => model === 'qwen2.5-coder:7b' ? { tokens: 4096 } : null,
  });
  assert.deepEqual(sessions[0].context, {
    tokens: 4096,
    limit: 16384,
    pct: 0.25,
    model: 'qwen2.5-coder:7b',
  });
  assert.deepEqual(sessions[1].context, {
    tokens: null,
    limit: 8192,
    pct: null,
    model: 'gemma3:latest',
  });
  assert.equal(forbiddenMoneyKey(sessions), null);
});

test('activeSessions returns an empty list for daemon errors and malformed responses', async () => {
  const ollama = fresh();
  assert.deepEqual(await ollama.activeSessions({
    fetch: async () => { throw new Error('connection refused'); },
  }), []);
  assert.deepEqual(await ollama.activeSessions({
    fetch: async () => response({ nope: true }),
  }), []);
  assert.deepEqual(await ollama.activeSessions({
    fetch: async () => response({}, false),
  }), []);
});

test('activeSessions times out promptly even when fetch ignores AbortSignal', async () => {
  const ollama = fresh();
  const started = Date.now();
  const sessions = await ollama.activeSessions({
    timeoutMs: 20,
    fetch: async () => new Promise(() => {}),
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(sessions, []);
  assert.ok(elapsed < 300, `timeout took ${elapsed}ms`);
});

test('listModels reads tags, deduplicates names, and has an isolated static fallback', async () => {
  const ollama = fresh();
  const live = await ollama.listModels({
    fetch: async url => {
      assert.match(url, /\/api\/tags$/);
      return response({ models: [
        { name: 'qwen2.5-coder:32b' },
        { name: 'qwen2.5-coder:32b' },
        { name: 'llama3.2:latest' },
        null,
      ] });
    },
  });
  assert.deepEqual(live, ['qwen2.5-coder:32b', 'llama3.2:latest']);
  assert.equal(forbiddenMoneyKey(live), null);

  const fallback = await ollama.listModels({
    fetch: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(fallback, ['qwen2.5-coder:32b', 'qwen2.5-coder:7b']);
  fallback.push('mutation-does-not-leak');
  assert.deepEqual(await ollama.listModels({
    fetch: async () => response({ models: [] }),
  }), ['qwen2.5-coder:32b', 'qwen2.5-coder:7b']);
  assert.equal(forbiddenMoneyKey(fallback), null);
});

test('activeSessions flags models with an in-flight mediated generation', async () => {
  const ollama = fresh();
  const sessions = await ollama.activeSessions({
    fetch: async () => response({ models: [
      { name: 'qwen2.5-coder:7b', context_length: 16384 },
      { name: 'gemma3:latest', context_length: 8192 },
    ] }),
    busyModels: () => new Set(['qwen2.5-coder:7b']),
  });
  assert.equal(sessions[0].generating, true);
  assert.equal(sessions[1].generating, false);
});
