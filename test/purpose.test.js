const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { subjectForSession } = require('../purpose.js');

test('subjectForSession prefers clients and derives useful repository subjects', () => {
  assert.equal(subjectForSession({ client: 'Tailor Express', cwd: '/work/tailor-express' }), 'Tailor Express');
  assert.equal(subjectForSession({ client: 'Falaq (home)', cwd: os.homedir() }), '');
  assert.equal(subjectForSession({ client: 'Anything', cwd: os.homedir() }), '', 'a client mapped to home is generic');
  assert.equal(subjectForSession({ cwd: path.join(os.homedir(), 'client-os-wt2', 'roles-fixes') }), 'Client-OS');
  assert.equal(subjectForSession({ cwd: path.join(os.homedir(), 'client-os-wt2', 'roles-fixes', 'src') }), 'Client-OS');
  assert.equal(subjectForSession({ cwd: path.join(os.homedir(), 'tailor-express') }), 'Tailor-Express');
  assert.equal(subjectForSession({ cwd: os.homedir() }), '');
});

function setup(t, summarize) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-purpose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  delete require.cache[require.resolve('../purpose.js')];
  const { PurposeTitles } = require('../purpose.js');
  return { dir, titles: new PurposeTitles({ stateDir: dir, summarize }) };
}

test('local failure falls back to the current heuristic title without throwing', async (t) => {
  const { titles } = setup(t, async () => { throw new Error('offline'); });
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'please help me fix the login regression' }], 1000);
  assert.deepEqual(titles.get('s1'), { title: 'fix the login regression', source: 'heuristic' });
});

test('purpose titles cache per session and refresh at most every ten minutes', async (t) => {
  let calls = 0;
  const { titles } = setup(t, async () => { calls++; return calls === 1 ? 'Fix login regression' : 'Repair billing webhook'; });
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'fix login regression' }], 1000);
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'repair billing webhook' }], 1000 + 9 * 60 * 1000);
  assert.equal(calls, 1);
  assert.equal(titles.get('s1').title, 'Fix login regression');
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'repair billing webhook' }], 1000 + 10 * 60 * 1000);
  assert.equal(calls, 2);
  assert.equal(titles.get('s1').title, 'Repair billing webhook');
});

test('invalid local output degrades to the heuristic and persists the cache', async (t) => {
  const { dir, titles } = setup(t, async () => '\n\n');
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'could you investigate context lag?' }], 2000);
  assert.equal(titles.get('s1').title, 'investigate context lag');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'purpose-titles.json'), 'utf8'));
  assert.equal(saved.s1.source, 'heuristic');
});

test('heuristic titles retry the local summarizer after the ten-minute throttle', async (t) => {
  let calls = 0;
  const { titles } = setup(t, async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return 'Fix context lag';
  });
  const sessions = [{ sessionId: 's1', lastPrompt: 'could you investigate context lag?' }];
  await titles.refresh(sessions, 1000);
  await titles.refresh(sessions, 1000 + 9 * 60 * 1000);
  assert.equal(calls, 1);
  assert.equal(titles.get('s1').source, 'heuristic');

  await titles.refresh(sessions, 1000 + 10 * 60 * 1000);
  assert.equal(calls, 2);
  assert.deepEqual(titles.get('s1'), { title: 'Fix context lag', source: 'local' });
});

test('known subjects prefix titles once and normalize the separator', async (t) => {
  const { titles } = setup(t, async () => 'client-os - Fix DriveSalem roles bug');
  await titles.refresh([{ sessionId: 's1', client: 'Client-OS', cwd: '/work/client-os', lastPrompt: 'fix roles' }], 1000);
  assert.deepEqual(titles.get('s1'), { title: 'client-os — Fix DriveSalem roles bug', source: 'local' });
});

test('heuristic fallback is prefixed by a known subject', async (t) => {
  const { titles } = setup(t, async () => { throw new Error('offline'); });
  await titles.refresh([{ sessionId: 's1', client: 'Client-OS', cwd: '/work/client-os', lastPrompt: 'please fix roles' }], 1000);
  assert.equal(titles.get('s1').title, 'Client-OS — fix roles');
});

test('legacy cache entries regenerate immediately and are saved as v2', async (t) => {
  const { dir, titles } = setup(t, async () => 'Fresh purpose');
  titles.cache.s1 = { title: 'Legacy purpose', source: 'local', updatedAt: 1000, promptSignature: 'unchanged' };
  await titles.refresh([{ sessionId: 's1', lastPrompt: 'same prompt' }], 1001);
  assert.equal(titles.get('s1').title, 'Fresh purpose');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'purpose-titles.json'), 'utf8')).s1.v, 2);
});
