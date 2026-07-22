// context.js — current context-window occupancy from a Claude Code transcript JSONL,
// reported the SAME way Claude Code's own statusline (gsd-statusline.js) shows it.
//
// Two deliberate choices, both to match what the user actually sees in their terminal —
// NOT a naive tokens/window ratio (which under-reports and lags reality as context fills):
//
//   1. Numerator = the LAST real assistant message's INPUT-side tokens
//      (input + cache_read + cache_creation). This is exactly what Claude Code derives
//      context_window.remaining_percentage from; output_tokens are NOT included (they are
//      the turn's response, folded into the next request's cache). `<synthetic>` assistant
//      turns are skipped, matching Claude Code's own current-context counter.
//
//   2. pct is normalized against the USABLE window — the full window minus the auto-compact
//      buffer (default 16.5%) — so it reaches 100% at the auto-compact point, exactly like
//      the statusline. Raw tokens/window under-reports and the gap widens with fill
//      (80% raw == 96% shown), which was the "cockpit context% lags reality" bug.
//      Mirrors gsd-statusline.js line-for-line and honors CLAUDE_CODE_AUTO_COMPACT_WINDOW.
const fs = require('fs');

const NARROW = /haiku|sonnet-4-5/;
const LIMIT_1M = 1000000;
const LIMIT_200K = 200000;
const SYNTHETIC = '<synthetic>';
const DEFAULT_BUFFER_PCT = 16.5; // Claude Code's default auto-compact reserve, as a % of the window

function limitFor(model) {
  if (model && NARROW.test(model)) return LIMIT_200K;
  return LIMIT_1M;
}

// Auto-compact buffer as a % of the window. Matches gsd-statusline.js: a token-count override
// via CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence, otherwise the fixed 16.5% default.
function bufferPctFor(limit) {
  const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  if (acw > 0) return Math.min(100, (acw / limit) * 100);
  return DEFAULT_BUFFER_PCT;
}

// The usable window: tokens available before auto-compact triggers (what pct hits 100% at).
function usableLimitFor(limit) {
  return Math.round(limit * (1 - bufferPctFor(limit) / 100));
}

// "Context used" fraction (0..1) normalized to the usable window — byte-for-byte the same
// computation gsd-statusline renders, so the cockpit tile matches the terminal number.
function usedFraction(tokens, limit) {
  const usedRaw = Math.round((tokens / limit) * 100);            // Claude Code used_percentage
  const remaining = Math.min(100, Math.max(0, 100 - usedRaw));   // Claude Code remaining_percentage
  const buffer = bufferPctFor(limit);
  const usableRemaining = Math.max(0, ((remaining - buffer) / (100 - buffer)) * 100);
  const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));
  return used / 100;
}

function contextForTranscript(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    const model = (o.message && o.message.model) || o.model || null;
    // Skip Claude Code's synthetic turns — their usage is not the live context window.
    if (model === SYNTHETIC) continue;
    const u = o.message && o.message.usage;
    if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (!tokens) return null;
      const limit = limitFor(model);
      return { tokens, limit, usableLimit: usableLimitFor(limit), pct: usedFraction(tokens, limit), model };
    }
  }
  return null;
}

module.exports = { contextForTranscript, limitFor, usedFraction, usableLimitFor };
