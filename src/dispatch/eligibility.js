// src/dispatch/eligibility.js — pure allowlist filter. Order matters: GATE veto is checked FIRST.
'use strict';
const GATE_RE = /^\s*🔒\s*GATE\s*:/i;                       // absolute veto, matches the CLAUDE.md §6 prefix
const ACTIONABLE = new Set(['active', 'todo', 'open', 'in_progress', 'pending']);

function isEligible(task, ctx) {
  const t = task || {};
  const c = ctx || {};
  const config = c.config || {};
  const tags = Array.isArray(t.tags) ? t.tags : [];
  // A present-but-malformed blockedBy (e.g. the string "t0" the MCP bridge might emit) fails CLOSED → skip;
  // null/undefined = genuinely no blockers. The old `Array.isArray(x) ? x : []` coercion let a malformed
  // value fail OPEN (a blocked task would dispatch), unlike `tags` which already fails closed. (panel MINOR)
  const hasBlockers = Array.isArray(t.blockedBy) ? t.blockedBy.length > 0 : t.blockedBy != null;

  if (GATE_RE.test(String(t.title || ''))) return { ok: false, reason: 'gate-veto' };
  if (!tags.includes('auto:eligible')) return { ok: false, reason: 'not-tagged' };
  if (!ACTIONABLE.has(String(t.status || '').toLowerCase())) return { ok: false, reason: 'status:' + (t.status || 'unknown') };
  if (hasBlockers) return { ok: false, reason: 'has-blockers' };
  if (t.owner) return { ok: false, reason: 'claimed' };
  if (c.runningCwds && t.cwd && c.runningCwds.has(t.cwd)) return { ok: false, reason: 'repo-busy' };
  if (!t.hasPlan) return { ok: false, reason: 'no-plan' };
  if ((c.runningCount || 0) >= (typeof config.concurrency === 'number' ? config.concurrency : 1)) return { ok: false, reason: 'at-capacity' };
  return { ok: true, reason: 'eligible' };
}

module.exports = { isEligible, GATE_RE };
