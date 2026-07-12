// watchers.js — run external-wait checks, diff vs stored state, notify Slack on change.
// Zero deps. All I/O async or fast-sync file ops; never blocks on network in the request path.
const fs = require('fs');
const path = require('path');
const https = require('https');

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function dir() { return path.join(stateDir(), 'watchers'); }
function file(name) { return path.join(dir(), name + '.json'); }
function webhookFile() { return process.env.CK_WEBHOOK_FILE || path.join(stateDir(), '.slack-webhook'); }
function enabled() {
  try { return JSON.parse(fs.readFileSync(path.join(dir(), 'watcher-config.json'), 'utf8')).enabled !== false; }
  catch (e) { return true; }
}

function load(name) { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return null; } }
function save(name, obj) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name) + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(file(name) + '.tmp', file(name));
}
function webhookUrl() { try { return fs.readFileSync(webhookFile(), 'utf8').trim() || null; } catch (e) { return null; } }

function notify(text, cb) {
  cb = cb || (() => {});
  const url = webhookUrl();
  if (!url) return cb(null, { sent: false, reason: 'no-webhook' });
  const sink = process.env.CK_HTTP_SINK;
  if (sink) { try { fs.appendFileSync(sink, JSON.stringify({ text }) + '\n'); } catch (e) {} return cb(null, { sent: true, sink: true }); }
  let u; try { u = new URL(url); } catch (e) { return cb(null, { sent: false, reason: 'bad-url' }); }
  const body = JSON.stringify({ text });
  const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 },
    (res) => { res.resume(); res.on('end', () => cb(null, { sent: res.statusCode < 300 })); });
  req.on('error', () => cb(null, { sent: false, reason: 'net' }));
  req.on('timeout', () => { req.destroy(); });
  req.end(body);
}

// Decide the effective next state from the stored record + a fresh check result. This is what
// kills the none<->hash flap that would spam Slack once the webhook is live:
//   - an error result (the check could not run) never overwrites a known state and never notifies;
//   - a `sticky` watcher (email) never downgrades a real value to a clean `none`, and never pings
//     on `none` at all — only none->value and value->value' are real signals worth a ping;
//   - every other watcher transitions and notifies exactly as before.
// `stale` marks "the latest check couldn't confirm the shown state" so a silently-broken token
// (or a transient miss) is visible in the UI without changing state or firing a notification.
function resolve(prev, result, entry) {
  const prevState = prev ? prev.state : null;
  const fresh = result.state;
  const isErr = fresh === 'error' || result.error === true;
  const sticky = !!entry.sticky;

  if (isErr) {
    const keep = !!prevState && prevState !== 'error'; // hold onto any prior meaningful value
    return { state: keep ? prevState : 'error', changed: keep ? false : (!prev || prevState !== 'error'), notify: false, stale: true, keepMeta: keep };
  }
  // Set/monotonic watcher (email): the check emits `ids` = the full sorted set of matching message
  // ids, and `state` is a hash of that whole set (stable under gmailx's unstable ordering). Fire ONLY
  // when a genuinely-new id appears — reordering (same set), a transient empty result, and mail aging
  // out of the query window never fire. State moves forward only (never downgrades a known set to none).
  // `seen` is the monotonic union of ids we've ever matched (bounded), so a departed id never re-fires.
  if (Array.isArray(result.ids)) {
    let prevSeen;
    if (prev && Array.isArray(prev.seen)) prevSeen = new Set(prev.seen);
    // Migration: a pre-`seen` record already holding a real value adopts the current ids as seen, so we
    // do not re-fire on mail we already knew about. ONE-TIME — first run after upgrade only; once `seen`
    // is written it persists even across error runs (runOne carries it forward). Accepted limitation:
    // the OLD format hashed only the first id, so we cannot reconstruct the full prior set — if a
    // brand-new message happens to arrive in that single first-cycle window it is adopted silently
    // (there is no webhook yet at migration time anyway, so no ping is lost).
    else if (prevState && prevState !== 'none' && prevState !== 'error') prevSeen = new Set(result.ids);
    else prevSeen = new Set();
    const newIds = result.ids.filter(id => !prevSeen.has(id));
    const seen = Array.from(new Set([...prevSeen, ...result.ids])).slice(-50);
    if (newIds.length) return { state: fresh, changed: true, notify: true, seen };  // genuinely new mail -> ping
    // No new mail. HOLD the last fired state + summary — never adopt the current set-hash on a no-fire
    // run, so an id aging out of the window can't churn the stored/UI hash. Only a real ping moves state.
    const holding = !!prevState && prevState !== 'none' && prevState !== 'error';
    return holding
      ? { state: prevState, changed: false, notify: false, keepMeta: true, stale: fresh === 'none', seen }
      : { state: fresh, changed: false, notify: false, seen }; // no prior real value: reflect current (fresh==='none')
  }
  if (sticky && fresh === 'none' && prevState && prevState !== 'none' && prevState !== 'error') {
    return { state: prevState, changed: false, notify: false, stale: true, keepMeta: true }; // transient miss / aged-out mail
  }
  const changed = !prev || prevState !== fresh;
  return { state: fresh, changed, notify: changed && !(sticky && fresh === 'none') };
}

