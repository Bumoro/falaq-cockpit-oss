// providers/ollama.js — loaded local Ollama models and launch-model discovery.
// Read-only, zero dependencies, and deliberately tokens-only: Ollama objects never
// expose monetary usage fields.

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 800;
const MAX_TIMEOUT_MS = 1000;
const FALLBACK_MODELS = Object.freeze([
  'qwen2.5-coder:32b',
  'qwen2.5-coder:7b',
]);

function timeoutMs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(requested), MAX_TIMEOUT_MS);
}

async function requestJson(endpoint, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');

  const controller = new AbortController();
  const baseUrl = String(opts.baseUrl || process.env.CK_OLLAMA_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let timer;
  const request = Promise.resolve()
    .then(() => fetchImpl(baseUrl + endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }))
    .then(async response => {
      if (!response || response.ok !== true) throw new Error('Ollama unavailable');
      return response.json();
    });
  // Promise.race is intentional: an injected or unusual fetch implementation may
  // ignore AbortSignal, but it still must not hold up the cockpit session poll.
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Ollama request timed out'));
    }, timeoutMs(opts.timeoutMs));
  });

  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function validLimit(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function mediatedContext(model, opts) {
  try {
    const lookup = typeof opts.contextFor === 'function'
      ? opts.contextFor
      : require('./ollama-chat.js').contextFor;
    const value = lookup(model);
    return value && Number.isFinite(value.tokens) && value.tokens >= 0 ? value.tokens : null;
  } catch (e) {
    return null;
  }
}

function busyModelSet(opts) {
  try {
    const lookup = typeof opts.busyModels === 'function'
      ? opts.busyModels
      : require('./ollama-chat.js').busyModels;
    const value = lookup();
    return value instanceof Set ? value : new Set();
  } catch (e) {
    return new Set();
  }
}

async function activeSessions(opts = {}) {
  try {
    const body = await requestJson('/api/ps', opts);
    if (!body || !Array.isArray(body.models)) return [];
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const busy = busyModelSet(opts);
    return body.models
      .filter(model => model && typeof model.name === 'string' && model.name.trim())
      .map(model => {
        const name = model.name.trim();
        const limit = validLimit(model.context_length);
        const tokens = mediatedContext(name, opts);
        return {
          id: 'ollama:' + name,
          cwd: '',
          client: 'Ollama',
          lastActivity: now,
          context: {
            tokens,
            limit,
            pct: tokens != null && limit != null ? tokens / limit : null,
            model: name,
          },
          provider: 'ollama',
          generating: busy.has(name),
        };
      });
  } catch (e) {
    return [];
  }
}

// 30s in-memory memo of the LIVE list for the default (non-injected) source, so page opens and the
// model registry's refresh don't each hit Ollama. Injected fetch/baseUrl (tests) bypass it; the static
// fallback is never memoised so a recovering Ollama shows up on the next call.
const LIST_MEMO_MS = 30000;
let listMemo = null; // { at, names }

async function listModels(opts = {}) {
  const memoable = !opts.fetch && !opts.baseUrl;
  if (memoable && listMemo && Date.now() - listMemo.at < LIST_MEMO_MS) return [...listMemo.names];
  try {
    const body = await requestJson('/api/tags', opts);
    if (!body || !Array.isArray(body.models)) throw new Error('bad tags response');
    const names = body.models
      .map(model => model && typeof model.name === 'string' ? model.name.trim() : '')
      .filter(Boolean);
    if (!names.length) return [...FALLBACK_MODELS];
    const unique = [...new Set(names)];
    if (memoable) listMemo = { at: Date.now(), names: unique };
    return [...unique];
  } catch (e) {
    return [...FALLBACK_MODELS];
  }
}

module.exports = { activeSessions, listModels, FALLBACK_MODELS };
