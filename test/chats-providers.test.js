const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = [];
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-providers-'));
  dirs.push(dir);
  const log = path.join(dir, 'tmux.log');
  const stub = path.join(dir, 'tmux');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = stub;
  delete process.env.CK_TEST_CMD;
  delete require.cache[require.resolve('../chats.js')];
  return { chats: require('../chats.js'), log };
}
afterEach(() => {
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
  delete process.env.COCKPIT_DIR;
  delete process.env.CK_TMUX_BIN;
  delete process.env.CK_TEST_CMD;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

test('Ollama chat is mediated, stays alive by registry record, and never invokes tmux', () => {
  const { chats, log } = setup();
  assert.equal(chats.validate({ cwd: os.homedir(), provider: 'ollama', model: 'qwen2.5-coder:32b', effort: 'medium' }), null);
  assert.match(chats.validate({ cwd: os.homedir(), provider: 'ollama', model: 'bad;touch-x', effort: 'medium' }), /model/);
  let created;
  chats.createChat({ provider: 'ollama', title: 'local', cwd: os.homedir(), model: 'qwen2.5-coder:32b', effort: 'medium' }, (err, chat) => {
    assert.ifError(err);
    created = chat;
    assert.equal(chat.provider, 'ollama');
    assert.equal(chat.mediated, true);
  });
  assert.equal(fs.existsSync(log), false);
  assert.equal(chats.isAlive(created.name), true);
  assert.equal(chats.listChats()[0].alive, true);
  chats.killChat(created.name);
  const after = chats.listChats();
  assert.equal(after.filter(c => !c.closed).length, 0, 'no OPEN chats remain');
  assert.ok(after[0] && after[0].closed, 'record archived as closed');
  assert.equal(fs.existsSync(log), false, 'mediated create/alive/kill never touches tmux');
  chats.createChat({ provider: 'ollama', profile: 'nondev' }, err => assert.match(err.message, /only the dev/));
});

test('Ollama initial prompt enters mediated history without delaying create callback', async () => {
  const { chats } = setup();
  let release;
  const response = new Promise(resolve => { release = resolve; });
  globalThis.fetch = () => response;
  let created;
  chats.createChat({
    provider: 'ollama',
    title: 'prompted',
    cwd: os.homedir(),
    model: 'qwen2.5-coder:7b',
    effort: 'medium',
    prompt: 'hello locally',
  }, (err, chat) => {
    assert.ifError(err);
    created = chat;
  });
  assert.ok(created, 'create callback should run before generation finishes');
  const mediator = require('../providers/ollama-chat.js');
  assert.equal(mediator.isBusy(created.name), true);
  assert.equal(mediator.history(created.name)[0].content, 'hello locally');
  release({ ok: true, json: async () => ({
    message: { content: 'hello back' },
    prompt_eval_count: 2,
    eval_count: 3,
  }) });
  await new Promise(resolve => setImmediate(resolve));
  while (mediator.isBusy(created.name)) await new Promise(resolve => setImmediate(resolve));
  assert.equal(mediator.history(created.name)[1].content, 'hello back');
});

test('Antigravity launch is dev-only and invokes agy', () => {
  const { chats, log } = setup();
  assert.equal(chats.validate({ cwd: os.homedir(), provider: 'agy', model: 'antigravity', effort: 'medium' }), null);
  chats.createChat({ provider: 'agy', title: 'gemini', cwd: os.homedir(), model: 'antigravity', effort: 'medium' }, (err, chat) => {
    assert.ifError(err);
    assert.equal(chat.provider, 'agy');
  });
  assert.match(fs.readFileSync(log, 'utf8'), /\bagy$/m);
  chats.createChat({ provider: 'agy', profile: 'dispatch' }, err => assert.match(err.message, /only the dev/));
});

test('Antigravity: a concrete model launches `agy --model <id>` (never --effort); antigravity stays bare agy', () => {
  const { chats, log } = setup();
  assert.equal(chats.validate({ cwd: os.homedir(), provider: 'agy', model: 'gemini-3.8-flash-low', effort: 'medium' }), null);
  assert.equal(chats.validate({ cwd: os.homedir(), provider: 'agy', model: 'gemini-3.8-flash-low' }), null, 'effort optional for agy');
  assert.match(chats.validate({ cwd: os.homedir(), provider: 'agy', model: 'gemini-x;touch-pwn', effort: 'medium' }), /model/);
  assert.match(chats.validate({ cwd: os.homedir(), provider: 'agy', model: 'not-a-listed-model', effort: 'medium' }), /model/);
  chats.createChat({ provider: 'agy', title: 'flash', cwd: os.homedir(), model: 'gemini-3.8-flash-low', effort: 'high' }, err => assert.ifError(err));
  const out = fs.readFileSync(log, 'utf8');
  assert.match(out, /agy --model '?gemini-3\.8-flash-low'?/);
  assert.doesNotMatch(out, /agy[^\n]*--effort/);
  chats.createChat({ provider: 'agy', title: 'default', cwd: os.homedir(), model: 'antigravity', effort: 'medium' }, err => assert.ifError(err));
  assert.match(fs.readFileSync(log, 'utf8'), /\bagy$/m);
});

test('Ollama model ids: namespaced ok, path traversal and shell metacharacters rejected', () => {
  const { chats } = setup();
  for (const ok of ['library/qwen2.5-coder:32b', 'hf.co/org/model:q4_K_M', 'llama3', 'qwen2.5-coder:7b']) {
    assert.equal(chats.validate({ cwd: os.homedir(), provider: 'ollama', model: ok, effort: 'medium' }), null, ok);
  }
  for (const bad of ['../x', 'a/../b', './x', '/abs', 'x/', 'a b', '$(x)', 'a;b']) {
    assert.match(chats.validate({ cwd: os.homedir(), provider: 'ollama', model: bad, effort: 'medium' }), /model/, bad);
  }
});
