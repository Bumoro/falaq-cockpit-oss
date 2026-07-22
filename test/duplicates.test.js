const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dup = require('../duplicates.js');

const session = (id, over = {}) => ({ sessionId: id, state: 'running', purposeTitle: `Task ${id}`, ...over });

test('structural matcher flags repo+branch, touched-file, and >=0.6 title overlap', () => {
  const pairs = dup.structuralPairs([
    session('a', { repoKey: '/repo', branch: 'main', purposeTitle: 'Fix cockpit context lag' }),
    session('b', { repoKey: '/repo', branch: 'main', purposeTitle: 'Fix cockpit context delay' }),
    session('c', { repoKey: '/other', branch: 'work', touchedFiles: ['/x/api.js'] }),
    session('d', { repoKey: '/third', branch: 'work', touchedFiles: ['/x/api.js'] }),
  ]);
  assert.deepEqual(pairs.map(p => p.pairKey), ['a\0b', 'c\0d']);
  assert.ok(pairs[0].signals.includes('repo_branch'));
  assert.ok(pairs[0].signals.includes('title_overlap'));
  assert.ok(pairs[1].signals.includes('file_overlap'));
  assert.equal(dup.titleOverlap('Fix cockpit context lag', 'Fix cockpit context delay'), 0.6);
});

test('blank repo metadata and unrelated sessions never match, while a live idle chat can', () => {
  assert.deepEqual(dup.structuralPairs([
    session('a', { repoKey: '', branch: '', purposeTitle: 'Fix login' }),
    session('b', { repoKey: '', branch: '', purposeTitle: 'Write invoices' }),
  ]), []);
  assert.equal(dup.structuralPairs([
    session('a', { repoKey: '/r', branch: 'main' }),
    session('b', { state: 'idle', live: true, repoKey: '/r', branch: 'main' }),
  ]).length, 1);
});

test('semantic yes confirms, no suppresses, and local failure is unconfirmed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-dup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = [session('a', { repoKey: '/r', branch: 'main' }), session('b', { repoKey: '/r', branch: 'main' })];
  const yes = new dup.DuplicateDetector({ stateDir: dir, confirm: async () => 'YES | same feature' });
  assert.equal((await yes.refresh(input, 1000))[0].status, 'confirmed');
  const no = new dup.DuplicateDetector({ stateDir: dir + '-no', confirm: async () => 'NO | different layers' });
  assert.equal((await no.refresh(input, 1000)).length, 0);
  const down = new dup.DuplicateDetector({ stateDir: dir + '-down', confirm: async () => { throw new Error('offline'); } });
  assert.equal((await down.refresh(input, 1000))[0].status, 'unconfirmed');
});

test('dismiss remembers a stable pair and removes it from later refreshes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-dup-dismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const detector = new dup.DuplicateDetector({ stateDir: dir, confirm: async () => 'YES | overlap' });
  const input = [session('z', { repoKey: '/r', branch: 'main' }), session('a', { repoKey: '/r', branch: 'main' })];
  const [pair] = await detector.refresh(input, 1000);
  assert.equal(pair.pairKey, 'a\0z');
  assert.equal(detector.dismiss(pair.pairKey), true);
  assert.deepEqual(await detector.refresh(input, 2000), []);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'duplicate-dismissals.json'))).includes('a\0z'));
});

test('large fleets bound semantic work and leave excess pairs unconfirmed', async () => {
  let calls = 0;
  const detector = new dup.DuplicateDetector({ stateDir: '/nonexistent', maxSemanticPairs: 1, confirm: async () => { calls++; return 'YES | same'; } });
  const pairs = await detector.refresh(['a', 'b', 'c'].map(id => session(id, { repoKey: '/r', branch: 'main' })), 1000);
  assert.equal(pairs.length, 3);
  assert.equal(calls, 1);
  assert.equal(pairs.filter(p => p.status === 'unconfirmed').length, 2);
});

test('process-related sessions (subagent chain) are never flagged as duplicates', () => {
  // pid 300's ancestry: 300 -> 250 -> 100 (session a). pid 999 is unrelated.
  const ppids = { 300: 250, 250: 100, 999: 1 };
  const readPpid = pid => ppids[pid] || 1;
  const a = session('a', { pid: 100, repoKey: '/repo', branch: 'main', purposeTitle: 'Fix cockpit context lag' });
  const child = session('b', { pid: 300, repoKey: '/repo', branch: 'main', purposeTitle: 'Fix cockpit context delay' });
  const stranger = session('c', { pid: 999, repoKey: '/repo', branch: 'main', purposeTitle: 'Fix cockpit context freeze' });
  const pairs = dup.structuralPairs([a, child, stranger], { readPpid });
  const keys = pairs.map(p => [p.a.sessionId, p.b.sessionId].sort().join('+'));
  assert.ok(!keys.includes('a+b'), 'parent+subagent pair must be suppressed');
  assert.ok(keys.includes('a+c') && keys.includes('b+c'), 'unrelated overlaps still flag');
});

test('missing or equal pids never suppress a pair', () => {
  const readPpid = () => 1;
  const pairs = dup.structuralPairs([
    session('a', { repoKey: '/repo', branch: 'main' }),
    session('b', { repoKey: '/repo', branch: 'main' }),
  ], { readPpid });
  assert.equal(pairs.length, 1);
});
