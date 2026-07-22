const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(process.env.CK_REPO_ROOT || os.homedir(), '.cktitle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = path.join(dir, 'tmux-args.log');
  const recorder = path.join(dir, 'tmux');
  fs.writeFileSync(recorder, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${rec}"\ncase "$1" in\n  has-session) exit 1;;\n  capture-pane) echo "? for shortcuts";;\nesac\nexit 0\n`, { mode: 0o755 });
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = recorder;
  delete process.env.CK_TEST_CMD;
  delete require.cache[require.resolve('../chats.js')];
  return { chats: require('../chats.js'), dir, rec };
}

test('deriveTitle strips filler prefixes and uses the first sentence or line', (t) => {
  const { chats } = setup(t);
  assert.match(chats.deriveTitle('please help me fix the login bug'), /^fix\b/);
  assert.strictEqual(chats.deriveTitle('Could you please investigate retries? Then deploy.'), 'investigate retries');
  assert.strictEqual(chats.deriveTitle('ultracode\n\nOkay, summarize the results'), 'summarize the results');
  assert.strictEqual(chats.deriveTitle('Summarize the results\nthen publish them'), 'Summarize the results');
});

test('deriveTitle caps titles at eight words and 80 characters without cutting a word', (t) => {
  const { chats } = setup(t);
  const eight = chats.deriveTitle('one two three four five six seven eight nine');
  assert.strictEqual(eight, 'one two three four five six seven eight');
  const chars = chats.deriveTitle('investigate extraordinarilylongword anotherextraordinarilylongword regression today');
  assert.ok(chars.length <= 80);
  assert.ok(!chars.endsWith('anotherextraordinarilylongwor'));
});

test('deriveTitle returns empty for empty, whitespace, or filler-only prompts', (t) => {
  const { chats } = setup(t);
  assert.strictEqual(chats.deriveTitle(''), '');
  assert.strictEqual(chats.deriveTitle('   \n\t'), '');
  assert.strictEqual(chats.deriveTitle('Please, help me!'), '');
});

test('createChat derives a missing title from the raw prompt', (t, done) => {
  const { chats, dir, rec } = setup(t);
  chats.createChat({ cwd: dir, model: 'haiku', effort: 'low', prompt: 'please help me fix the login bug' }, (err, chat) => {
    assert.ifError(err);
    assert.strictEqual(chat.title, 'fix the login bug');
    assert.strictEqual(chats.listChats().find(c => c.name === chat.name).title, 'fix the login bug');
    assert.match(fs.readFileSync(rec, 'utf8'), /new-session.*ck-fix-the-login-bug/);
    done();
  });
});

test('createChat preserves an explicit title', (t, done) => {
  const { chats, dir } = setup(t);
  chats.createChat({ title: 'Exact title', cwd: dir, model: 'haiku', effort: 'low', prompt: 'please infer something else' }, (err, chat) => {
    assert.ifError(err);
    assert.strictEqual(chat.title, 'Exact title');
    done();
  });
});

test("createChat falls back to 'chat' without a title or usable prompt", (t, done) => {
  const { chats, dir } = setup(t);
  chats.createChat({ cwd: dir, model: 'haiku', effort: 'low' }, (err, chat) => {
    assert.ifError(err);
    assert.strictEqual(chat.title, 'chat');
    done();
  });
});

test('a unicode/emoji-derived title still yields a valid ck- session name', (t, done) => {
  const { chats, dir } = setup(t);
  chats.createChat({ cwd: dir, model: 'haiku', effort: 'low', prompt: 'ابدأ 🚀 café résumé <script>' }, (err, chat) => {
    assert.ifError(err);
    assert.match(chat.name, chats.NAME_RE, 'slug must satisfy the tmux name validation');
    assert.match(chat.name, /^ck-[a-z0-9-]{1,40}$/);
    done();
  });
});

test('two prompts that derive the same title get unique session names', (t, done) => {
  const { chats, dir } = setup(t);
  chats.createChat({ cwd: dir, model: 'haiku', effort: 'low', prompt: 'please fix the login bug' }, (err, a) => {
    assert.ifError(err);
    chats.createChat({ cwd: dir, model: 'haiku', effort: 'low', prompt: 'can you fix the login bug' }, (err2, b) => {
      assert.ifError(err2);
      assert.strictEqual(a.title, b.title, 'same derived title');
      assert.notStrictEqual(a.name, b.name, 'but distinct ck- names (slugify dedupe)');
      done();
    });
  });
});
