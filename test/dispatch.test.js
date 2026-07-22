// test/dispatch.test.js — the dispatch core. tick() is ASYNC (awaits real side effects before persisting),
// so every call is awaited. Regression tests encode the §4-panel blockers the original sync-fake tests missed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');

// Overnight clock (02:00 local) — TZ-robust "not capped". Evening/daytime cases use explicit times.
const NIGHT = new Date('2026-07-12T02:00:00').getTime();
const EVENING = new Date('2026-07-12T23:00:00').getTime();

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckdisp-'));
  process.env.COCKPIT_DIR = dir;
  delete require.cache[require.resolve('../dispatch.js')];
  delete require.cache[require.resolve('../dispatch/eligibility.js')];
  return dir;
}
function writeConfig(dir, dispatch) { fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dispatch })); }
function writeQueue(dir, tasks) { fs.writeFileSync(path.join(dir, 'dispatch-queue.json'), JSON.stringify({ tasks })); }
function readState(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'dispatch-state.json'), 'utf8')); }
const task = (over = {}) => ({ id: 't1', title: 'Fix bug', status: 'active', tags: ['auto:eligible'], blockedBy: [], owner: null, repo: 'o/r', cwd: '/tmp/r', hasPlan: true, ...over });
const okDeps = (over = {}) => ({
  createChat: (o, cb) => cb(null, { name: o.title.replace(/\s+/g, '-'), profile: 'dispatch' }),
  checkCompletion: (_t, cb) => cb(null, { state: 'none' }),
  notify: (_t, cb) => cb && cb(),
  killChat: () => {},
  now: () => NIGHT,
  ...over,
});

test('disabled → spawns nothing and writes no state', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: false }); writeQueue(dir, [task()]);
  const dispatch = require('../dispatch.js');
  let spawned = 0;
  await dispatch.tick([], okDeps({ createChat: (o, cb) => { spawned++; cb(null, { name: 'x', profile: 'dispatch' }); } }), NIGHT);
  assert.strictEqual(spawned, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'dispatch-state.json')));
});

test('dryRun → records the FULL plan, spawns nothing, NOT throttled by concurrency', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true, dryRun: true, concurrency: 1 });
  writeQueue(dir, [task({ id: 'a' }), task({ id: 'b', cwd: '/tmp/r2' })]);
  const dispatch = require('../dispatch.js');
  let spawned = 0;
  await dispatch.tick([], okDeps({ createChat: (o, cb) => { spawned++; cb(null, { name: 'x', profile: 'dispatch' }); } }), EVENING);
  assert.strictEqual(spawned, 0);
  const st = readState(dir);
  assert.deepStrictEqual(st.dryRunPlan.map(p => [p.id, p.reason]), [['a', 'eligible'], ['b', 'eligible']]);
});

test('enabled + eligible EVENING trigger → reserves+spawns exactly concurrency with the dispatch profile', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true, concurrency: 1 });
  writeQueue(dir, [task({ id: 'a' }), task({ id: 'b', cwd: '/tmp/r2' })]);
  const dispatch = require('../dispatch.js');
  const calls = [];
  await dispatch.tick([], okDeps({ createChat: (o, cb) => { calls.push(o); cb(null, { name: o.title.replace(/\s+/g, '-'), profile: 'dispatch' }); } }), EVENING);
  assert.strictEqual(calls.length, 1);            // 2nd task hits at-capacity via the synchronous reservation
  assert.strictEqual(calls[0].profile, 'dispatch');
  const st = readState(dir);
  assert.strictEqual(st.runs.a.phase, 'running');
  assert.strictEqual(st.runs.a.chatName, 'dispatch-a');
  assert.ok(!st.runs.b);
});

test('ASYNC createChat → the run is STILL persisted (fixes the runaway-spawn blocker)', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true }); writeQueue(dir, [task({ id: 'a' })]);
  const dispatch = require('../dispatch.js');
  await dispatch.tick([], okDeps({ createChat: (o, cb) => setImmediate(() => cb(null, { name: 'a-chat', profile: 'dispatch' })) }), NIGHT);
  const st = readState(dir);
  assert.strictEqual(st.runs.a.phase, 'running');   // persisted despite async callback
  assert.strictEqual(st.runs.a.chatName, 'a-chat');
});

