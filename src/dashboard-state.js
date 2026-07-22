'use strict';

const STALE_TASK_MS = 24 * 60 * 60 * 1000;
const SESSION_FRESH_MS = 10 * 60 * 1000;

function eventTime(event) {
  const value = Number(event && event.timestamp);
  return Number.isFinite(value) ? value : 0;
}

function reduceTasks(events) {
  const tasks = new Map();
  const signatureBySession = new Map();
  const createsBySession = new Map();
  const idsBySession = new Map();

  // TaskCreate hook payloads do not contain Claude's numeric task id. Infer the
  // captured range from TaskUpdate ids first; logs can begin after Tasks 1–2.
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.sessionId) continue;
    const sid = String(event.sessionId);
    if (event.type === 'task_update' && event.taskId != null && /^\d+$/.test(String(event.taskId))) {
      if (!idsBySession.has(sid)) idsBySession.set(sid, []);
      idsBySession.get(sid).push(Number(event.taskId));
    }
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.sessionId) continue;
    const sessionId = String(event.sessionId);
    if (event.type === 'task_create' && event.task) {
      let signatures = signatureBySession.get(sessionId);
      if (!signatures) signatureBySession.set(sessionId, signatures = new Map());
      const signature = [event.task, event.description || '', event.agent || ''].join('\0');
      let key = signatures.get(signature);
      if (!key) {
        const ordinal = (createsBySession.get(sessionId) || 0) + 1;
        createsBySession.set(sessionId, ordinal);
        const observed = idsBySession.get(sessionId) || [];
        const firstId = observed.length ? Math.min(...observed) : 1;
        const taskId = firstId + ordinal - 1;
        key = `${sessionId}:${taskId}`;
        signatures.set(signature, key);
        tasks.set(key, {
          ...event,
          key,
          taskId: String(taskId),
          status: 'in_progress',
          createdAt: eventTime(event),
          lastEventAt: eventTime(event),
        });
      } else {
        const task = tasks.get(key);
        if (task) task.lastEventAt = Math.max(task.lastEventAt, eventTime(event));
      }
      continue;
    }
    if (event.type !== 'task_update') continue;
    const key = event.taskKey || (event.taskId != null ? `${sessionId}:${event.taskId}` : '');
    const task = tasks.get(key);
    if (!task) continue;
    if (['in_progress', 'completed', 'abandoned'].includes(event.status)) task.status = event.status;
    task.lastEventAt = Math.max(task.lastEventAt, eventTime(event));
    if (event.status === 'completed') task.completedAt = eventTime(event);
    if (event.status === 'abandoned') task.abandonedAt = eventTime(event);
  }
  return [...tasks.values()];
}

function isSessionLive(session, now = Date.now()) {
  if (!session || ['ended', 'dead'].includes(session.state)) return false;
  if (session.live === true || session.chatAlive === true) return true;
  const last = Number(session.lastActivityAt || session.lastActivity || 0);
  return last > 0 && now - last <= SESSION_FRESH_MS;
}

function classifyTasks(tasks, sessions, now = Date.now()) {
  const liveSessions = new Set((Array.isArray(sessions) ? sessions : [])
    .filter(s => s && s.sessionId && isSessionLive(s, now))
    .map(s => String(s.sessionId)));
  return (Array.isArray(tasks) ? tasks : []).map(task => {
    let displayState = task.status;
    if (task.status === 'in_progress') {
      const old = now - Number(task.lastEventAt || task.createdAt || 0) > STALE_TASK_MS;
      displayState = !liveSessions.has(String(task.sessionId)) || old ? 'stale' : 'live';
    }
    return { ...task, stale: displayState === 'stale', live: displayState === 'live', displayState };
  });
}

function relativeTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - Number(timestamp || now));
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(elapsed / 60000);
  if (elapsed <= 60 * 60 * 1000) return `${minutes}m ago`;
  const hours = Math.round(elapsed / (60 * 60 * 1000));
  if (elapsed <= 48 * 60 * 60 * 1000) return `${hours}h ago`;
  const days = Math.round(elapsed / (24 * 60 * 60 * 1000));
  if (elapsed <= 14 * 24 * 60 * 60 * 1000) return `${days}d ago`;
  return `${Math.round(elapsed / (7 * 24 * 60 * 60 * 1000))}w ago`;
}

module.exports = { STALE_TASK_MS, SESSION_FRESH_MS, reduceTasks, isSessionLive, classifyTasks, relativeTime };