function runOne(entry, cb) {
  let done = false;
  const finish = (result) => {
    if (done) return; done = true;
    if (!result || typeof result.state !== 'string') result = { state: 'error', error: true, summary: 'empty check result' };
    const prev = load(entry.name);
    const now = Date.now();
    const r = resolve(prev, result, entry);
    const summary = r.keepMeta && prev ? prev.summary : (result.summary || '');
    const detail = r.keepMeta && prev ? prev.detail : (result.detail || '');
    const rec = {
      name: entry.name,
      state: r.state,
      summary, detail,
      lastCheck: now,
      lastChange: r.changed ? now : (prev ? prev.lastChange : now),
      history: ((prev && prev.history) || []).concat(r.changed ? [{ at: now, state: r.state }] : []).slice(-20),
    };
    if (r.seen) rec.seen = r.seen; // monotonic id set for email watchers (drives new-mail-only firing)
    else if (prev && prev.seen) rec.seen = prev.seen; // MUST carry it across error/non-ids runs: dropping it
    // re-triggers the migration seed on the next success, silently marking mail that arrived during the
    // error window as already-seen (a missed notification). Never let an error erase the seen set.
    if (r.stale) { rec.stale = true; rec.lastRaw = result.state; rec.lastStaleAt = now; }
    if (r.changed && r.notify) {
      const text = `*${entry.name}* → *${r.state}* — ${summary || ''}`;
      if (webhookUrl()) {
        if (prev && prev.pendingNotify) notify(prev.pendingNotify, () => {}); // drain a still-queued arrival before the newer state
        notify(text, () => {});
      } else { rec.pendingNotify = text; }
    } else if (prev && prev.pendingNotify) {
      rec.pendingNotify = prev.pendingNotify; // keep a still-unsent arrival ping alive across sticky/error runs
    }
    try { save(entry.name, rec); } catch (e) {}
    cb({ name: entry.name, state: r.state, changed: r.changed });
  };
  try { entry.check((err, r) => finish(err ? { state: 'error', error: true, summary: String(err.message || err).slice(0, 140) } : r)); }
  catch (e) { finish({ state: 'error', error: true, summary: String(e.message || e).slice(0, 140) }); }
}

function runAll(checks, cb) {
  if (!enabled()) return cb([]);
  const out = []; let pending = checks.length;
  if (!pending) return cb([]);
  checks.forEach(entry => runOne(entry, (r) => { out.push(r); if (--pending === 0) cb(out); }));
}

function readAll() {
  try {
    return fs.readdirSync(dir())
      .filter(f => f.endsWith('.json') && f !== 'watcher-config.json')
      .map(f => {
        try { const o = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')); delete o.pendingNotify; delete o.seen; return o; } catch (e) { return null; }
      })
      // only real watcher records (config or stray files never leak into /api/watchers)
      .filter(o => o && typeof o.name === 'string' && typeof o.state === 'string');
  } catch (e) { return []; }
}

module.exports = { runAll, readAll, notify };
