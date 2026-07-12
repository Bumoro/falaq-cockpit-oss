// context.js — current context-window occupancy from a Claude Code transcript JSONL.
// Current context = the LAST assistant message's input-side tokens
// (input + cache_read + cache_creation); that is what occupies the window right now.
const fs = require('fs');

const NARROW = /haiku|sonnet-4-5/;
const LIMIT_1M = 1000000;
const LIMIT_200K = 200000;

function limitFor(model) {
  if (model && NARROW.test(model)) return LIMIT_200K;
  return LIMIT_1M;
}

function contextForTranscript(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch (e) { continue; }
    const u = o.message && o.message.usage;
    if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) {
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (!tokens) return null;
      const model = (o.message && o.message.model) || o.model || null;
      const limit = limitFor(model);
      return { tokens, limit, pct: Math.min(1, tokens / limit), model };
    }
  }
  return null;
}

module.exports = { contextForTranscript, limitFor };
