const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = [];

function setup(chats = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-chat-'));
  dirs.push(dir);
  process.env.COCKPIT_DIR = dir;
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify(chats));
  delete require.cache[require.resolve('../providers/ollama-chat.js')];
  return { dir, mediator: require('../providers/ollama-chat.js') };
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

afterEach(() => {
  delete process.env.COCKPIT_DIR;
  delete process.env.CK_OLLAMA_URL;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('send persists history and tokens, calls non-streaming chat, and appends usage', async () => {
  const chat = { name: 'ck-round-trip', provider: 'ollama', model: 'qwen2.5-coder:7b', mediated: true };
  const { dir, mediator } = setup([chat]);
  const calls = [];
  const result = await mediator.send(chat.name, chat.model, 'Explain JSONL', {
    now: 1784800000000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({
        message: { role: 'assistant', content: 'One JSON value per line.' },
        prompt_eval_count: 41,
        eval_count: 9,
      });
    },
  });

  assert.deepEqual(result, { ok: true, tokens: { prompt: 41, eval: 9 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: chat.model,
    messages: [{ role: 'user', content: 'Explain JSONL' }],
    stream: false,
  });
  assert.deepEqual(mediator.history(chat.name), [
    { role: 'user', content: 'Explain JSONL', ts: '2026-07-23T09:46:40.000Z', tokens: null },
    {
      role: 'assistant',
      content: 'One JSON value per line.',
      ts: '2026-07-23T09:46:40.000Z',
      tokens: { prompt: 41, eval: 9 },
    },
  ]);
  const ledger = fs.readFileSync(path.join(dir, 'ollama-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger, [{
    ts: '2026-07-23T09:46:40.000Z',
    model: chat.model,
    prompt: 41,
    eval: 9,
  }]);
  assert.equal(forbiddenMoneyKey({ history: mediator.history(chat.name), ledger }), null);
});

test('busy guard rejects a second send synchronously and releases after generation', async () => {
  const chat = { name: 'ck-busy', provider: 'ollama', model: 'gemma3:latest', mediated: true };
  const { mediator } = setup([chat]);
  let release;
  const pendingResponse = new Promise(resolve => { release = resolve; });
  const first = mediator.send(chat.name, chat.model, 'first', { fetch: () => pendingResponse });

  assert.equal(mediator.isBusy(chat.name), true);
  assert.throws(
    () => mediator.send(chat.name, chat.model, 'second', { fetch: async () => response({}) }),
    error => error.code === 'OLLAMA_CHAT_BUSY' && error.status === 409 && error.statusCode === 409
  );
  assert.deepEqual(mediator.history(chat.name).map(turn => turn.content), ['first']);

  release(response({ message: { content: 'done' }, prompt_eval_count: 1, eval_count: 1 }));
  assert.equal((await first).ok, true);
  assert.equal(mediator.isBusy(chat.name), false);
});

test('daemon failure becomes an honest assistant turn and does not add usage', async () => {
  const chat = { name: 'ck-offline', provider: 'ollama', model: 'llama3.2:latest', mediated: true };
  const { dir, mediator } = setup([chat]);
  const result = await mediator.send(chat.name, chat.model, 'Are you there?', {
    fetch: async () => { throw new Error('connection refused'); },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /connection refused/);
  const turns = mediator.history(chat.name);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, 'assistant');
  assert.match(turns[1].content, /^Ollama error: connection refused/);
  assert.equal(turns[1].tokens, null);
  assert.equal(fs.existsSync(path.join(dir, 'ollama-usage.jsonl')), false);
});

test('contextFor returns the most recent assistant occupancy for the requested model', async () => {
  const chats = [
    { name: 'ck-old', provider: 'ollama', model: 'model-a:7b', mediated: true },
    { name: 'ck-new', provider: 'ollama', model: 'model-a:7b', mediated: true },
    { name: 'ck-other', provider: 'ollama', model: 'model-b:7b', mediated: true },
  ];
  const { mediator } = setup(chats);
  const run = (name, model, ts, prompt, evalTokens) => mediator.send(name, model, 'hi', {
    now: ts,
    fetch: async () => response({
      message: { content: 'hello' },
      prompt_eval_count: prompt,
      eval_count: evalTokens,
    }),
  });
  await run('ck-old', 'model-a:7b', 100, 10, 2);
  await run('ck-other', 'model-b:7b', 300, 99, 1);
  await run('ck-new', 'model-a:7b', 200, 30, 7);

  assert.deepEqual(mediator.contextFor('model-a:7b'), { tokens: 37, ts: '1970-01-01T00:00:00.200Z' });
  assert.deepEqual(mediator.contextFor('model-b:7b'), { tokens: 100, ts: '1970-01-01T00:00:00.300Z' });
  assert.equal(mediator.contextFor('missing:7b'), null);
  assert.equal(forbiddenMoneyKey(mediator.contextFor('model-a:7b')), null);
  assert.equal(mediator.GENERATION_TIMEOUT_MS, 120000);
});

test('discard deletes the transcript and a reused slug starts a brand-new conversation', async () => {
  const { dir, mediator } = setup([{ name: 'ck-chat', provider: 'ollama', model: 'qwen2.5-coder:7b', mediated: true }]);
  await mediator.send('ck-chat', 'qwen2.5-coder:7b', 'old secret talk', {
    fetch: async () => response({ message: { content: 'old reply' }, prompt_eval_count: 5, eval_count: 2 }),
    now: 1784800000000,
  });
  mediator.discard('ck-chat');
  assert.equal(fs.existsSync(path.join(dir, 'ollama-chats', 'ck-chat.jsonl')), false);
  assert.deepEqual(mediator.history('ck-chat'), []);

  let sentMessages = null;
  await mediator.send('ck-chat', 'qwen2.5-coder:7b', 'fresh start', {
    fetch: async (url, init) => { sentMessages = JSON.parse(init.body).messages; return response({ message: { content: 'hi' }, prompt_eval_count: 3, eval_count: 1 }); },
    now: 1784800001000,
  });
  assert.deepEqual(sentMessages.map(m => m.content), ['fresh start'], 'no resurrection of the dead conversation');
  assert.equal(mediator.history('ck-chat').length, 2);
});

test('discard during an in-flight generation suppresses the late transcript and ledger appends', async () => {
  const { dir, mediator } = setup([{ name: 'ck-live', provider: 'ollama', model: 'qwen2.5-coder:7b', mediated: true }]);
  let release;
  const gate = new Promise(r => { release = r; });
  const pending = mediator.send('ck-live', 'qwen2.5-coder:7b', 'question', {
    fetch: async () => { await gate; return response({ message: { content: 'late reply' }, prompt_eval_count: 9, eval_count: 9 }); },
    now: 1784800000000,
  });
  mediator.discard('ck-live');
  release();
  await pending;
  assert.equal(fs.existsSync(path.join(dir, 'ollama-chats', 'ck-live.jsonl')), false, 'no late transcript append');
  assert.equal(fs.existsSync(path.join(dir, 'ollama-usage.jsonl')), false, 'no late ledger append');
});

test('honest error turns are shown in history but never replayed to the model', async () => {
  const { mediator } = setup([{ name: 'ck-err', provider: 'ollama', model: 'qwen2.5-coder:7b', mediated: true }]);
  await mediator.send('ck-err', 'qwen2.5-coder:7b', 'first', { fetch: async () => response({}, false), now: 1784800000000 });
  assert.match(mediator.history('ck-err')[1].content, /^Ollama error: /);

  let sentMessages = null;
  await mediator.send('ck-err', 'qwen2.5-coder:7b', 'retry', {
    fetch: async (url, init) => { sentMessages = JSON.parse(init.body).messages; return response({ message: { content: 'ok' }, prompt_eval_count: 2, eval_count: 1 }); },
    now: 1784800001000,
  });
  assert.deepEqual(sentMessages.map(m => m.role), ['user', 'user', 'assistant'].slice(0, sentMessages.length));
  assert.ok(!sentMessages.some(m => /^Ollama error: /.test(m.content)), 'error turn not replayed');
});
