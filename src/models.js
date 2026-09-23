// models.js — auto-discovered model catalog for every provider (claude, codex, ollama, agy).
// Same shape as usage.js: an async refresh() driven by the server on an interval, an atomic
// .tmp+rename disk cache, last-known-good on failure, and a synchronous getCatalog() read on the
// request path. A CLI is NEVER spawned from a request path: only refresh() (interval / explicit
// ?refresh=1 kick, both non-blocking) runs `codex debug models` / `agy models`.
//
// Security: every id that can reach the tmux launch string (claude/codex/agy) must match SAFE_ID_RE;
// ids that do not are dropped at parse time (e.g. `claude-fable-5-1[1m]`). Only model fields are ever
// read or emitted: the Claude catalog files also carry organizationUuid etc. — never copied.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDERS = ['claude', 'codex', 'ollama', 'agy'];
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OLLAMA_ID_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?::[A-Za-z0-9._-]+)?$/;
const EFFORT_RE = /^[a-z]{1,16}$/;
const GROUP_RE = /^[a-z_]{1,24}$/;

const DEFAULT_REFRESH_MS = 15 * 60 * 1000;
const DEFAULT_AGY_REFRESH_MS = 6 * 60 * 60 * 1000;
const CODEX_TIMEOUT_MS = 15000;
const AGY_TIMEOUT_MS = 60000; // cold `agy models` has been observed at ~29s

const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_FALLBACK_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CLAUDE_ALIASES = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);
const CLAUDE_FALLBACK_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', label: 'Opus 5.5', short: 'opus' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', short: 'fable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', short: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', short: 'haiku' },
]);
const AGY_DEFAULT = { id: 'antigravity', label: "Default (agy's choice)" };
const AGY_SEED = Object.freeze([
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
]);
const OLLAMA_PREFERRED_DEFAULT = 'qwen2.5-coder:32b';

// ---------- env-overridable sources ----------
function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function cacheFile() { return process.env.CK_MODELS_CACHE || path.join(stateDir(), 'models-cache.json'); }
function claudeCatalogDir() { return process.env.CK_CLAUDE_CATALOG_DIR || path.join(os.homedir(), '.claude', 'cache', 'model-catalog'); }
function codexBin() { return resolveBin('codex', 'CK_CODEX_BIN'); }
function codexModelsCache() { return process.env.CK_CODEX_MODELS_CACHE || path.join(os.homedir(), '.codex', 'models_cache.json'); }
function codexConfig() { return process.env.CK_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml'); }
function agyBin() { return resolveBin('agy', 'CK_AGY_BIN'); }
// The live server runs under launchd with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where neither CLI
// lives. Resolve an absolute path: env override first, else the first executable among PATH, then
// the usual install dirs. null = not installed (never spawned, never burns the agy window).
function extraBinDirs() { return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]; }
function isExecFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (e) { return false; }
}
function resolveBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).concat(extraBinDirs());
  for (const d of dirs) { const p = path.join(d, name); if (isExecFile(p)) return p; }
  return null;
}
// codex is a node script (`#!/usr/bin/env node`): the child needs node's dir on PATH too.
function childEnv() {
  const seen = new Set();
  const parts = extraBinDirs().concat(String(process.env.PATH || '').split(path.delimiter))
    .filter(d => d && !seen.has(d) && seen.add(d));
  return { ...process.env, PATH: parts.join(path.delimiter) };
}
function msEnv(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ---------- sanitizers ----------
function isSafeId(id) { return typeof id === 'string' && SAFE_ID_RE.test(id); }
function isOllamaId(id) {
  if (typeof id !== 'string' || id.length > 128 || !OLLAMA_ID_RE.test(id)) return false;
  const name = id.replace(/:[^/]*$/, '');
  return !name.split('/').some(seg => seg === '.' || seg === '..');
}
function idOk(provider, id) { return provider === 'ollama' ? isOllamaId(id) : isSafeId(id); }
function cleanLabel(s, fallback) {
  const v = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return v || fallback;
}
function cleanEfforts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) if (typeof e === 'string' && EFFORT_RE.test(e) && !out.includes(e)) out.push(e);
  return out;
}