test('a second tick does NOT re-dispatch an already-running task (no runaway)', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true }); writeQueue(dir, [task({ id: 'a' })]);
  const dispatch = require('../dispatch.js');
  let spawns = 0;
  const deps = okDeps({ createChat: (o, cb) => { spawns++; setImmediate(() => cb(null, { name: 'a-chat', profile: 'dispatch' })); }, checkCompletion: (_t, cb) => cb(null, { state: 'pending' }) });
  await dispatch.tick([{ chatName: 'a-chat', state: 'running' }], deps, NIGHT);
  await dispatch.tick([{ chatName: 'a-chat', state: 'running' }], deps, NIGHT + 1000);
  assert.strictEqual(spawns, 1);
});

test('a session that comes up NOT under the dispatch profile is refused AND killed (fail-closed)', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true }); writeQueue(dir, [task({ id: 'a' })]);
  const dispatch = require('../dispatch.js');
  let killed = null;
  await dispatch.tick([], okDeps({ createChat: (o, cb) => cb(null, { name: 'a-chat', profile: 'dev' }), killChat: (n) => { killed = n; } }), NIGHT);
  assert.strictEqual(killed, 'a-chat');
  assert.ok(!readState(dir).runs.a);
});

test('running task whose PR is green → phase done + pr recorded + notified once', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true });
  fs.writeFileSync(path.join(dir, 'dispatch-state.json'), JSON.stringify({ runs: { a: { phase: 'running', repo: 'o/r', cwd: '/tmp/r', branch: 'auto/a', chatName: 'a-chat', startedAt: 0 } } }));
  writeQueue(dir, []);
  const dispatch = require('../dispatch.js');
  let notes = 0;
  await dispatch.tick([{ chatName: 'a-chat', state: 'idle' }], okDeps({ checkCompletion: (_t, cb) => setImmediate(() => cb(null, { state: 'green', pr: 7 })), notify: (_t, cb) => { notes++; cb && cb(); } }), 0);
  const st = readState(dir);
  assert.strictEqual(st.runs.a.phase, 'done');
  assert.strictEqual(st.runs.a.pr, 7);
  assert.strictEqual(notes, 1);
});

test('completion error HOLDS prior state even when the session vanished (no false stuck)', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true });
  fs.writeFileSync(path.join(dir, 'dispatch-state.json'), JSON.stringify({ runs: { a: { phase: 'running', repo: 'o/r', cwd: '/tmp/r', branch: 'auto/a', chatName: 'a-chat', startedAt: 0 } } }));
  writeQueue(dir, []);
  const dispatch = require('../dispatch.js');
  await dispatch.tick([], okDeps({ checkCompletion: (_t, cb) => cb(null, { state: 'error' }) }), 0);
  assert.strictEqual(readState(dir).runs.a.phase, 'running');
});

test('pastCutoff: evening/overnight dispatches, daytime holds (overnight window)', () => {
  sandbox(); const dispatch = require('../dispatch.js');
  const at = t => new Date(`2026-07-12T${t}`).getTime();
  assert.strictEqual(dispatch.pastCutoff('05:00', at('23:00:00'), '18:00'), false); // 11pm → dispatch
  assert.strictEqual(dispatch.pastCutoff('05:00', at('02:00:00'), '18:00'), false); // 2am  → dispatch
  assert.strictEqual(dispatch.pastCutoff('05:00', at('19:00:00'), '18:00'), false); // 7pm  → dispatch
  assert.strictEqual(dispatch.pastCutoff('05:00', at('06:00:00'), '18:00'), true);  // 6am  → hold
  assert.strictEqual(dispatch.pastCutoff('05:00', at('09:00:00'), '18:00'), true);  // 9am  → hold
});

test('a morning trigger (09:00) holds — eligible task is not spawned', async () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true, caps: { stopStartingAfter: '05:00', eveningResumeAfter: '18:00' } }); writeQueue(dir, [task()]);
  const dispatch = require('../dispatch.js');
  let spawned = 0;
  await dispatch.tick([], okDeps({ createChat: (o, cb) => { spawned++; cb(null, { name: 'x', profile: 'dispatch' }); } }), new Date('2026-07-12T09:00:00').getTime());
  assert.strictEqual(spawned, 0);
});

test('an empty/invalid cutoff does NOT silently disable the cap (falls back to 05:00 default)', () => {
  const dir = sandbox(); writeConfig(dir, { enabled: true, caps: { stopStartingAfter: '' } });
  const dispatch = require('../dispatch.js');
  assert.strictEqual(dispatch.readConfig().caps.stopStartingAfter, '05:00');
});
