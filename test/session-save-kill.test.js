const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { saveKillSession } = require('../duplicates.js');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function fixture(t, overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-save-kill-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const sessions = [{
    sessionId: SESSION_ID,
    purposeTitle: 'Repair duplicate guard',
    chatName: 'ck-duplicate-guard',
    transcriptPath: '/allowed/transcript.jsonl',
    state: 'running',
    startedAt: Date.parse('2026-07-21T08:00:00Z'),
    lastActivityAt: Date.parse('2026-07-21T09:00:00Z'),
  }];
  const pairs = [{
    pairKey: `${SESSION_ID}\0${OTHER_ID}`,
    a: { sessionId: SESSION_ID, purposeTitle: 'Repair duplicate guard', chatName: 'ck-duplicate-guard' },
    b: { sessionId: OTHER_ID, purposeTitle: 'Other work', chatName: 'ck-other-work' },
  }];
  return {
    sessionId: SESSION_ID,
    pairs,
    sessions,
    stateDir,
    transcriptMod: { readTranscript: () => 'latest transcript activity' },
    chatsMod: (() => {
      const chatsMod = {
        killedNames: [],
        listChats: () => [{ name: 'ck-duplicate-guard', alive: true }],
        isAlive: name => !chatsMod.killedNames.includes(name),
        killChat: name => { chatsMod.killedNames.push(name); },
      };
      return chatsMod;
    })(),
    now: new Date('2026-07-21T10:00:00Z'),
    ...overrides,
  };
}

test('saveKillSession writes the durable log before killing', (t) => {
  let killed = false;
  const options = fixture(t);
  options.chatsMod.killChat = (name) => {
    assert.equal(name, 'ck-duplicate-guard');
    const expected = path.join(options.stateDir, 'killed-sessions', `${SESSION_ID}-2026-07-21.md`);
    assert.equal(fs.existsSync(expected), true, 'log must exist before killChat runs');
    assert.match(fs.readFileSync(expected, 'utf8'), /latest transcript activity/);
    killed = true;
    options.chatsMod.killedNames.push(name);
  };

  const result = saveKillSession(options);

  assert.equal(result.status, 200);
  assert.equal(result.killed, true);
  assert.equal(killed, true);
  assert.equal(result.savedPath, path.join(options.stateDir, 'killed-sessions', `${SESSION_ID}-2026-07-21.md`));
});

test('saveKillSession aborts kill when saving fails', (t) => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.stateDir, 'killed-sessions'), 'blocks directory creation');
  let killCalls = 0;
  options.chatsMod.killChat = () => { killCalls++; };

  const result = saveKillSession(options);

  assert.equal(result.status, 500);
  assert.match(result.reason, /save/i);
  assert.equal(killCalls, 0);
});

test('saveKillSession rejects a session outside the current duplicate pairs', (t) => {
  const options = fixture(t, { sessionId: '33333333-3333-4333-8333-333333333333' });
  let killCalls = 0;
  options.chatsMod.killChat = () => { killCalls++; };

  const result = saveKillSession(options);

  assert.equal(result.status, 409);
  assert.match(result.reason, /current duplicate/i);
  assert.equal(killCalls, 0);
  assert.equal(fs.existsSync(path.join(options.stateDir, 'killed-sessions')), false);
});

test('saveKillSession uses killChat for a registered controlled chat', (t) => {
  const options = fixture(t);
  let killedName = '';
  options.chatsMod.killChat = (name) => { killedName = name; options.chatsMod.killedNames.push(name); };

  const result = saveKillSession(options);

  assert.equal(result.status, 200);
  assert.equal(result.handle, 'controlled-chat');
  assert.equal(killedName, 'ck-duplicate-guard');
});

test('saveKillSession saves but does not kill a session already marked ended', (t) => {
  const options = fixture(t);
  options.sessions[0].state = 'ended';
  options.sessions[0].endedAt = Date.parse('2026-07-21T09:30:00Z');
  let killCalls = 0;
  options.chatsMod.killChat = () => { killCalls++; };

  const result = saveKillSession(options);

  assert.equal(result.status, 200);
  assert.equal(result.alreadyEnded, true);
  assert.equal(result.killed, false);
  assert.equal(fs.existsSync(result.savedPath), true);
  assert.equal(killCalls, 0);
});