// Normalise one provider entry to the public shape; used on every source incl. the disk cache.
function sanitizeEntry(provider, entry) {
  if (!entry || !Array.isArray(entry.models)) return null;
  const seen = new Set();
  const models = [];
  for (const m of entry.models) {
    if (!m || !idOk(provider, m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    const out = { id: m.id, label: cleanLabel(m.label, m.id) };
    if (typeof m.group === 'string' && GROUP_RE.test(m.group)) out.group = m.group;
    if (provider === 'claude' || provider === 'codex') {
      out.efforts = cleanEfforts(m.efforts);
      if (typeof m.defaultEffort === 'string' && out.efforts.includes(m.defaultEffort)) out.defaultEffort = m.defaultEffort;
    }
    models.push(out);
  }
  if (!models.length) return null;
  const def = typeof entry.default === 'string' && seen.has(entry.default) ? entry.default : models[0].id;
  const efforts = provider === 'claude' || provider === 'codex' ? cleanEfforts(entry.efforts) : [];
  const source = ['live', 'cache', 'fallback'].includes(entry.source) ? entry.source : 'cache';
  const asOf = Number.isFinite(entry.asOf) ? entry.asOf : null;
  const res = { models, default: def, efforts, source, asOf };
  if (provider === 'codex' && typeof entry.defaultEffort === 'string' && EFFORT_RE.test(entry.defaultEffort)) res.defaultEffort = entry.defaultEffort;
  if (provider === 'claude' && typeof entry.defaultEffort === 'string' && EFFORT_RE.test(entry.defaultEffort)) res.defaultEffort = entry.defaultEffort;
  return res;
}

// ---------- fallbacks ----------
function claudeFromMain(mainEntries, extra, opts) {
  // mainEntries: [{id,label,short,efforts}] used to label the aliases; extra: all catalog models.
  const models = [];
  for (const alias of CLAUDE_ALIASES) {
    const target = mainEntries.find(m => m.short === alias);
    const name = alias.charAt(0).toUpperCase() + alias.slice(1);
    models.push({
      id: alias,
      label: target ? `${name} (latest → ${target.label})` : `${name} (latest)`,
      group: 'latest',
      efforts: target && target.efforts && target.efforts.length ? target.efforts : [...CLAUDE_EFFORTS],
    });
  }
  for (const m of extra) models.push({ id: m.id, label: m.label, group: m.group, efforts: m.efforts && m.efforts.length ? m.efforts : [...CLAUDE_EFFORTS] });
  return {
    models,
    default: opts.default,
    efforts: [...CLAUDE_EFFORTS],
    defaultEffort: opts.defaultEffort || 'medium',
    source: opts.source,
    asOf: opts.asOf,
  };
}

function fallbackEntry(provider) {
  if (provider === 'claude') {
    const main = CLAUDE_FALLBACK_MODELS.map(m => ({ ...m, group: 'main', efforts: [...CLAUDE_EFFORTS] }));
    return sanitizeEntry('claude', claudeFromMain(main, main, { default: 'sonnet', source: 'fallback', asOf: null }));
  }
  if (provider === 'codex') {
    return sanitizeEntry('codex', {
      models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...CODEX_FALLBACK_EFFORTS], defaultEffort: 'medium' }],
      default: 'gpt-6-astra', efforts: [...CODEX_FALLBACK_EFFORTS], defaultEffort: 'medium', source: 'fallback', asOf: null,
    });
  }
  if (provider === 'agy') {
    return sanitizeEntry('agy', {
      models: [AGY_DEFAULT, ...AGY_SEED.map(([id, label]) => ({ id, label }))],
      default: 'antigravity', source: 'fallback', asOf: null,
    });
  }
  let names;
  try { names = [...require('./providers/ollama.js').FALLBACK_MODELS]; } catch (e) { names = [OLLAMA_PREFERRED_DEFAULT]; }
  return ollamaEntry(names, 'fallback', null);
}

