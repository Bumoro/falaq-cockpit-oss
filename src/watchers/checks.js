// watchers/checks.js — concrete watcher checks (gh + gmailx), async spawn only.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function stateDir() { return process.env.COCKPIT_DIR || path.join(__dirname, '..'); }
function cfg() {
  const p = process.env.CK_WATCHER_CONFIG || path.join(__dirname, 'watcher-config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
// cb(out, meta) — meta.ok is true ONLY when the subprocess ran to a clean exit 0 (no spawn
// failure, no error event, no signal/timeout). Existing callers that ignore meta keep working.
function run(bin, args, cb) {
  let out = '', errOut = '', done = false, timer;
  const fin = (v, meta) => { if (!done) { done = true; if (timer) clearTimeout(timer); cb(v, meta || { ok: v != null, code: null, err: '' }); } };
  let p; try { p = spawn(bin, args); } catch (e) { return fin(null, { ok: false, code: null, err: 'spawn:' + ((e && (e.code || e.message)) || 'fail') }); }
  timer = setTimeout(() => { try { p.kill(); } catch (e) {} fin(null, { ok: false, code: null, err: 'timeout' }); }, 45000);
  timer.unref();
  p.stdout.on('data', d => { out += d; });
  if (p.stderr) p.stderr.on('data', d => { errOut += d; });
  p.on('error', () => fin(null, { ok: false, code: null, err: 'proc-error' }));
  p.on('close', (code, signal) => fin(out, { ok: code === 0 && !signal, code, err: signal ? 'signal:' + signal : (code ? 'exit:' + code : errOut.slice(0, 160)) }));
}
function gh(args, cb) { run(process.env.CK_GH_CMD || 'gh', args, cb); }
function gmailx(args, cb) { run(process.env.CK_GMAILX_CMD || 'gmailx', args, cb); }
function shortHash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8); }

function ciCheck(repos) {
  return (cb) => {
    const results = [];
    let anyErr = false;
    let pending = repos.length;
    if (!pending) return cb(null, { state: 'none', summary: 'no repos configured' });
    repos.forEach(repo => {
      gh(['pr', 'list', '-R', repo, '--state', 'open', '--json', 'number,title,statusCheckRollup'], (out, meta) => {
        if (meta && meta.ok === false) anyErr = true;
        let prs = []; try { prs = JSON.parse(out || '[]'); } catch (e) {}
        for (const pr of prs) {
          const roll = pr.statusCheckRollup || [];
          // CheckRun failing conclusions + legacy StatusContext failing states — any of these is a real failure,
          // never let one slip to 'green'. FAILURE/TIMED_OUT/CANCELLED/STARTUP_FAILURE/ACTION_REQUIRED cover the CheckRun set.
          const FAIL_CONCL = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
          const PEND_STATUS = ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'];
          const fail = roll.some(c => FAIL_CONCL.indexOf(c.conclusion) >= 0 || c.state === 'FAILURE' || c.state === 'ERROR');
          const pend = roll.some(c => PEND_STATUS.indexOf(c.status) >= 0 || c.state === 'PENDING' || (!c.conclusion && !c.status && !c.state));
          results.push({ repo, number: pr.number, s: fail ? 'red' : pend ? 'pending' : 'green' });
        }
        if (--pending === 0) {
          const red = results.filter(r => r.s === 'red');
          const pendc = results.filter(r => r.s === 'pending');
          // If a `gh` call failed and nothing actionable was found, an empty result is a FALSE all-clear.
          // Report `error` so the runner keeps the prior state instead of flapping green/none -> back.
          // (A real red/pending we *did* observe still wins — surface it despite the partial failure.)
          if (anyErr && !red.length && !pendc.length) {
            return cb(null, { state: 'error', error: true, summary: `gh unavailable (${repos.length} repo(s))`, detail: results.map(r => `${r.repo}#${r.number}:${r.s}`).join(', ') });
          }
          const state = red.length ? 'red' : pendc.length ? 'pending' : results.length ? 'green' : 'none';
          const summary = results.length
            ? `${results.length} open PR(s) across ${repos.length} repo(s): ${red.length} red, ${pendc.length} pending`
            : `no open PRs in ${repos.length} repo(s)`;
          cb(null, { state, summary, detail: results.map(r => `${r.repo}#${r.number}:${r.s}`).join(', ') });
        }
      });
    });
  };
}

