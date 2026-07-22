// usage.js — 5h + weekly usage via ccusage, spawned async, cached to disk.
// The request path only ever calls readCache() (sync, fast). refresh() is
// driven by the server on an interval so ccusage never blocks a response.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function cacheFile() { return path.join(stateDir(), 'usage-cache.json'); }

function runJson(subArgs, cb) {
  const stub = process.env.CK_CCUSAGE_CMD;
  const bin = stub || 'npx';
  const args = stub ? [...subArgs, '--json'] : ['--yes', 'ccusage@latest', ...subArgs, '--json'];
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

function readPlanUsage() {
  const file = process.env.CK_PLAN_USAGE_FILE || path.join(os.homedir(), 'Library/Application Support/Claude/plan-usage-history.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.samples) || parsed.samples.length === 0) return null;
    const s = parsed.samples[parsed.samples.length - 1];
    if (!s || !s.u || typeof s.u.sd !== 'number' || !Number.isFinite(s.u.sd)) return null;
    const result = { weeklyPct: s.u.sd };
    if (typeof s.u.fh === 'number' && Number.isFinite(s.u.fh)) result.fiveHourPct = s.u.fh;
    if (typeof s.u.xu === 'number' && Number.isFinite(s.u.xu)) result.overagePct = s.u.xu;
    if (typeof s.t === 'number' && Number.isFinite(s.t)) {
      result.asOf = s.t;
      result.ageMs = Date.now() - s.t;
    }
    if (s.org != null) result.org = s.org;
    return result;
  } catch (e) { return null; }
}

function readWeeklyCap() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir(), 'config.json'), 'utf8'));
    return config.usage && typeof config.usage.weeklyTokenCap === 'number' && config.usage.weeklyTokenCap > 0
      ? config.usage.weeklyTokenCap : null;
  } catch (e) { return null; }
}

function breakdownTokens(b) {
  if (b && Number.isFinite(b.totalTokens)) return b.totalTokens;
  return ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']
    .reduce((sum, key) => sum + (b && Number.isFinite(b[key]) ? b[key] : 0), 0);
}

function modelUsage(row, matches) {
  const breakdowns = row && Array.isArray(row.modelBreakdowns) ? row.modelBreakdowns : [];
  const selected = breakdowns.filter((b) => matches(String((b && (b.modelName || b.model)) || '')));
  if (!selected.length) return null;
  const totalTokens = selected.reduce((sum, b) => sum + breakdownTokens(b), 0);
  const totalCost = selected.reduce((sum, b) => {
    const cost = Number.isFinite(b.totalCost) ? b.totalCost : (Number.isFinite(b.costUSD) ? b.costUSD : b.cost);
    return sum + (Number.isFinite(cost) ? cost : 0);
  }, 0);
  return { totalTokens, totalCost, costUSD: totalCost, modelBreakdowns: selected };
}

// ccusage may report Claude and Codex in the same row. Keep the exact, verified Codex model
// isolated so its tokens and online-provider cost can never be blended into Claude's figures.
function codexUsage(row) {
  return modelUsage(row, model => model === 'gpt-5.6-sol');
}

function claudeUsage(row) {
  return modelUsage(row, model => model !== 'gpt-5.6-sol');
}

function withBlockTimes(usage, block) {
  return usage ? { ...usage, startTime: block.startTime, endTime: block.endTime } : null;
}

function refresh(cb) {
  const res = {
    generatedAt: Date.now(),
    block: null,
    week: null,
    planUsage: readPlanUsage(),
    weeklyTokenCap: readWeeklyCap(),
    codexBlock: null,
    codexWeek: null,
    claudeBlock: null,
  };
  let pending = 3;
  const done = () => {
    if (--pending) return;
    try {
      fs.writeFileSync(cacheFile() + '.tmp', JSON.stringify(res));
      fs.renameSync(cacheFile() + '.tmp', cacheFile());
    } catch (e) {}
    if (cb) cb(res);
  };
  runJson(['blocks', '--active'], (o) => {
    res.block = o ? ((o.blocks || []).find(b => b.isActive) || (o.blocks || [])[0] || null) : null;
    if (res.block) {
      // Older/current ccusage builds may omit per-model block breakdowns. In that case retain the
      // exact pre-feature Claude tile and leave Codex unknown instead of hiding or guessing usage.
      if (Array.isArray(res.block.modelBreakdowns)) {
        res.codexBlock = withBlockTimes(codexUsage(res.block), res.block);
        res.claudeBlock = withBlockTimes(claudeUsage(res.block), res.block);
      } else {
        res.claudeBlock = res.block;
      }
    }
    done();
  });
  runJson(['claude', 'weekly'], (o) => {
    const a = o ? (o.weekly || o.data || []) : [];
    res.week = a[a.length - 1] || null;
    done();
  });
  runJson(['weekly'], (o) => {
    const a = o ? (o.weekly || o.data || []) : [];
    const wk = a.length ? a[a.length - 1] : null;
    res.codexWeek = wk ? codexUsage(wk) : null;
    done();
  });
}

