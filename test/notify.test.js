const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  Notifier,
  buildMessage,
  decideNotifications,
  loadNotifyState,
  normalizeConfig,
  saveNotifyState,
} = require('../notify.js');

const BASE = 1_700_000_000_000;
const config = { enabled: true, slackChannelId: 'C123', delaySec: 20, cooldownMin: 15, url: 'http://localhost:3847/m' };
const waiting = (extra = {}) => ({ sessionId: 's1', state: 'needs_you', chatAlive: true, chatName: 'chat-one', purposeTitle: 'Approve release', pending: { title: 'Should I deploy?' }, ...extra });

test('notify config defaults are enabled, delayed, cooled down, and linked to mobile', () => {
  assert.deepEqual(normalizeConfig({}), {
    enabled: true,
    slackChannelId: '',
    delaySec: 20,
    cooldownMin: 15,
    url: 'http://localhost:3847/m',
  });
});

test('decideNotifications waits for the delay and deduplicates one needs-you episode', () => {
  const first = decideNotifications([waiting()], {}, config, BASE);
  assert.deepEqual(first.notifications, []);
  assert.equal(first.nextState.sessions.s1.firstSeenAt, BASE);

  const early = decideNotifications([waiting()], first.nextState, config, BASE + 19_999);
  assert.deepEqual(early.notifications, []);

  const due = decideNotifications([waiting()], early.nextState, config, BASE + 20_000);
  assert.equal(due.notifications.length, 1);
  assert.equal(due.nextState.sessions.s1.lastNotifiedAt, BASE + 20_000);

  const duplicate = decideNotifications([waiting()], due.nextState, config, BASE + 60_000);
  assert.deepEqual(duplicate.notifications, []);
});

test('decideNotifications clears an episode on recovery and honors cooldown before re-notifying', () => {
  let result = decideNotifications([waiting()], {}, config, BASE);
  result = decideNotifications([waiting()], result.nextState, config, BASE + 20_000);
  result = decideNotifications([waiting({ state: 'running' })], result.nextState, config, BASE + 30_000);
  assert.equal(result.nextState.sessions.s1.firstSeenAt, undefined);

  result = decideNotifications([waiting()], result.nextState, config, BASE + 40_000);
  result = decideNotifications([waiting()], result.nextState, config, BASE + 60_000);
  assert.deepEqual(result.notifications, [], 'cooldown blocks a new episode');

  result = decideNotifications([waiting()], result.nextState, config, BASE + 20_000 + 15 * 60_000);
  assert.equal(result.notifications.length, 1, 'continuous episode fires once cooldown expires');
});

test('decideNotifications ignores ended/dead sessions, clears missing episodes, and obeys kill switch', () => {
  const tracked = decideNotifications([waiting()], {}, config, BASE).nextState;
  for (const session of [waiting({ state: 'ended' }), waiting({ chatAlive: false })]) {
    const result = decideNotifications([session], tracked, config, BASE + 30_000);
    assert.deepEqual(result.notifications, []);
    assert.equal(result.nextState.sessions.s1.firstSeenAt, undefined);
  }
  // an absent session with no notification history has no cooldown to honor — pruned entirely
  const missing = decideNotifications([], tracked, config, BASE + 30_000);
  assert.equal(missing.nextState.sessions.s1, undefined);
  const disabled = decideNotifications([waiting()], tracked, { ...config, enabled: false }, BASE + 30_000);
  assert.deepEqual(disabled.notifications, []);
  assert.equal(disabled.nextState.idleReason, 'disabled');
  assert.equal(disabled.nextState.sessions.s1.firstSeenAt, undefined);
});

test('notify state atomically round-trips and malformed state loads empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { sessions: { s1: { firstSeenAt: BASE } }, lastSentAt: BASE };
  saveNotifyState(dir, state);
  assert.deepEqual(loadNotifyState(dir), state);
  assert.equal(fs.existsSync(path.join(dir, 'notify-state.json.tmp')), false);
  fs.writeFileSync(path.join(dir, 'notify-state.json'), '{bad');
  assert.deepEqual(loadNotifyState(dir), {});
});