function deployShaCheck(conf) {
  return (cb) => {
    if (!conf || conf.enabled === false) return cb(null, { state: 'unknown', summary: 'deploy-sha check disabled' });
    // conf: { repo, branch, runningShaCmd? } — compare HEAD of branch vs the deployed sha.
    gh(['api', `repos/${conf.repo}/commits/${conf.branch || 'HEAD'}`, '--jq', '.sha'], (headOut, meta) => {
      // A failed `gh api` (auth/network) is not "no drift" — surface error so the runner holds prior state.
      if (meta && meta.ok === false) return cb(null, { state: 'error', error: true, summary: 'gh api failed', detail: `${conf.repo}@${conf.branch}` });
      const head = String(headOut || '').trim().slice(0, 40);
      // running sha source: a workflow-artifact or a documented command; conf.runningSha holds a literal or 'gh ...' resolved elsewhere.
      const running = String(conf.runningSha || '').trim().slice(0, 40);
      if (!head || !running) return cb(null, { state: 'unknown', summary: 'sha unavailable (needs runningSha source)' });
      const match = head.slice(0, 12) === running.slice(0, 12);
      cb(null, { state: match ? 'green' : 'red', summary: match ? 'deploy == HEAD' : `DRIFT: running ${running.slice(0,7)} != HEAD ${head.slice(0,7)}`, detail: `${conf.repo}@${conf.branch}` });
    });
  };
}

function emailCheck(name, conf) {
  return (cb) => {
    // Real gmailx signature: `gmailx search <alias> <query> [--max N]`. Each result renders as
    //   <messageId>  <date>
    //     From: ...
    //     Subj: <subject>
    // so the id is the leading hex token of the first result line and the subject is its "Subj:" line.
    const acct = conf.account || 'personal';
    gmailx(['search', acct, conf.query, '--max', '10'], (out, meta) => {
      // A failed gmailx (spawn/exit/timeout — e.g. an expired token or a restart-time blip) is NOT
      // "no mail". Surface it as `error` so the runner keeps the last known state sticky instead of
      // flapping to none. Only a clean exit-0 with no results is a genuine `none`.
      if (!meta || !meta.ok) return cb(null, { state: 'error', error: true, summary: `gmailx failed (${name})`, detail: (meta && meta.err) || 'error' });
      const text = String(out || '');
      // Collect ALL matching message ids (each result line starts "<hexid>  <date>"), de-dupe and SORT,
      // then hash the whole set. gmailx result ordering is NOT stable, so keying off "the first id"
      // flapped between two real hashes (seen live: salla 27c4d87d <-> 735c95c8). A sorted-set hash is
      // stable under reordering and changes only when the matching set actually changes. `ids` lets the
      // runner fire on genuinely-new mail only (monotonic) — never on reordering or mail aging out.
      const ids = Array.from(new Set(text.match(/^[0-9a-f]{12,}(?=\s)/gm) || [])).sort();
      const subject = (text.match(/^\s*Subj:\s*(.+)$/m) || [])[1] || '';
      if (!ids.length) return cb(null, { state: 'none', ids: [], summary: `no matching mail (${name})`, detail: conf.query });
      cb(null, { state: shortHash(ids.join(',')), ids, summary: subject.trim().slice(0, 120) || `new mail (${name})`, detail: conf.query });
    });
  };
}

function buildChecks() {
  const c = cfg();
  const checks = [];
  if (c.ci && Array.isArray(c.ci.repos)) checks.push({ name: 'ci', check: ciCheck(c.ci.repos) });
  if (c.deploySha) checks.push({ name: 'deploy-sha', check: deployShaCheck(c.deploySha) });
  const email = c.email || {};
  // email watchers are `sticky`: once a real hash is seen, the runner never downgrades it to none.
  for (const name of Object.keys(email)) checks.push({ name, check: emailCheck(name, email[name]), sticky: true });
  return checks;
}

module.exports = { buildChecks };