// ---------- claude: served catalog cache files ----------
function installedClaudeVersion() {
  if (process.env.CK_CLAUDE_VERSION) return process.env.CK_CLAUDE_VERSION;
  try {
    const bin = process.env.CK_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
    const m = /(\d+\.\d+\.\d+)/.exec(fs.readlinkSync(bin));
    return m ? m[1] : null;
  } catch (e) { return null; }
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function readClaudeCatalog() {
  let files;
  try { files = fs.readdirSync(claudeCatalogDir()).filter(f => f.endsWith('.json')); } catch (e) { return null; }
  const picks = { cc: null, ccd: null };
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(claudeCatalogDir(), f), 'utf8')); } catch (e) { continue; }
    const cat = j && j.catalog;
    const surface = cat && cat.surface;
    if ((surface !== 'cc' && surface !== 'ccd') || !cat.config || !Array.isArray(cat.config.models)) continue;
    const fetchedAt = Number.isFinite(j.fetchedAt) ? j.fetchedAt : 0;
    // Only these fields are ever lifted out of the file (never organizationUuid / resolution / etc).
    const picked = { fetchedAt, models: cat.config.models, stateModel: cat.state && cat.state.model,
      stateEffort: cat.state && cat.state.thinking && cat.state.thinking.effort };
    if (!picks[surface] || fetchedAt > picks[surface].fetchedAt) picks[surface] = picked;
  }
  const chosen = picks.cc || picks.ccd;
  if (!chosen) return null;
  const version = installedClaudeVersion();
  const entries = [];
  for (const m of chosen.models) {
    if (!m || !isSafeId(m.id)) continue; // drops `[1m]`-style ids and anything shell-unsafe
    if (version && typeof m.min_claude_code_version === 'string' && cmpVersion(m.min_claude_code_version, version) > 0) continue;
    const opts = m.thinking && Array.isArray(m.thinking.effort_options) ? m.thinking.effort_options : [];
    entries.push({
      id: m.id,
      label: cleanLabel(m.name, m.id),
      short: typeof m.short_name === 'string' ? m.short_name.toLowerCase() : '',
      group: typeof m.section === 'string' && GROUP_RE.test(m.section) ? m.section : undefined,
      efforts: cleanEfforts(opts.map(o => o && o.id)),
    });
  }
  if (!entries.length) return null;
  const main = entries.filter(e => e.group === 'main');
  const ids = new Set(entries.map(e => e.id));
  // state.model may be an alias ('opus') or carry a context suffix ('claude-opus-5-5[1m]').
  const stateModel = typeof chosen.stateModel === 'string' ? chosen.stateModel.replace(/\[1m\]$/i, '') : '';
  const def = CLAUDE_ALIASES.includes(stateModel) || ids.has(stateModel) ? stateModel : 'sonnet';
  const defaultEffort = typeof chosen.stateEffort === 'string' && EFFORT_RE.test(chosen.stateEffort) ? chosen.stateEffort : 'medium';
  return sanitizeEntry('claude', claudeFromMain(main.length ? main : entries, entries,
    { default: def, defaultEffort, source: 'live', asOf: chosen.fetchedAt || Date.now() }));
}

// ---------- codex ----------
function readCodexConfig() {
  let raw;
  try { raw = fs.readFileSync(codexConfig(), 'utf8'); } catch (e) { return {}; }
  const out = {};
  for (const line of raw.split('\n')) {
    if (/^\s*\[/.test(line)) break; // only top-level keys, not [profiles.*] tables
    let m = /^model\s*=\s*"([^"]+)"/.exec(line);
    if (m) out.model = m[1];
    m = /^model_reasoning_effort\s*=\s*"([^"]+)"/.exec(line);
    if (m) out.effort = m[1];
  }
  return out;
}

function parseCodexCatalog(json, source) {
  const list = json && Array.isArray(json.models) ? json.models : null;
  if (!list) return null;
  const rows = list
    .filter(m => m && m.visibility === 'list' && isSafeId(m.slug))
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : 1e9) - (Number.isFinite(b.priority) ? b.priority : 1e9))
    .map(m => {
      const efforts = cleanEfforts((Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map(l => (l && typeof l === 'object' ? l.effort : l)));
      const row = { id: m.slug, label: cleanLabel(m.display_name, m.slug), efforts };
      if (typeof m.default_reasoning_level === 'string' && efforts.includes(m.default_reasoning_level)) row.defaultEffort = m.default_reasoning_level;
      return row;
    });
  if (!rows.length) return null;
  const cfg = readCodexConfig();
  const defRow = rows.find(r => r.id === cfg.model) || rows[0];
  const defaultEffort = cfg.effort && defRow.efforts.includes(cfg.effort) ? cfg.effort : (defRow.defaultEffort || 'medium');
  return sanitizeEntry('codex', {
    models: rows, default: defRow.id, efforts: defRow.efforts, defaultEffort, source, asOf: Date.now(),
  });
}

function readCodexModelsCache() {
  try { return parseCodexCatalog(JSON.parse(fs.readFileSync(codexModelsCache(), 'utf8')), 'cache'); } catch (e) { return null; }
}