test('buildMessage sanitizes and truncates the prompt line', () => {
  const prompt = `first\nsecond\t${'x'.repeat(200)}`;
  const message = buildMessage(waiting({ pending: { title: prompt } }), config);
  const lines = message.split('\n');
  assert.equal(lines[0], '🔴 Needs you: Approve release');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].length <= 140);
  assert.match(lines[1], /^first second x+/);
  assert.match(lines[1], /…$/);
  assert.equal(lines[2], 'http://localhost:3847/m');
});

test('Notifier uses injected Slack transport and records success without network', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.slack-bot-token'), 'xoxb-test');
  const posts = [];
  let clock = BASE;
  const notifier = new Notifier({ stateDir: dir, now: () => clock, postSlack: async payload => { posts.push(payload); return { ok: true }; } });
  await notifier.tick([waiting()], config);
  clock += 20_000;
  await notifier.tick([waiting()], config);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C123');
  assert.equal(posts[0].token, 'xoxb-test');
  const status = notifier.getStatus(config);
  assert.equal(status.lastSentAt, clock);
  assert.equal(status.lastError, null);
});

test('Notifier records idle reasons and consumes a failed natural trigger', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-idle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = BASE;
  const notifier = new Notifier({ stateDir: dir, now: () => clock, postSlack: async () => ({ ok: false, error: 'channel_not_found' }) });
  await notifier.tick([waiting()], config);
  assert.equal(notifier.getStatus(config).idleReason, 'missing-token');

  fs.writeFileSync(path.join(dir, '.slack-bot-token'), 'xoxb-test');
  await notifier.tick([waiting()], { ...config, slackChannelId: '' });
  assert.equal(notifier.getStatus({ ...config, slackChannelId: '' }).idleReason, 'missing-channel');

  await notifier.tick([waiting()], config);
  clock += 20_000;
  await notifier.tick([waiting()], config);
  assert.equal(notifier.getStatus(config).lastError, 'channel_not_found');
  clock += 30_000;
  await notifier.tick([waiting()], config);
  assert.equal(notifier.getStatus(config).lastError, 'channel_not_found', 'same episode is not retried');
});

test('/live contains a developer-only notifier status line', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'live.html'), 'utf8');
  assert.match(html, /class="sub dev-only" id="notifyStatus"/);
  assert.match(html, /fetch\('\/api\/notify'\)/);
  assert.match(html, /Notifier: \$\{mode\}.*last sent \$\{sent\}.*last error \$\{error\}/);
});

test('a new needs-you episode between ticks (needsYou.at changed) notifies again after cooldown; escaping + pruning hold', () => {
  const cfg = { enabled: true, slackChannelId: 'C1', delaySec: 0, cooldownMin: 15 };
  const s = (at) => [{ sessionId: 'a', state: 'needs_you', chatAlive: true, needsYou: { at }, purposeTitle: 'T', lastPrompt: 'p' }];
  const t0 = 1000000;
  const r1 = decideNotifications(s(1), {}, cfg, t0);
  assert.equal(r1.notifications.length, 1);
  // same episode next tick: no repeat
  assert.equal(decideNotifications(s(1), r1.nextState, cfg, t0 + 30000).notifications.length, 0);
  // answered + NEW question between ticks (at changed) but inside cooldown: suppressed by cooldown
  const r2 = decideNotifications(s(2), r1.nextState, cfg, t0 + 60000);
  assert.equal(r2.notifications.length, 0);
  // ...and after cooldown the new episode DOES notify (episodeKey reset works)
  const r3 = decideNotifications(s(3), r2.nextState, cfg, t0 + 16 * 60 * 1000);
  assert.equal(r3.notifications.length, 1);
  // pruning: absent session far outside 10x cooldown is dropped
  const r4 = decideNotifications([], r3.nextState, cfg, t0 + 200 * 60 * 1000);
  assert.ok(!r4.nextState.sessions.a);
  // Slack escaping
  const msg = buildMessage({ purposeTitle: '<!channel> & co', lastPrompt: 'hi <@U123>' }, cfg);
  assert.ok(msg.includes('&lt;!channel&gt; &amp; co') && msg.includes('&lt;@U123&gt;'));
});
