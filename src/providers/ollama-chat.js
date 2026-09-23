// providers/ollama-chat.js — persistent, cockpit-mediated Ollama conversations.
// Transcripts and usage are append-only JSONL. Ollama usage is tokens-only.

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const GENERATION_TIMEOUT_MS = 120000;
const CHAT_NAME_RE = /^ck-[a-z0-9-]{1,40}$/;
// Namespaced ids (`library/model:tag`) are allowed; any `.`/`..` path segment is rejected (isModelId).
const MODEL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?::[A-Za-z0-9._-]+)?$/;
function isModelId(model) {
  const s = String(model || '');
  if (s.length > 200 || !MODEL_RE.test(s)) return false;
  return !s.split(/[\/:]/).some(seg => seg === '.' || seg === '..');
}
const inFlight = new Map(); // chatName -> AbortController of the in-flight generation
const discarded = new Set(); // killed chats: suppress any late appends from their in-flight work

function stateDir() {
  return process.env.COCKPIT_DIR || path.resolve(__dirname, '..');
}

function chatDir() {
  return path.join(stateDir(), 'ollama-chats');
}

function chatFile(chatName) {
  if (!CHAT_NAME_RE.test(String(chatName || ''))) throw new Error('bad chat name');
  return path.join(chatDir(), chatName + '.jsonl');
}

function usageFile() {
  return path.join(stateDir(), 'ollama-usage.jsonl');
}

function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // One O_APPEND write keeps each JSON record intact even if another chat finishes
  // at the same time. A trailing newline also makes partial crash writes ignorable.
  fs.appendFileSync(file, JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'a' });
}

function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter(Boolean).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value] : [];
    } catch (e) {
      return [];
    }
  });
}

function history(chatName) {
  return readLines(chatFile(chatName)).filter(turn =>
    (turn.role === 'user' || turn.role === 'assistant') &&
    typeof turn.content === 'string' &&
    typeof turn.ts === 'string' &&
    Number.isFinite(Date.parse(turn.ts))
  );
}

function timestamp(opts) {
  const value = typeof opts.now === 'function' ? opts.now() :
    opts.now !== undefined ? opts.now : Date.now();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function timeoutMs(value) {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), GENERATION_TIMEOUT_MS)
    : GENERATION_TIMEOUT_MS;
}

function busyError() {
  const error = new Error('chat is already generating a reply');
  error.code = 'OLLAMA_CHAT_BUSY';
  error.status = 409;
  error.statusCode = 409;
  return error;
}

function isBusy(chatName) {
  return inFlight.has(String(chatName || ''));
}

// Models with an in-flight mediated generation. The session feed shows these as 'running' —
// without this every Ollama card reads a dishonest 'idle' while a reply is streaming.
function busyModels() {
  const models = loadChatModels();
  const busy = new Set();
  for (const chatName of inFlight.keys()) {
    const model = models.get(chatName);
    if (model) busy.add(model);
  }
  return busy;
}

// killChat calls this for a mediated chat: abort any in-flight generation, suppress its late
// appends, and delete the transcript so a reused slug can never resurrect the dead conversation.
function discard(chatName) {
  const file = chatFile(chatName); // validates the name before any fs op
  const controller = inFlight.get(chatName);
  if (controller) { try { controller.abort(); } catch (e) {} }
  discarded.add(chatName);
  try { fs.rmSync(file, { force: true }); } catch (e) {}
}

function cleanCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function errorMessage(error) {
  if (error && error.name === 'AbortError') return 'Ollama request timed out';
  const message = error && error.message ? String(error.message) : 'Ollama unavailable';
  return message.slice(0, 500);
}

// Deliberately not `async`: validation and the busy claim happen synchronously, so
// an HTTP route can report a conflict before returning its immediate 202 response.
function send(chatName, model, text, opts = {}) {
  const file = chatFile(chatName);
  if (!isModelId(model)) throw new Error('invalid model');
  const content = String(text == null ? '' : text);
  if (!content.trim()) throw new Error('message is required');
  if (isBusy(chatName)) throw busyError();
  discarded.delete(chatName); // a reused slug is a brand-new conversation

  appendLine(file, {
    role: 'user',
    content,
    ts: timestamp(opts),
    tokens: null,
  });
  const fetchImpl = opts.fetch || globalThis.fetch;
  const controller = new AbortController();
  inFlight.set(chatName, controller);
  const baseUrl = String(opts.baseUrl || process.env.CK_OLLAMA_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let timer;

  const generation = Promise.resolve().then(async () => {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    // Honest error turns stay visible in the transcript but are never replayed to the model.
    const messages = history(chatName)
      .filter(turn => !(turn.role === 'assistant' && !turn.tokens && /^Ollama error: /.test(turn.content)))
      .map(turn => ({ role: turn.role, content: turn.content }));
    const request = Promise.resolve(fetchImpl(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    })).then(async response => {
      if (!response || response.ok !== true) throw new Error('Ollama unavailable');
      return response.json();
    });
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Ollama request timed out'));
      }, timeoutMs(opts.timeoutMs));
    });
    const body = await Promise.race([request, deadline]);
    const reply = body && body.message && body.message.content;
    if (typeof reply !== 'string') throw new Error('Ollama returned an invalid response');
    const tokens = {
      prompt: cleanCount(body.prompt_eval_count),
      eval: cleanCount(body.eval_count),
    };
    const ts = timestamp(opts);
    if (!discarded.has(chatName)) {
      appendLine(file, { role: 'assistant', content: reply, ts, tokens });
      appendLine(usageFile(), { ts, model, prompt: tokens.prompt, eval: tokens.eval });
    }
    return { ok: true, tokens };
  }).catch(error => {
    if (!discarded.has(chatName)) {
      appendLine(file, {
        role: 'assistant',
        content: 'Ollama error: ' + errorMessage(error),
        ts: timestamp(opts),
        tokens: null,
      });
    }
    return { ok: false, error: errorMessage(error) };
  }).finally(() => {
    clearTimeout(timer);
    inFlight.delete(chatName);
  });

  return generation;
}

function loadChatModels() {
  try {
    const chats = JSON.parse(fs.readFileSync(path.join(stateDir(), 'chats.json'), 'utf8'));
    return new Map((Array.isArray(chats) ? chats : [])
      .filter(chat => chat && chat.mediated && chat.provider === 'ollama')
      .map(chat => [chat.name, chat.model]));
  } catch (e) {
    return new Map();
  }
}

function contextFor(model) {
  const chats = loadChatModels();
  let latest = null;
  try {
    for (const entry of fs.readdirSync(chatDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const chatName = entry.name.slice(0, -6);
      if (chats.get(chatName) !== model) continue;
      for (const turn of history(chatName)) {
        if (turn.role !== 'assistant' || !turn.tokens) continue;
        if (!latest || Date.parse(turn.ts) >= Date.parse(latest.ts)) latest = turn;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!latest) return null;
  return {
    tokens: cleanCount(latest.tokens.prompt) + cleanCount(latest.tokens.eval),
    ts: latest.ts,
  };
}

module.exports = {
  send,
  history,
  contextFor,
  isBusy,
  busyModels,
  discard,
  GENERATION_TIMEOUT_MS,
};
