// agents.test.js — file-based detection of live (incl. background) subagents per session.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const agents = require('../agents.js');

function setup() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ckag-'));
  process.env.CK_PROJECTS_DIR = proj; // point the jail at this temp projects root
  const tp = path.join(proj, 'sess-abc.jsonl');
  fs.writeFileSync(tp, '{}\n');
  const sub = path.join(proj, 'sess-abc', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  return { tp, sub };
}
function writeAgent(sub, id, meta, ageMs) {
  const jf = path.join(sub, 'agent-' + id + '.jsonl');
  fs.writeFileSync(jf, '{"x":1}\n');
  if (meta) fs.writeFileSync(path.join(sub, 'agent-' + id + '.meta.json'), JSON.stringify(meta));
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(jf, t, t); } // utimes takes seconds
}

test('subagentsDir derives from the transcript path', () => {
  assert.equal(agents.subagentsDir('/a/b/S.jsonl'), '/a/b/S/subagents');
  assert.equal(agents.subagentsDir('/a/b/S.txt'), null);
  assert.equal(agents.subagentsDir(null), null);
});

test('detects a FRESH agent and labels it from meta.json', () => {
  const { tp, sub } = setup();
  writeAgent(sub, 'aaa111', { agentType: 'general-purpose', description: 'do X' }, 0);
  const a = agents.activeAgents(tp);
  assert.equal(a.length, 1);
  assert.equal(a[0].id, 'aaa111');
  assert.equal(a[0].type, 'general-purpose');
  assert.equal(a[0].desc, 'do X');
});

test('ignores a STALE agent (mtime beyond the freshness window)', () => {
  const { tp, sub } = setup();
  writeAgent(sub, 'old1', { agentType: 'x' }, 5 * 60 * 1000); // 5 min old, default window 120s
  assert.equal(agents.activeAgents(tp).length, 0);
  assert.equal(agents.activeAgents(tp, { freshMs: 10 * 60 * 1000 }).length, 1); // wide window still sees it
});

test('missing meta -> type "agent"; a non-existent subagents dir -> []', () => {
  const { tp, sub } = setup();
  writeAgent(sub, 'nom', null, 0);
  const a = agents.activeAgents(tp);
  assert.equal(a[0].type, 'agent');
  assert.equal(a[0].desc, '');
  assert.deepEqual(agents.activeAgents('/nope/does-not-exist.jsonl'), []);
});

test('jails the scan to the projects root (a transcript outside it -> [])', () => {
  const { tp, sub } = setup(); // sets CK_PROJECTS_DIR to this proj
  writeAgent(sub, 'inside', { agentType: 'x' }, 0);
  assert.equal(agents.activeAgents(tp).length, 1); // inside the jail -> scanned
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ckout-'));
  const otp = path.join(outside, 'sess-x.jsonl'); fs.writeFileSync(otp, '{}\n');
  const osub = path.join(outside, 'sess-x', 'subagents'); fs.mkdirSync(osub, { recursive: true });
  writeAgent(osub, 'ext', { agentType: 'x' }, 0);
  assert.deepEqual(agents.activeAgents(otp), []); // outside CK_PROJECTS_DIR -> refused even though it exists
});

test('sorts newest-first and caps at 12', () => {
  const { tp, sub } = setup();
  for (let i = 0; i < 15; i++) writeAgent(sub, 'a' + i, { agentType: 't' + i }, i * 100); // a0 newest
  const a = agents.activeAgents(tp);
  assert.equal(a.length, 12);
  assert.equal(a[0].id, 'a0'); // newest mtime first
});
