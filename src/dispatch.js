// src/dispatch.js — the overnight dispatch loop. Sibling to autowrap.js: injectable, fail-soft, local state.
// Execution model (fixed after §4 panel BLOCK): tick() is ASYNC. The real deps createChat + checkCompletion
// are asynchronous (createChat calls back from a tmux-readiness poll; checkCompletion spawns gh). We therefore
// await every side effect and persist state ONCE at the end of the tick — a synchronous end-of-tick save would
// run before those callbacks and silently drop every mutation (→ runaway re-dispatch). A module-level
// re-entrancy guard prevents two ticks from overlapping on the state file.
'use strict';
const fs = require('fs');
const path = require('path');
const { isEligible } = require('./dispatch/eligibility.js');

const DEFAULTS = { enabled: false, concurrency: 1, dryRun: false, caps: { stopStartingAfter: '05:00', eveningResumeAfter: '18:00', nightlyTokenCeiling: null }, slackChannelId: '', slackTriggerUserIds: [] };

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function configFile() { return path.join(stateDir(), 'config.json'); }
function _stateFile() { return path.join(stateDir(), 'dispatch-state.json'); }
function _queueFile() { return path.join(stateDir(), 'dispatch-queue.json'); }

// Strict "HH:MM" (00:00-23:59) → minutes, else null. Rejects "", "25:99", garbage.
function parseHM(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function readConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')).dispatch || {}; } catch (e) {}
  const caps = (raw.caps && typeof raw.caps === 'object' && !Array.isArray(raw.caps)) ? raw.caps : {};
  // An empty/invalid cutoff must NOT silently disable the hard cap — fall back to the default. (panel MINOR)
  const stopStartingAfter = parseHM(caps.stopStartingAfter) != null ? caps.stopStartingAfter : DEFAULTS.caps.stopStartingAfter;
  const eveningResumeAfter = parseHM(caps.eveningResumeAfter) != null ? caps.eveningResumeAfter : DEFAULTS.caps.eveningResumeAfter;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    concurrency: Number.isInteger(raw.concurrency) && raw.concurrency > 0 ? raw.concurrency : DEFAULTS.concurrency,
    dryRun: typeof raw.dryRun === 'boolean' ? raw.dryRun : DEFAULTS.dryRun,
    caps: {
      stopStartingAfter,
      eveningResumeAfter,
      nightlyTokenCeiling: typeof caps.nightlyTokenCeiling === 'number' ? caps.nightlyTokenCeiling : null,
    },
    slackChannelId: typeof raw.slackChannelId === 'string' ? raw.slackChannelId : '',
    slackTriggerUserIds: Array.isArray(raw.slackTriggerUserIds) ? raw.slackTriggerUserIds : [],
  };
}
function loadState() { try { const v = JSON.parse(fs.readFileSync(_stateFile(), 'utf8')); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (e) { return {}; } }
function saveState(v) {
  try { const f = _stateFile(); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); }
  catch (e) { try { fs.appendFileSync(path.join(stateDir(), 'error.log'), new Date().toISOString() + ' dispatch saveState ' + ((e && e.message) || e) + '\n'); } catch (_) {} }
}
function loadQueue() { try { const v = JSON.parse(fs.readFileSync(_queueFile(), 'utf8')); return Array.isArray(v.tasks) ? v.tasks : []; } catch (e) { return []; } }

function dispatchBriefLine(state) {
  const runs = state && state.runs && typeof state.runs === 'object' ? Object.values(state.runs) : [];
  if (!runs.length) return '';
  const done = runs.filter(r => r && r.phase === 'done').length;
  const stuck = runs.filter(r => r && r.phase === 'stuck').length;
  const failed = runs.filter(r => r && r.phase === 'failed').length;
  return `🌙 dispatch: ${done} PR-ready, ${stuck} needs-you, ${failed} failed`;
}

// The overnight dispatch window WRAPS past midnight, so a single "past HH:MM" lower-bound is wrong: it would
// treat 23:00 as "past 05:00" and refuse an evening trigger. Instead we cap only during the DAYTIME slot
// [stopStartingAfter, eveningResumeAfter) (default 05:00-18:00) — outside that (evening + overnight) we dispatch.
function pastCutoff(cutoff, clock, eveningResume) {
  const cut = parseHM(cutoff); if (cut == null) return false;
  const ev = parseHM(eveningResume); const evMin = ev == null ? 18 * 60 : ev;
  const d = new Date(clock);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  if (evMin <= cut) return nowMin >= cut;           // degenerate config: fall back to a simple lower bound
  return nowMin >= cut && nowMin < evMin;           // capped only during the daytime slot
}

function realDeps() {
  const chats = require('./chats.js');
  const completion = require('./dispatch/completion.js');
  const watchers = require('./watchers.js');
  return {
    createChat: chats.createChat,
    killChat: chats.killChat,
    checkCompletion: (task, cb) => completion.checkCompletion(task, {}, cb),
    notify: watchers.notify,
    now: Date.now,
  };
}