// Resolves { out, ran }: out = stdout on success else null; ran = false when the binary is missing
// (unresolved / ENOENT / not executable) so callers can tell "not installed" from "ran and failed".
function runCli(bin, args, opts) {
  return new Promise(resolve => {
    if (!bin) return resolve({ out: null, ran: false });
    try {
      execFile(bin, args, { timeout: opts.timeout, cwd: opts.cwd, env: childEnv(), maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return resolve({ out: null, ran: false });
          resolve({ out: err ? null : String(stdout || ''), ran: true });
        });
    } catch (e) { resolve({ out: null, ran: false }); }
  });
}

async function fetchCodex() {
  const { out } = await runCli(codexBin(), ['debug', 'models'], { timeout: CODEX_TIMEOUT_MS });
  if (out) {
    try { const live = parseCodexCatalog(JSON.parse(out), 'live'); if (live) return live; } catch (e) {}
  }
  return readCodexModelsCache();
}

// ---------- agy ----------
function parseAgy(stdout) {
  const models = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9.-]*)\t(.+)$/.exec(line);
    if (m && isSafeId(m[1]) && m[1] !== AGY_DEFAULT.id) models.push({ id: m[1], label: m[2] });
  }
  if (!models.length) return null;
  return sanitizeEntry('agy', { models: [AGY_DEFAULT, ...models], default: 'antigravity', source: 'live', asOf: Date.now() });
}

// Resolves { entry, ran } — the 6h window is only consumed when agy actually ran.
async function fetchAgy() {
  const { out, ran } = await runCli(agyBin(), ['models'], { timeout: AGY_TIMEOUT_MS, cwd: os.tmpdir() });
  return { entry: out ? parseAgy(out) : null, ran };
}

// ---------- ollama ----------
function ollamaEntry(names, source, asOf) {
  const ids = (names || []).filter(isOllamaId);
  if (!ids.length) return null;
  const def = ids.includes(OLLAMA_PREFERRED_DEFAULT) ? OLLAMA_PREFERRED_DEFAULT : ids[0];
  return sanitizeEntry('ollama', { models: ids.map(id => ({ id, label: id })), default: def, source, asOf });
}

async function fetchOllama() {
  const ollama = require('./providers/ollama.js');
  const names = await ollama.listModels();
  const fb = ollama.FALLBACK_MODELS || [];
  const isFallback = Array.isArray(names) && names.length === fb.length && names.every((n, i) => n === fb[i]);
  return isFallback ? null : ollamaEntry(names, 'live', Date.now());
}

// ---------- state ----------
let catalog = null;       // { claude, codex, ollama, agy } — always complete once loaded
let agyAttemptAt = 0;     // persisted: `agy models` runs at most every CK_AGY_REFRESH_MS (6h)
let refreshing = null;
let timer = null;

function readDiskCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const providers = {};
    for (const p of PROVIDERS) {
      const e = sanitizeEntry(p, j && j.providers && j.providers[p]);
      if (e) providers[p] = e.source === 'live' ? { ...e, source: 'cache' } : e;
    }
    return { providers, agyAttemptAt: Number.isFinite(j && j.agyAttemptAt) ? j.agyAttemptAt : 0 };
  } catch (e) { return { providers: {}, agyAttemptAt: 0 }; }
}

function writeDiskCache() {
  const file = cacheFile();
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), agyAttemptAt, providers: catalog }));
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// Cold load: disk cache + cheap synchronous FILE reads (no CLI spawn), then hardcoded fallbacks.
function ensureLoaded() {
  if (catalog) return catalog;
  const disk = readDiskCache();
  agyAttemptAt = disk.agyAttemptAt;
  catalog = {
    claude: readClaudeCatalog() || disk.providers.claude || fallbackEntry('claude'),
    codex: disk.providers.codex || readCodexModelsCache() || fallbackEntry('codex'),
    ollama: disk.providers.ollama || fallbackEntry('ollama'),
    agy: disk.providers.agy || fallbackEntry('agy'),
  };
  return catalog;
}

function lastGood(provider) {
  const prev = catalog && catalog[provider];
  if (prev && prev.source !== 'fallback') return prev.source === 'live' ? { ...prev, source: 'cache' } : prev;
  return fallbackEntry(provider);
}

