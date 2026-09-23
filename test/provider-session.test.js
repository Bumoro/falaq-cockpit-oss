const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeProviderSession } = require('../providers/session.js');

test('provider sessions keep liveness while reporting honest provider state', () => {
  const ollama = normalizeProviderSession({
    id: 'ollama:qwen2.5-coder:32b',
    provider: 'ollama',
    cwd: '',
    client: 'Ollama',
    lastActivity: 1784800000000,
    context: {
      tokens: null,
      limit: 32768,
      pct: null,
      model: 'qwen2.5-coder:32b',
    },
  });
  assert.deepEqual(ollama, {
    sessionId: 'ollama:qwen2.5-coder:32b',
    provider: 'ollama',
    state: 'idle',
    live: true,
    cwd: '',
    client: 'Ollama',
    lastActivityAt: 1784800000000,
    context: {
      tokens: null,
      limit: 32768,
      pct: null,
      model: 'qwen2.5-coder:32b',
    },
    model: 'qwen2.5-coder:32b',
  });

  const antigravity = normalizeProviderSession({
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'antigravity',
    cwd: '/Users/o/repo',
    client: 'Falaq',
    lastActivity: 1784800001000,
    context: null,
  });
  assert.deepEqual(antigravity, {
    sessionId: '11111111-1111-4111-8111-111111111111',
    provider: 'antigravity',
    state: 'running',
    live: true,
    cwd: '/Users/o/repo',
    client: 'Falaq',
    lastActivityAt: 1784800001000,
  });
});

test('an Ollama model generating a mediated reply reports running, not idle', () => {
  const s = normalizeProviderSession({
    id: 'ollama:qwen2.5-coder:32b',
    provider: 'ollama',
    cwd: '',
    client: 'Ollama',
    lastActivity: 1784800000000,
    generating: true,
    context: null,
  });
  assert.equal(s.state, 'running');
});
