// usage.js — 5h + weekly usage via ccusage, spawned async, cached to disk.
// The request path only ever calls readCache() (sync, fast). refresh() is
// driven by the server on an interval so ccusage never blocks a response.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function cacheFile() { return path.join(stateDir(), 'usage-cache.json'); }

function runJson(sub, cb) {
  const stub = process.env.CK_CCUSAGE_CMD;
  const bin = stub || 'npx';
  const args = stub ? [sub, '--json'] : ['--yes', 'ccusage@latest', sub, '--json'];
  if (sub === 'blocks') args.splice(stub ? 1 : 3, 0, '--active');
  let out = '', done = false, timer;
  const finish = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); cb(v); } };
  let p;
  try { p = spawn(bin, args); } catch (e) { return finish(null); }
  timer = setTimeout(() => { try { p.kill(); } catch (e) {} finish(null); }, 90000);
  timer.unref();
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => finish(null));
  p.on('close', () => { try { finish(JSON.parse(out)); } catch (e) { finish(null); } });
}

function refresh(cb) {
  const res = { generatedAt: Date.now(), block: null, week: null };
  let pending = 2;
  const done = () => {
    if (--pending) return;
    try {
      fs.writeFileSync(cacheFile() + '.tmp', JSON.stringify(res));
      fs.renameSync(cacheFile() + '.tmp', cacheFile());
    } catch (e) {}
    if (cb) cb(res);
  };
  runJson('blocks', (o) => { res.block = o ? ((o.blocks || []).find(b => b.isActive) || (o.blocks || [])[0] || null) : null; done(); });
  runJson('weekly', (o) => { const a = o ? (o.weekly || o.data || []) : []; res.week = a[a.length - 1] || null; done(); });
}

// Like refresh(), but a failed fetch (null block/week) preserves the last
// known-good cached value instead of clobbering it. Used by the server's
// startup + interval calls so a transient ccusage failure doesn't blank out
// a previously good cache.
function refreshPreserving(cb) {
  const prev = readCache(); // snapshot BEFORE refresh() has a chance to overwrite it
  refresh((res) => {
    if (prev && (res.block === null || res.week === null)) {
      let changed = false;
      if (res.block === null && prev.block != null) { res.block = prev.block; changed = true; }
      if (res.week === null && prev.week != null) { res.week = prev.week; changed = true; }
      if (changed) {
        try {
          fs.writeFileSync(cacheFile() + '.tmp', JSON.stringify(res));
          fs.renameSync(cacheFile() + '.tmp', cacheFile());
        } catch (e) {}
      }
    }
    if (cb) cb(res);
  });
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch (e) { return null; }
}

module.exports = { refresh, readCache, refreshPreserving };