test('saveKillSession reports failure when the session survives the kill attempt', (t) => {
  const options = fixture(t);
  // killChat that silently fails (mirrors the real killChat swallowing tmux errors): the
  // session stays alive, so the route must NOT report killed:true.
  options.chatsMod.killChat = () => {};

  const result = saveKillSession(options);

  assert.equal(result.status, 500);
  assert.equal(result.killed, false);
  assert.match(result.reason, /still alive/i);
  assert.equal(fs.existsSync(result.savedPath), true);
});

test('saveKillSession fails closed when the kill cannot be verified', (t) => {
  const throwing = fixture(t);
  throwing.chatsMod.isAlive = () => { throw new Error('tmux unavailable'); };
  const throwingResult = saveKillSession(throwing);
  assert.equal(throwingResult.status, 500);
  assert.equal(throwingResult.killed, false);
  assert.match(throwingResult.reason, /could not be verified/i);

  const missing = fixture(t);
  delete missing.chatsMod.isAlive;
  const missingResult = saveKillSession(missing);
  assert.equal(missingResult.status, 500);
  assert.equal(missingResult.killed, false);
  assert.match(missingResult.reason, /could not be verified/i);
});

test('saveKillSession saves then returns 409 without a safe live handle', (t) => {
  const options = fixture(t);
  options.sessions[0].chatName = '';
  options.pairs[0].a.chatName = '';
  options.chatsMod.listChats = () => [];
  let killCalls = 0;
  options.chatsMod.killChat = () => { killCalls++; };

  const result = saveKillSession(options);

  assert.equal(result.status, 409);
  assert.match(result.reason, /no safe live PID or tmux handle/i);
  assert.equal(fs.existsSync(result.savedPath), true);
  assert.equal(killCalls, 0);
});

test('saveKillSession rejects a stale banner pair no longer structurally duplicated', (t) => {
  const options = fixture(t);
  options.freshPairs = []; // fresh re-pairing says: no longer duplicates
  let killCalls = 0;
  options.chatsMod.killChat = () => { killCalls++; };

  const result = saveKillSession(options);

  assert.equal(result.status, 409);
  assert.match(result.reason, /no longer looks like a duplicate/i);
  assert.equal(killCalls, 0);
  assert.equal(fs.existsSync(path.join(options.stateDir, 'killed-sessions')), false, 'no log saved for a refused stale kill');
});

test('saveKillSession kills an uncontrolled session via its recorded claude PID', (t) => {
  const { spawnSync } = require('child_process');
  // The victim must NOT be this test process's child: a killed child lingers as a zombie
  // (kill(pid,0) still succeeds) while saveKillSession's synchronous wait blocks Node from
  // reaping it — a false "still alive". Real victims are unrelated processes, so spawn a
  // GRANDCHILD (its shell parent exits immediately → reparented to init) named "claude".
  const spawned = spawnSync('/bin/sh', ['-c', '( exec -a claude sleep 30 >/dev/null 2>&1 & echo $! )'], { encoding: 'utf8' });
  const victimPid = Number(spawned.stdout.trim());
  assert.ok(Number.isInteger(victimPid) && victimPid > 1, 'victim spawn failed');
  t.after(() => { try { process.kill(victimPid, 'SIGKILL'); } catch (e) {} });
  const options = fixture(t);
  options.sessions[0].chatName = '';
  options.sessions[0].pid = victimPid;
  options.pairs[0].a.chatName = '';
  options.chatsMod.listChats = () => [];

  // Give exec a beat to swap the command name.
  spawnSync('/bin/sleep', ['0.2']);
  const result = saveKillSession(options);

  assert.equal(result.status, 200);
  assert.equal(result.killed, true);
  assert.equal(result.handle, 'pid');
});

test('saveKillSession refuses a recorded PID that is not a claude process', (t) => {
  const { spawn } = require('child_process');
  const bystander = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(bystander.pid, 'SIGKILL'); } catch (e) {} });
  const options = fixture(t);
  options.sessions[0].chatName = '';
  options.sessions[0].pid = bystander.pid;
  options.pairs[0].a.chatName = '';
  options.chatsMod.listChats = () => [];

  const result = saveKillSession(options);

  assert.equal(result.status, 409);
  assert.match(result.reason, /no longer looks like a Claude process/i);
  let alive = true;
  try { process.kill(bystander.pid, 0); } catch (e) { alive = false; }
  assert.equal(alive, true, 'bystander process must not be killed');
});
