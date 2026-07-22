const { test } = require('node:test');
const assert = require('node:assert');

const state = require('../dashboard-state.js');

test('reduceTasks deduplicates repeated creates and applies session-local updates', () => {
  const events = [
    { type: 'task_create', task: 'Fix login', sessionId: 's1', timestamp: 100 },
    { type: 'task_create', task: 'Ship docs', sessionId: 's1', timestamp: 110 },
    { type: 'task_create', task: 'Fix login', sessionId: 's1', timestamp: 120 },
    { type: 'task_update', taskId: '1', status: 'completed', sessionId: 's1', timestamp: 130 },
  ];
  const tasks = state.reduceTasks(events);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].key, 's1:1');
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].lastEventAt, 130);
  assert.equal(tasks[1].key, 's1:2');
});

test('reduceTasks aligns captured creates when the event log begins at a later task id', () => {
  const events = [
    { type: 'task_create', task: 'Publish posts', sessionId: 's1', timestamp: 100 },
    { type: 'task_create', task: 'Publish posts', sessionId: 's1', timestamp: 101 },
    { type: 'task_update', taskId: '3', status: 'completed', sessionId: 's1', timestamp: 110 },
    { type: 'task_create', task: 'Add images', sessionId: 's1', timestamp: 120 },
    { type: 'task_update', taskId: '4', status: 'in_progress', sessionId: 's1', timestamp: 130 },
  ];
  const tasks = state.reduceTasks(events);
  assert.deepEqual(tasks.map(t => [t.key, t.status]), [['s1:3', 'completed'], ['s1:4', 'in_progress']]);
});

test('classifyTasks marks old or orphaned in-progress tasks stale without mutating status', () => {
  const now = 30 * 60 * 60 * 1000;
  const tasks = [
    { key: 'live', sessionId: 's1', status: 'in_progress', lastEventAt: now - 1000 },
    { key: 'old', sessionId: 's1', status: 'in_progress', lastEventAt: now - 25 * 60 * 60 * 1000 },
    { key: 'orphan', sessionId: 'gone', status: 'in_progress', lastEventAt: now - 1000 },
    { key: 'done', sessionId: 's1', status: 'completed', lastEventAt: now - 1000 },
  ];
  const out = state.classifyTasks(tasks, [{ sessionId: 's1', state: 'running', lastActivityAt: now - 1000 }], now);
  assert.deepEqual(out.map(t => [t.key, t.displayState]), [
    ['live', 'live'], ['old', 'stale'], ['orphan', 'stale'], ['done', 'completed'],
  ]);
  assert.equal(tasks[1].status, 'in_progress');
});

test('session liveness accepts controlled idle chats but rejects crashed orphan state files', () => {
  const now = Date.now();
  assert.equal(state.isSessionLive({ state: 'idle', chatAlive: true }, now), true);
  assert.equal(state.isSessionLive({ state: 'running', lastActivityAt: now - 11 * 60 * 1000 }, now), false);
  assert.equal(state.isSessionLive({ state: 'needs_you', lastActivityAt: now - 1000 }, now), true);
  assert.equal(state.isSessionLive({ state: 'ended', chatAlive: true }, now), false);
});

test('relativeTime uses days after 48 hours and weeks after 14 days', () => {
  const now = Date.UTC(2026, 6, 21);
  assert.equal(state.relativeTime(now - 90 * 60 * 1000, now), '2h ago');
  assert.equal(state.relativeTime(now - 49 * 60 * 60 * 1000, now), '2d ago');
  assert.equal(state.relativeTime(now - 15 * 24 * 60 * 60 * 1000, now), '2w ago');
});
