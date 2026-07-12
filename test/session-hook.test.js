// ~/.claude/agent-dashboard/test/session-hook.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK = path.join(__dirname, '..', 'session-hook.js');

function run(payload, dir) {
  execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, COCKPIT_DIR: dir },
  });
  const f = path.join(dir, 'sessions', payload.session_id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

test('SessionStart creates session file with client mapping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    clientMap: { 'my-app': 'My App', 'my-api': 'My API' }
  }));
  const s = run({ session_id: 'aaa', hook_event_name: 'SessionStart',
    cwd: '/Users/dev/my-app', model: 'claude-fable-5', transcript_path: '/tmp/x/t.jsonl' }, dir);
  assert.equal(s.state, 'running');
  assert.equal(s.client, 'My App');
  assert.equal(s.model, 'claude-fable-5');
  assert.ok(s.startedAt > 0);
  assert.equal(s.transcriptPath, '/tmp/x/t.jsonl');
});

test('Notification flips to needs_you, UserPromptSubmit clears it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'bbb', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  let s = run({ session_id: 'bbb', hook_event_name: 'Notification',
    cwd: '/x', message: 'Claude needs your permission to use Bash' }, dir);
  assert.equal(s.state, 'needs_you');
  assert.match(s.needsYou.message, /permission/);
  s = run({ session_id: 'bbb', hook_event_name: 'UserPromptSubmit',
    cwd: '/x', prompt_text: 'yes go ahead' }, dir);
  assert.equal(s.state, 'running');
  assert.equal(s.needsYou, null);
});

test('PostToolUse throttles repeat writes within 5s for same tool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'ccc', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  const a = run({ session_id: 'ccc', hook_event_name: 'PostToolUse', cwd: '/x', tool_name: 'Bash' }, dir);
  const b = run({ session_id: 'ccc', hook_event_name: 'PostToolUse', cwd: '/x', tool_name: 'Bash' }, dir);
  assert.equal(a.lastActivityAt, b.lastActivityAt); // second write skipped
  const c = run({ session_id: 'ccc', hook_event_name: 'PostToolUse', cwd: '/x', tool_name: 'Edit' }, dir);
  assert.equal(c.lastTool, 'Edit'); // different tool writes through
});

test('Stop -> idle, SessionEnd -> ended, malformed stdin exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'ddd', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  let s = run({ session_id: 'ddd', hook_event_name: 'Stop', cwd: '/x' }, dir);
  assert.equal(s.state, 'idle');
  s = run({ session_id: 'ddd', hook_event_name: 'SessionEnd', cwd: '/x' }, dir);
  assert.equal(s.state, 'ended');
  assert.ok(s.endedAt > 0);
  execFileSync('node', [HOOK], { input: 'not json', env: { ...process.env, COCKPIT_DIR: dir } }); // must not throw
});

test('subagent counter tracks start/stop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'eee', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'eee', hook_event_name: 'SubagentStart', cwd: '/x' }, dir);
  let s = run({ session_id: 'eee', hook_event_name: 'SubagentStart', cwd: '/x' }, dir);
  assert.equal(s.subagents, 2);
  s = run({ session_id: 'eee', hook_event_name: 'SubagentStop', cwd: '/x' }, dir);
  assert.equal(s.subagents, 1);
});

test('SubagentStart records agent id+type; SubagentStop removes by agent_id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'hhh', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'hhh', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'a1', agent_type: 'code-reviewer' }, dir);
  let s = run({ session_id: 'hhh', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'a2', agent_type: 'general-purpose' }, dir);
  assert.equal(s.subagents, 2);
  assert.equal(s.agents.length, 2);
  assert.deepEqual(s.agents.map(a => a.type), ['code-reviewer', 'general-purpose']);
  assert.ok(s.agents.every(a => a.at > 0));
  s = run({ session_id: 'hhh', hook_event_name: 'SubagentStop', cwd: '/x', agent_id: 'a1' }, dir);
  assert.equal(s.subagents, 1);
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].id, 'a2', 'the still-running agent (a2) remains');
});

test('SubagentStart without agent_id counts but records no phantom agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'iii', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  let s = run({ session_id: 'iii', hook_event_name: 'SubagentStart', cwd: '/x' }, dir);
  assert.equal(s.subagents, 1);
  assert.ok(!s.agents || s.agents.length === 0, 'no phantom agent with a missing id');
  s = run({ session_id: 'iii', hook_event_name: 'SubagentStop', cwd: '/x' }, dir);
  assert.equal(s.subagents, 0);
});

test('a SubagentStop with a missing id floors the count and clears the phantom agent (no slice(-0) leak)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'kkk', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'kkk', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'a1', agent_type: 'x' }, dir);
  const s = run({ session_id: 'kkk', hook_event_name: 'SubagentStop', cwd: '/x' }, dir); // no agent_id
  assert.equal(s.subagents, 0);
  assert.equal((s.agents || []).length, 0, 'no phantom agent lingers once the count reaches 0');
});

test('a duplicate SubagentStart id is not double-listed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'lll', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'lll', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'd1', agent_type: 'x' }, dir);
  const s = run({ session_id: 'lll', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'd1', agent_type: 'x' }, dir);
  assert.equal(s.agents.length, 1, 'same id is not listed twice');
});

test('the agents list is capped at 12', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'mmm', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  let s;
  for (let i = 0; i < 15; i++) s = run({ session_id: 'mmm', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'g' + i, agent_type: 't' }, dir);
  assert.equal(s.agents.length, 12, 'list bounded to the 12 most recent');
});

test('SessionEnd clears running agents and the counter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'jjj', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'jjj', hook_event_name: 'SubagentStart', cwd: '/x', agent_id: 'z1', agent_type: 'gsd-executor' }, dir);
  const s = run({ session_id: 'jjj', hook_event_name: 'SessionEnd', cwd: '/x' }, dir);
  assert.equal(s.state, 'ended');
  assert.ok(!s.agents || s.agents.length === 0, 'an ended session shows no running agents');
  assert.equal(s.subagents, 0);
});

test('Notification then PostToolUse clears needs_you (permission approval path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'fff', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  run({ session_id: 'fff', hook_event_name: 'PostToolUse', cwd: '/x', tool_name: 'Bash' }, dir);
  let s = run({ session_id: 'fff', hook_event_name: 'Notification',
    cwd: '/x', message: 'Claude needs your permission to use Bash' }, dir);
  assert.equal(s.state, 'needs_you');
  // Same tool within throttle window — must still clear needs_you (throttle skipped)
  s = run({ session_id: 'fff', hook_event_name: 'PostToolUse', cwd: '/x', tool_name: 'Bash' }, dir);
  assert.equal(s.state, 'running');
  assert.equal(s.needsYou, null);
});

test('UserPromptSubmit with prompt field populates lastPrompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));
  run({ session_id: 'ggg', hook_event_name: 'SessionStart', cwd: '/x' }, dir);
  let s = run({ session_id: 'ggg', hook_event_name: 'UserPromptSubmit',
    cwd: '/x', prompt: 'fix the login bug' }, dir);
  assert.equal(s.lastPrompt, 'fix the login bug');
  // empty prompt must not clobber the existing lastPrompt
  s = run({ session_id: 'ggg', hook_event_name: 'UserPromptSubmit', cwd: '/x' }, dir);
  assert.equal(s.lastPrompt, 'fix the login bug');
});