// Like refresh(), but a failed fetch/read (null block/week/planUsage) preserves
// the last known-good cached value instead of clobbering it. Used by the server's
// startup + interval calls so a transient source failure doesn't blank the cache.
function refreshPreserving(cb) {
  const prev = readCache(); // snapshot BEFORE refresh() has a chance to overwrite it
  refresh((res) => {
    if (prev && (res.block === null || res.week === null || res.planUsage === null)) {
      let changed = false;
      if (res.block === null) {
        if (prev.block != null) { res.block = prev.block; changed = true; }
        const canDerive = prev.block && Array.isArray(prev.block.modelBreakdowns);
        const oldCodex = prev.codexBlock != null ? prev.codexBlock : (canDerive ? withBlockTimes(codexUsage(prev.block), prev.block) : null);
        const oldClaude = prev.claudeBlock != null ? prev.claudeBlock : (canDerive ? withBlockTimes(claudeUsage(prev.block), prev.block) : prev.block);
        if (oldCodex != null) { res.codexBlock = oldCodex; changed = true; }
        if (oldClaude != null) { res.claudeBlock = oldClaude; changed = true; }
      }
      if (res.week === null) {
        if (prev.week != null) { res.week = prev.week; changed = true; }
        const oldCodexWeek = prev.codexWeek != null ? prev.codexWeek : codexUsage(prev.week);
        if (oldCodexWeek != null) { res.codexWeek = oldCodexWeek; changed = true; }
      }
      if (res.planUsage === null && prev.planUsage != null) { res.planUsage = prev.planUsage; changed = true; }
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

// weekTileMode — decide what the /live "This Week" tile shows, from the cached usage. Pure + exported
// so this SAFETY-relevant decision (never render a PRIOR week's % as the current week's) is unit-tested
// instead of living untested inside live.html's renderStrip (where the field-name regression slipped by).
//   real   — a Claude Desktop plan-usage sample taken within the CURRENT ccusage week → authoritative %
//   est    — no in-week sample, but an operator-configured weeklyTokenCap → volume/cap estimate
//   volume — neither → raw Claude-only weekly volume, no misleading %
function weekTileMode(usage, now) {
  now = typeof now === 'number' ? now : Date.now();
  const w = usage && usage.week;
  const pu = usage && usage.planUsage;
  const cap = usage && usage.weeklyTokenCap;
  // ccusage `claude weekly` rows carry the week-start under `.week` (legacy bare `weekly` used `.period`).
  // Parse date-only labels as LOCAL midnight (ccusage buckets weeks in local time) so the boundary compare
  // has no UTC skew, and guard NaN so an unparseable label falls back to the age heuristic rather than
  // silently disabling the real % (pu.asOf >= NaN is always false).
  const wkStr = w && (w.week || w.period);
  let ws = NaN;
  if (wkStr) ws = /^\d{4}-\d{2}-\d{2}$/.test(wkStr) ? new Date(wkStr + 'T00:00:00').getTime() : Date.parse(wkStr);
  const weekStart = Number.isNaN(ws) ? null : ws;
  const hasPct = !!(pu && typeof pu.weeklyPct === 'number' && Number.isFinite(pu.weeklyPct));
  const asOf = pu && typeof pu.asOf === 'number' && Number.isFinite(pu.asOf) ? pu.asOf : null;
  const ageMs = asOf != null ? (now - asOf) : (pu && typeof pu.ageMs === 'number' ? pu.ageMs : null);
  // A sample counts as "this week" only if taken at/after the current week's start. With no parseable
  // week label, fall back to a 24h age window so a fresh sample still shows.
  const withinWeek = hasPct && (
    weekStart != null
      ? (asOf != null && asOf >= weekStart)
      : (ageMs != null && ageMs < 24 * 3600 * 1000)
  );
  if (withinWeek) {
    return { mode: 'real', pct: Math.round(pu.weeklyPct), asOf, stale: ageMs != null && ageMs > 6 * 3600 * 1000 };
  }
  if (cap && w && typeof w.totalTokens === 'number' && w.totalTokens > 0) {
    return { mode: 'est', pct: Math.round(100 * w.totalTokens / cap) };
  }
  return { mode: 'volume' };
}

// A plain-English runway for the weekly tile. This deliberately uses percentage burn rather
// than token volume so it works for both authoritative plan samples and configured-cap estimates.
// It never promises runway beyond the weekly reset, and returns null when the pace is unknowable.
function weeklyFraming(usage, now) {
  now = typeof now === 'number' ? now : Date.now();
  const tile = weekTileMode(usage, now);
  if (tile.mode !== 'real' && tile.mode !== 'est') return null;
  // a stale plan sample (>6h) means burn since asOf is unknown — a confident runway would mislead
  if (tile.mode === 'real' && tile.stale) return null;
  const pct = tile.mode === 'real'
    ? Number(usage && usage.planUsage && usage.planUsage.weeklyPct)
    : 100 * Number(usage && usage.week && usage.week.totalTokens) / Number(usage && usage.weeklyTokenCap);
  if (!Number.isFinite(pct) || pct <= 0) return null;

  const week = usage && usage.week;
  const label = week && (week.week || week.period);
  if (!label) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  let weekStart, weekEnd;
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    // calendar arithmetic so the boundary lands on local midnight across DST shifts
    const [y, m, d] = label.split('-').map(Number);
    weekStart = new Date(y, m - 1, d).getTime();
    weekEnd = new Date(y, m - 1, d + 7).getTime();
  } else {
    weekStart = Date.parse(label);
    weekEnd = weekStart + 7 * dayMs;
  }
  if (!Number.isFinite(weekStart) || now <= weekStart || now >= weekEnd) return null;

  const elapsedDays = (now - weekStart) / dayMs;
  const dailyBurn = pct / elapsedDays;
  if (!Number.isFinite(dailyBurn) || dailyBurn <= 0) return null;
  const paceDays = Math.max(0, (100 - pct) / dailyBurn);
  const resetDays = Math.max(0, (weekEnd - now) / dayMs);
  const days = Math.round(Math.min(paceDays, resetDays));
  return `≈${days} ${days === 1 ? 'day' : 'days'} of weekly limit left at the current pace`;
}

function weeklyProjection(usage, now) {
  now = typeof now === 'number' ? now : Date.now();
  const week = usage && usage.week;
  const tokens = week && Number(week.totalTokens);
  const label = week && (week.week || week.period);
  if (!Number.isFinite(tokens) || tokens < 0 || !label) return null;
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(label) ? new Date(label + 'T00:00:00').getTime() : Date.parse(label);
  if (!Number.isFinite(weekStart) || now <= weekStart) return null;
  let cap = Number(usage && usage.weeklyTokenCap);
  if (!(cap > 0)) {
    const tile = weekTileMode(usage, now);
    if (tile.mode === 'real' && tile.pct > 0) cap = tokens / (tile.pct / 100);
  }
  if (!(cap > 0)) return { tokens, cap: null, pct: null, exhaustionAt: null, exhaustionDay: null, withinLimit: null };
  const pct = Math.round(100 * tokens / cap);
  const rate = tokens / (now - weekStart);
  const exhaustionAt = rate > 0 ? weekStart + cap / rate : null;
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
  const withinLimit = !exhaustionAt || exhaustionAt >= weekEnd;
  return {
    tokens, cap, pct, exhaustionAt, withinLimit,
    exhaustionDay: tokens >= cap ? 'limit reached' : withinLimit ? null : new Date(exhaustionAt).toLocaleDateString('en-US', { weekday: 'long' }),
  };
}

module.exports = { refresh, readCache, refreshPreserving, readPlanUsage, readWeeklyCap, weekTileMode, weeklyFraming, weeklyProjection, codexUsage };
