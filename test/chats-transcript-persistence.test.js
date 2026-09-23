const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckchat-transcript-'));
  const tmux = path.join(dir, 'tmux-stub.sh');
  fs.writeFileSync(tmux, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmux, 0o755);
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify([
    { name: 'ck-open', title: 'Open', provider: 'claude' },
    { name: 'ck-closed', title: 'Closed', provider: 'claude', closed: 1, transcriptPath: '/old/closed.jsonl' },
  ]));
  const projects = path.join(dir, 'projects');
  fs.mkdirSync(projects);
  process.env.COCKPIT_DIR = dir;
  process.env.CK_TMUX_BIN = tmux;
  process.env.CK_PROJECTS_DIR = projects;
  delete require.cache[require.resolve('../chats.js')];
  return { dir, projects, chats: require('../chats.js') };
}

test('correlated open chats persist changed transcript paths without rewriting unchanged records', () => {
  const { dir, projects, chats } = fixture();
  const registry = path.join(dir, 'chats.json');
  const first = path.join(projects, 'first', 'transcript.jsonl');
  const second = path.join(projects, 'second', 'transcript.jsonl');
  const originalWrite = fs.writeFileSync;
  let registryWrites = 0;
  fs.writeFileSync = function (file, ...args) {
    if (file === registry + '.tmp') registryWrites++;
    return originalWrite.call(this, file, ...args);
  };
  try {
    assert.equal(chats.persistTranscriptPath('ck-open', first), true);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8'))[0].transcriptPath, first);
    assert.equal(registryWrites, 1);

    assert.equal(chats.persistTranscriptPath('ck-open', second), true);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8'))[0].transcriptPath, second);
    assert.equal(registryWrites, 2);

    assert.equal(chats.persistTranscriptPath('ck-open', second), false);
    assert.equal(registryWrites, 2, 'an unchanged correlation must not rewrite chats.json');

    assert.equal(chats.persistTranscriptPath('ck-open', '/outside/jail.jsonl'), false);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8'))[0].transcriptPath, second);
    assert.equal(registryWrites, 2, 'a path outside the transcript jail must never be persisted');

    assert.equal(chats.persistTranscriptPath('ck-closed', path.join(projects, 'new', 'closed.jsonl')), false);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8'))[1].transcriptPath, '/old/closed.jsonl');
    assert.equal(registryWrites, 2, 'closed-chat archival behavior stays untouched');
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

test('session correlation writes through and open persisted transcripts remain whitelisted', () => {
  const server = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'server.js'), 'utf8');
  assert.match(server, /chatsMod\.persistTranscriptPath\(s\.chatName,s\.transcriptPath\)/);
  assert.match(server, /if \(c && c\.transcriptPath\) set\.add\(c\.transcriptPath\)/);
});

test('/chat falls back to the persisted open-chat transcript when its live session record is gone', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'chat.html'), 'utf8');
  assert.match(html, /const openTP=\(chat&&!chat\.closed&&chat\.transcriptPath\)\|\|null;/);
  assert.match(html, /s\.transcriptPath\|\|openTP\|\|closedTP/);
});

test('/chat clamps persisted rail widths on boot so the conversation column can never be pushed off-screen', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'chat.html'), 'utf8');
  assert.match(html, /ws\.style\.setProperty\('--sidebar-w',clamp\(saved\.sidebar,120,/);
  assert.match(html, /ws\.style\.setProperty\('--files-w',clamp\(saved\.files,120,/);
});
