const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-agy-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-agy-state-'));
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'log'), { recursive: true });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    clientMap: { 'sample-project': 'Sample' },
  }));
  process.env.COCKPIT_DIR = state;
  delete require.cache[require.resolve('../providers/antigravity.js')];
  return { root, antigravity: require('../providers/antigravity.js') };
}

function writeDb(root, id, mtime) {
  const file = path.join(root, 'conversations', id + '.db');
  fs.writeFileSync(file, 'opaque sqlite bytes');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function writeLog(root, name, lines, mtime) {
  const file = path.join(root, 'log', name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

test('activeSessions returns fresh conversation DBs newest first as liveness-only Antigravity cards', () => {
  const { root, antigravity } = setup();
  const now = 1784800000000;
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  writeDb(root, older, now - 90_000);
  writeDb(root, newer, now - 20_000);

  const sessions = antigravity.activeSessions({ root, now, freshMs: 180_000 });
  assert.deepEqual(sessions.map(x => x.id), [newer, older]);
  assert.deepEqual(sessions[0], {
    id: newer,
    cwd: '',
    client: '',
    lastActivity: now - 20_000,
    context: null,
    provider: 'antigravity',
  });
  assert.equal('usage' in sessions[0], false);
  assert.equal('model' in sessions[0], false);
});

test('activeSessions ignores stale, non-UUID, and non-db files', () => {
  const { root, antigravity } = setup();
  const now = 1784800000000;
  writeDb(root, '33333333-3333-4333-8333-333333333333', now - 180_001);
  fs.writeFileSync(path.join(root, 'conversations', 'not-a-uuid.db'), 'x');
  fs.writeFileSync(path.join(root, 'conversations', '44444444-4444-4444-8444-444444444444.db-wal'), 'x');

  assert.deepEqual(antigravity.activeSessions({ root, now, freshMs: 180_000 }), []);
});

test('a live CLI log correlates workspace and client without reading DB contents', () => {
  const { root, antigravity } = setup();
  const now = 1784800000000;
  const id = '55555555-5555-4555-8555-555555555555';
  writeDb(root, id, now - 1000);
  writeLog(root, 'cli-live.log', [
    'I server.go] Creating CLI server backend',
    'I manager.go] Initializing CLI store manager for workspace /Users/o/sample-project',
    `I server.go] Starting conversation update stream for ${id}`,
  ], now);

  const [session] = antigravity.activeSessions({ root, now, freshMs: 180_000 });
  assert.equal(session.cwd, '/Users/o/sample-project');
  assert.equal(session.client, 'Sample');
});

test('a matching newer stop marker promptly suppresses an otherwise fresh DB', () => {
  const { root, antigravity } = setup();
  const now = 1784800000000;
  const id = '66666666-6666-4666-8666-666666666666';
  writeDb(root, id, now - 2000);
  writeLog(root, 'cli-stopped.log', [
    'I manager.go] Initializing CLI store manager for workspace /Users/o/repo',
    `I server.go] Starting conversation update stream for ${id}`,
    'I conversation_manager.go] Stopping conversation stream',
  ], now - 1000);

  assert.deepEqual(antigravity.activeSessions({ root, now, freshMs: 180_000 }), []);
});

test('an old stopped log does not hide a newly resumed UUID', () => {
  const { root, antigravity } = setup();
  const now = 1784800000000;
  const id = '77777777-7777-4777-8777-777777777777';
  writeLog(root, 'cli-old-stop.log', [
    `I server.go] Starting conversation update stream for ${id}`,
    'I conversation_manager.go] Stopping conversation stream',
  ], now - 60_000);
  writeDb(root, id, now - 1000);

  assert.equal(antigravity.activeSessions({ root, now, freshMs: 180_000 }).length, 1);
});

test('missing or unreadable provider directories return an empty list and never throw', () => {
  const { root, antigravity } = setup();
  fs.rmSync(path.join(root, 'conversations'), { recursive: true });
  assert.deepEqual(antigravity.activeSessions({ root, now: 1784800000000 }), []);

  const fileRoot = path.join(root, 'not-a-directory');
  fs.writeFileSync(fileRoot, 'x');
  assert.deepEqual(antigravity.activeSessions({ root: fileRoot, now: 1784800000000 }), []);
});