function refresh() {
  if (refreshing) return refreshing;
  ensureLoaded();
  refreshing = (async () => {
    const now = Date.now();
    const agyDue = now - agyAttemptAt >= msEnv('CK_AGY_REFRESH_MS', DEFAULT_AGY_REFRESH_MS);
    const safe = p => p.catch(() => null);
    const [claude, codex, ollama, agyRes] = await Promise.all([
      safe(Promise.resolve().then(readClaudeCatalog)),
      safe(fetchCodex()),
      safe(fetchOllama()),
      agyDue ? safe(fetchAgy()) : Promise.resolve(undefined),
    ]);
    // Missing binary: keep the previous agy entry and do not start the 6h window.
    if (agyRes && agyRes.ran) agyAttemptAt = now;
    const agy = agyRes === undefined || (agyRes && !agyRes.ran) ? undefined : (agyRes ? agyRes.entry : null);
    catalog = {
      claude: claude || lastGood('claude'),
      codex: codex || lastGood('codex'),
      ollama: ollama || lastGood('ollama'),
      agy: agy === undefined ? catalog.agy : (agy || lastGood('agy')),
    };
    writeDiskCache();
    return getCatalog();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Request-path kick (GET /api/models?refresh=1 is unauthenticated): at most one refresh per
// CK_MODELS_MIN_REFRESH_MS (60s) so repeated calls can't re-spawn codex back-to-back.
let lastKickAt = 0;
function requestRefresh() {
  const now = Date.now();
  if (refreshing || now - lastKickAt < msEnv('CK_MODELS_MIN_REFRESH_MS', 60 * 1000)) return false;
  lastKickAt = now;
  refresh().catch(() => {});
  return true;
}

function start() {
  if (process.env.CK_MODELS_DISABLE_REFRESH === '1') return;
  if (timer) return;
  ensureLoaded();
  refresh().catch(() => {});
  timer = setInterval(() => { refresh().catch(() => {}); }, msEnv('CK_MODELS_REFRESH_MS', DEFAULT_REFRESH_MS));
  if (timer.unref) timer.unref();
}

// ---------- sync public API (request path) ----------
function getCatalog() {
  return JSON.parse(JSON.stringify(ensureLoaded()));
}

function findModel(provider, id) {
  const entry = ensureLoaded()[provider];
  return entry ? entry.models.find(m => m.id === id) || null : null;
}

function isAllowedModel(provider, id) {
  if (!PROVIDERS.includes(provider) || typeof id !== 'string') return false;
  if (provider === 'ollama') return isOllamaId(id); // format only: the local list changes between refreshes
  return isSafeId(id) && !!findModel(provider, id);
}

function effortsFor(provider, id) {
  if (provider !== 'claude' && provider !== 'codex') return [];
  const m = findModel(provider, id);
  return m && Array.isArray(m.efforts) ? [...m.efforts] : [];
}

function defaultModel(provider) {
  const entry = ensureLoaded()[provider];
  return entry ? entry.default : null;
}

function defaultEffort(provider, id) {
  if (provider !== 'claude' && provider !== 'codex') return 'medium';
  const entry = ensureLoaded()[provider];
  const m = findModel(provider, id == null ? entry.default : id);
  const efforts = m && m.efforts && m.efforts.length ? m.efforts : entry.efforts;
  const pick = [entry.defaultEffort, m && m.defaultEffort, 'medium'].find(e => e && efforts.includes(e));
  return pick || efforts[0] || 'medium';
}

// Tests: replace (partially) the in-memory catalog; null resets to a cold state.
function _setCatalogForTests(obj) {
  if (obj == null) { catalog = null; agyAttemptAt = 0; lastKickAt = 0; return; }
  const base = ensureLoaded();
  const next = { ...base };
  for (const p of PROVIDERS) {
    if (!obj[p]) continue;
    const e = sanitizeEntry(p, { source: 'live', asOf: Date.now(), ...obj[p] });
    if (e) next[p] = e;
  }
  catalog = next;
}

module.exports = {
  getCatalog, isAllowedModel, effortsFor, defaultModel, defaultEffort, refresh, requestRefresh, start,
  SAFE_ID_RE, isSafeId, isOllamaId, _setCatalogForTests,
  // exported for unit tests
  _parseCodexCatalog: parseCodexCatalog, _parseAgy: parseAgy, _readClaudeCatalog: readClaudeCatalog,
};