function slugBranch(task) {
  const slug = String(task.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return 'auto/' + task.id + (slug ? '-' + slug : '');
}

let _ticking = false;   // re-entrancy guard: never let two ticks race on dispatch-state.json

async function tick(sessions, deps, now) {
  const config = readConfig();
  if (!config.enabled) return loadState();
  if (_ticking) return loadState();
  _ticking = true;
  try {
    const io = deps || realDeps();
    const clock = typeof now === 'number' ? now : (io.now ? io.now() : Date.now());
    const state = loadState();
    if (!state.runs) state.runs = {};

    const check = (t) => new Promise(res => { try { io.checkCompletion(t, (_e, r) => res(r || { state: 'error' })); } catch (e) { res({ state: 'error' }); } });
    const spawn = (opts) => new Promise(res => { try { io.createChat(opts, (err, chat) => res({ err, chat })); } catch (e) { res({ err: e }); } });

    // 1) Advance running tasks by GROUND TRUTH (PR + CI). Await every completion check, THEN we save below.
    const live = Array.isArray(sessions) ? sessions : [];
    await Promise.all(Object.keys(state.runs).map(async id => {
      const run = state.runs[id];
      if (run.phase !== 'running') return;
      const sess = live.find(s => s && s.chatName === run.chatName);
      const r = await check({ id, repo: run.repo, branch: run.branch });
      let next = null;
      if (r.state === 'green') { next = 'done'; run.pr = r.pr; }
      else if (r.state === 'error') next = null;                     // gh unreachable → HOLD prior state (never guess)
      else if (r.state === 'red') next = 'stuck';                    // PR exists but CI red
      else if (r.state === 'none' && sess && sess.state === 'ended') next = 'failed';  // ended, never opened a PR
      else if (r.state === 'none' && !sess) next = 'stuck';          // session gone, no PR
      // r.state === 'pending' (CI running) or 'none' with a live session → keep waiting (next stays null)
      if (next && run.phase !== next) {
        run.phase = next; run.finishedAt = clock;
        const emoji = next === 'done' ? '✅' : next === 'failed' ? '❌' : '⚠️';
        io.notify(`${emoji} dispatch ${id} → ${next}${run.pr ? ` (PR #${run.pr})` : ''} · ${run.repo}`, () => {});
      }
    }));

    // 2) Start new work — allowlist-gated, concurrency-capped, respecting the wall-clock window.
    const capped = pastCutoff(config.caps.stopStartingAfter, clock, config.caps.eveningResumeAfter);
    const candidates = loadQueue();
    const plan = [];
    for (const task of candidates) {
      if (state.runs[task.id]) continue;                            // already dispatched this run
      // Recompute live count/cwds each iteration so a just-reserved spawn counts toward the cap.
      const active = Object.values(state.runs).filter(r => r.phase === 'running' || r.phase === 'spawning');
      const decision = isEligible(task, { runningCwds: new Set(active.map(r => r.cwd)), runningCount: active.length, config });
      plan.push({ id: task.id, ok: decision.ok, reason: decision.reason });
      if (!decision.ok) continue;
      if (capped) continue;                                         // eligible but the wall-clock window says hold
      if (config.dryRun) continue;                                  // dry-run: record the plan only — no reserve, no throttle

      const branch = slugBranch(task);
      // Reserve the slot SYNCHRONOUSLY before the async spawn so the next tick's dedup + the cap see it
      // immediately (fixes the runaway-spawn blocker). Roll back if the spawn fails or is mis-profiled.
      state.runs[task.id] = { phase: 'spawning', repo: task.repo, cwd: task.cwd, branch, startedAt: clock };
      const { err, chat } = await spawn({
        title: 'dispatch ' + task.id,
        prompt: buildDispatchPrompt(task, branch),
        model: 'sonnet', effort: 'high',
        profile: 'dispatch', cwd: task.cwd, repo: task.repo, branch,
      });
      if (err || !chat) { delete state.runs[task.id]; io.notify(`❌ dispatch ${task.id} failed to spawn: ${(err && err.message) || 'no chat'}`, () => {}); continue; }
      // FAIL-CLOSED: a session that did not come up under the locked 'dispatch' profile (e.g. before Task 4
      // adds it, createChat coerces the profile) must never run unattended. Kill it and refuse. (panel MAJOR)
      if (chat.profile !== 'dispatch') {
        try { if (io.killChat) io.killChat(chat.name); } catch (e) {}
        delete state.runs[task.id];
        io.notify(`❌ dispatch ${task.id} refused: session came up as '${chat.profile}', not the locked dispatch profile`, () => {});
        continue;
      }
      state.runs[task.id].phase = 'running';
      state.runs[task.id].chatName = chat.name;
    }
    if (config.dryRun) { state.dryRunPlan = plan; state.dryRunAt = clock; }

    saveState(state);        // single write at the end of the awaited tick → no intra-tick read-modify-write race
    return state;
  } finally { _ticking = false; }
}

// The dispatched session is steered entirely by this prompt — no new framework, just the existing spawn path.
function buildDispatchPrompt(task, branch) {
  return [
    `You are an autonomous overnight dispatch worker. Task: ${task.title} (id ${task.id}).`,
    `Work in this repo on a NEW branch \`${branch}\` (create it). Run the full loop: plan → implement → Codex handoff → 3-way review panel → verify.`,
    `When the work is ready, open a PR from \`${branch}\` with \`gh pr create\` (base = the repo's default branch). Do NOT merge, deploy, push to protected branches, or touch secrets — those are denied and are the human's job.`,
    `If you cannot finish or the reviews degrade, STOP and leave a clear PR description of where you got to. Never force anything.`,
  ].join('\n');
}

module.exports = { tick, readConfig, loadState, loadQueue, dispatchBriefLine, _stateFile, _queueFile, pastCutoff, parseHM, slugBranch, buildDispatchPrompt };
