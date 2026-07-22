// src/dispatch/completion.js — "done" = a PR exists for the task branch AND its checks are all green.
'use strict';
const FAIL_CONCL = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
const PEND_STATUS = ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'];

function realGh() {
  const { spawn } = require('child_process');
  return (args, cb) => {
    let out = '', done = false;
    let p; try { p = spawn(process.env.CK_GH_CMD || 'gh', args); } catch (e) { return cb('', { ok: false }); }
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} if (!done) { done = true; cb('', { ok: false }); } }, 45000); t.unref();
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => { if (!done) { done = true; clearTimeout(t); cb('', { ok: false }); } });
    p.on('close', (code, sig) => { if (!done) { done = true; clearTimeout(t); cb(out, { ok: code === 0 && !sig }); } });
  };
}

function checkCompletion(task, deps, cb) {
  const gh = (deps && deps.gh) || realGh();
  const repo = task.repo, head = task.branch;
  gh(['pr', 'list', '-R', repo, '--head', head, '--state', 'open', '--json', 'number,statusCheckRollup'], (out, meta) => {
    if (meta && meta.ok === false) return cb(null, { state: 'error', detail: `gh pr list failed (${repo}#${head})` });
    let prs = []; try { prs = JSON.parse(out || '[]'); } catch (e) { return cb(null, { state: 'error', detail: 'unparseable gh output' }); }
    if (!prs.length) return cb(null, { state: 'none', detail: `no open PR on ${head}` });
    const pr = prs[0] || {};
    // Harden the rollup to a clean array of objects. A malformed truthy value (gh anomaly: `{}`, a string,
    // or a null element) must fail CLOSED to 'pending', never throw — a throw here is inside the gh callback,
    // so the completion promise would never resolve and `tick` would hang forever (dispatch freeze). (panel/verify)
    const roll = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []).filter(c => c && typeof c === 'object');
    const fail = roll.some(c => FAIL_CONCL.indexOf(c.conclusion) >= 0 || c.state === 'FAILURE' || c.state === 'ERROR');
    const pend = roll.some(c => PEND_STATUS.indexOf(c.status) >= 0 || c.state === 'PENDING' || c.state === 'EXPECTED' || (!c.conclusion && !c.status && !c.state));
    // GREEN requires ≥1 check AND every check affirmatively successful. An empty rollup (a repo with no CI,
    // or the seconds-long race right after `gh pr create` before checks register) or any unknown status is
    // NOT green — it is 'pending'. "not-fail-and-not-pend ⇒ green" was a false PR-ready in the lowest-vigilance
    // morning batch, and a run flipped to done is never re-checked, so it would lock permanently. (panel BLOCKER)
    const green = roll.length > 0 && !fail && !pend &&
      roll.every(c => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED' || c.state === 'SUCCESS');
    const state = fail ? 'red' : pend ? 'pending' : green ? 'green' : 'pending';
    cb(null, { state, pr: pr.number, detail: `${repo}#${pr.number}:${state}` });
  });
}

module.exports = { checkCompletion };
