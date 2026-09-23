// models.test.js — the auto-discovered model registry (src/models.js). Every source is a fixture:
// a temp Claude catalog dir, fake `codex`/`agy` bins (tiny scripts), a temp codex models_cache.json,
// an unreachable Ollama URL. The real CLIs / network are never touched.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = ['CK_MODELS_CACHE', 'CK_CLAUDE_CATALOG_DIR', 'CK_CODEX_BIN', 'CK_CODEX_MODELS_CACHE',
  'CK_CODEX_CONFIG', 'CK_AGY_BIN', 'CK_AGY_REFRESH_MS', 'CK_CLAUDE_VERSION', 'CK_OLLAMA_URL', 'CK_MODELS_DISABLE_REFRESH',
  'CK_MODELS_MIN_REFRESH_MS', 'PATH', 'HOME'];
let saved;
let dir;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmodels-'));
  fs.mkdirSync(path.join(dir, 'claude'));
  process.env.CK_MODELS_CACHE = path.join(dir, 'models-cache.json');
  process.env.CK_CLAUDE_CATALOG_DIR = path.join(dir, 'claude');
  process.env.CK_CODEX_BIN = path.join(dir, 'no-codex');
  process.env.CK_CODEX_MODELS_CACHE = path.join(dir, 'no-codex-cache.json');
  process.env.CK_CODEX_CONFIG = path.join(dir, 'config.toml');
  process.env.CK_AGY_BIN = path.join(dir, 'no-agy');
  process.env.CK_CLAUDE_VERSION = '3.0.0';
  process.env.CK_OLLAMA_URL = 'http://127.0.0.1:9'; // discard port: refused instantly → ollama fallback
  process.env.CK_MODELS_DISABLE_REFRESH = '1';
  delete process.env.CK_AGY_REFRESH_MS;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
});

function fresh() {
  delete require.cache[require.resolve('../models.js')];
  return require('../models.js');
}
function bin(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}
function nodeBinPrinting(name, text) {
  const data = path.join(dir, name + '.out');
  fs.writeFileSync(data, text);
  return bin(name, `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(data)}, 'utf8'));\n`);
}
const ids = entry => entry.models.map(m => m.id);

const SECRET_ORG = 'org-SECRET-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
function claudeModel(id, name, short, section, efforts, extra = {}) {
  return { id, name, short_name: short, section, thinking: { type: 'effort', effort_options: efforts.map(e => ({ id: e, name: e })) }, ...extra };
}
function writeClaudeCatalog(file, surface, fetchedAt, models, stateModel, extraTop = {}) {
  fs.writeFileSync(path.join(dir, 'claude', file), JSON.stringify({
    version: 1, fetchedAt, staleAt: fetchedAt + 1000, organizationUuid: SECRET_ORG, resolution: { secret: SECRET_ORG }, ...extraTop,
    catalog: { surface, config: { models }, state: { id: surface, model: stateModel, thinking: { type: 'effort', effort: 'high' } } },
  }));
}

const CODEX_FIXTURE = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 5, default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], base_instructions: 'SECRET PROMPT' },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: 'd' })), base_instructions: 'SECRET PROMPT' },
    { slug: 'codex-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'bad;rm -rf', display_name: 'Bad', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }] },
  ],
};

test('cold registry with no sources serves the hardcoded fallbacks (never empty)', () => {
  const m = fresh();
  const c = m.getCatalog();
  for (const p of ['claude', 'codex', 'ollama', 'agy']) {
    assert.ok(c[p].models.length > 0, p + ' non-empty');
    assert.equal(c[p].source, 'fallback');
  }
  assert.deepEqual(ids(c.claude).slice(0, 4), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(ids(c.claude).includes('claude-opus-5-5'));
  assert.equal(c.claude.default, 'sonnet');
  assert.deepEqual(ids(c.codex), ['gpt-6-astra']);
  assert.deepEqual(m.effortsFor('codex', 'gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(m.effortsFor('codex', 'gpt-6-astra').includes('minimal'), false);
  assert.equal(ids(c.agy)[0], 'antigravity');
  assert.ok(ids(c.agy).includes('gemini-3.8-flash-low'));
  assert.equal(m.defaultModel('ollama'), 'qwen2.5-coder:32b');
  assert.deepEqual(m.effortsFor('agy', 'antigravity'), []);
  assert.deepEqual(m.effortsFor('ollama', 'qwen2.5-coder:32b'), []);
});

test('claude: newest cc file wins over ccd; aliases first; [1m] + too-new dropped; organizationUuid never emitted', () => {
  writeClaudeCatalog('old-cc.json', 'cc', 1000, [claudeModel('claude-old-1', 'Old 1', 'Opus', 'main', ['low'])], 'claude-old-1');
  writeClaudeCatalog('new-ccd.json', 'ccd', 9000, [claudeModel('claude-ccd-only', 'CCD', 'Opus', 'main', ['low'])], 'claude-ccd-only');
  writeClaudeCatalog('new-cc.json', 'cc', 5000, [
    claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus', 'main', ['low', 'medium', 'high', 'xhigh', 'max']),
    claudeModel('claude-sonnet-5', 'Sonnet 5', 'Sonnet', 'main', ['low', 'medium', 'high']),
    claudeModel('claude-fable-5-1[1m]', 'Fable 1M', 'Fable', 'overflow', ['low']),
    claudeModel('claude-future-9', 'Future', 'Future', 'overflow', ['low'], { min_claude_code_version: '9.0.0' }),
    claudeModel('claude-haiku-4-5-20251001', 'Haiku 4.5', 'Haiku', 'overflow', []),
  ], 'claude-opus-5-5');
  fs.writeFileSync(path.join(dir, 'claude', 'garbage.json'), '{not json');
  const m = fresh();
  const c = m.getCatalog();
  const list = ids(c.claude);
  assert.deepEqual(list.slice(0, 4), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(list.includes('claude-opus-5-5'));
  assert.ok(!list.includes('claude-ccd-only'), 'cc surface preferred over a newer ccd file');
  assert.ok(!list.includes('claude-old-1'), 'newest cc by fetchedAt');
  assert.ok(!list.some(id => id.includes('[')), '[1m] ids filtered');
  assert.ok(!list.includes('claude-future-9'), 'min_claude_code_version above installed is skipped');
  assert.equal(c.claude.default, 'claude-opus-5-5');
  assert.equal(c.claude.source, 'live');
  assert.match(c.claude.models.find(x => x.id === 'opus').label, /Opus 5\.5/);
  assert.deepEqual(m.effortsFor('claude', 'claude-sonnet-5'), ['low', 'medium', 'high']);
  assert.ok(m.effortsFor('claude', 'claude-haiku-4-5-20251001').length > 0, 'haiku keeps a standard effort list');
  assert.equal(m.isAllowedModel('claude', 'claude-fable-5-1[1m]'), false);
  const json = JSON.stringify(c);
  assert.ok(!json.includes(SECRET_ORG) && !/organization/i.test(json), 'no org uuid in output');
  // the disk cache written on refresh must not carry it either
  return m.refresh().then(() => {
    const disk = fs.readFileSync(process.env.CK_MODELS_CACHE, 'utf8');
    assert.ok(!disk.includes(SECRET_ORG) && !/organization/i.test(disk));
  });
});

test('claude: falls back to the newest ccd file when no cc file exists (ccd carries organizationUuid)', () => {
  writeClaudeCatalog('a-ccd.json', 'ccd', 100, [claudeModel('claude-opus-5', 'Opus 5', 'Opus', 'main', ['low', 'high'])], 'claude-opus-5');
  writeClaudeCatalog('b-ccd.json', 'ccd', 200, [claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus', 'main', ['low', 'high'])], 'claude-opus-5-5');
  const m = fresh();
  const c = m.getCatalog();
  assert.ok(ids(c.claude).includes('claude-opus-5-5'));
  assert.ok(!ids(c.claude).includes('claude-opus-5'));
  assert.equal(c.claude.default, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(c).includes(SECRET_ORG));
});

test('codex: live `codex debug models` → list-visible, priority-sorted, per-model efforts, config default, no extra fields', async () => {
  process.env.CK_CODEX_BIN = nodeBinPrinting('codex', JSON.stringify(CODEX_FIXTURE));
  fs.writeFileSync(process.env.CK_CODEX_CONFIG, 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "gpt-6-astra"\n');
  const m = fresh();
  const c = await m.refresh();
  assert.equal(c.codex.source, 'live');
  assert.deepEqual(ids(c.codex), ['gpt-6-astra', 'gpt-5.5']);
  assert.equal(c.codex.default, 'gpt-5.5', 'top-level config.toml model wins, [profiles] ignored');
  assert.deepEqual(m.effortsFor('codex', 'gpt-5.5'), ['low', 'medium', 'high']);
  assert.deepEqual(m.effortsFor('codex', 'gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(m.isAllowedModel('codex', 'codex-hidden'), false);
  assert.equal(m.defaultEffort('codex', 'gpt-5.5'), 'high');
  assert.ok(!JSON.stringify(c).includes('SECRET PROMPT'), 'base_instructions dropped');
});

test('codex: failing bin → models_cache.json fallback → hardcoded gpt-6-astra', async () => {
  process.env.CK_CODEX_BIN = bin('codex-fail', '#!/bin/sh\necho boom >&2\nexit 1\n');
  const cacheFixture = { models: [{ slug: 'gpt-5.6-sol', display_name: 'Sol', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] };
  fs.writeFileSync(process.env.CK_CODEX_MODELS_CACHE, JSON.stringify(cacheFixture));
  let m = fresh();
  let c = await m.refresh();
  assert.deepEqual(ids(c.codex), ['gpt-5.6-sol']);
  assert.equal(c.codex.source, 'cache');

  fs.rmSync(process.env.CK_CODEX_MODELS_CACHE);
  fs.rmSync(process.env.CK_MODELS_CACHE, { force: true });
  m = fresh();
  c = await m.refresh();
  assert.deepEqual(ids(c.codex), ['gpt-6-astra']);
  assert.equal(c.codex.source, 'fallback');
  // non-JSON stdout is a failure too
  process.env.CK_CODEX_BIN = nodeBinPrinting('codex-junk', 'not json at all');
  fs.rmSync(process.env.CK_MODELS_CACHE, { force: true });
  m = fresh();
  c = await m.refresh();
  assert.deepEqual(ids(c.codex), ['gpt-6-astra']);
});

test('agy: tab-separated `agy models` output parsed, antigravity first; empty output → seed list', async () => {
  process.env.CK_AGY_BIN = nodeBinPrinting('agy', 'Available models:\ngemini-9-pro\tGemini 9 Pro\nBAD_ID\tx\nbad;id\tx\ngemini-9-flash\tGemini 9 Flash\n');
  let m = fresh();
  let c = await m.refresh();
  assert.equal(c.agy.source, 'live');
  assert.deepEqual(ids(c.agy), ['antigravity', 'gemini-9-pro', 'gemini-9-flash']);
  assert.equal(c.agy.default, 'antigravity');

  process.env.CK_AGY_BIN = nodeBinPrinting('agy-empty', '');
  fs.rmSync(process.env.CK_MODELS_CACHE, { force: true });
  m = fresh();
  c = await m.refresh();
  assert.equal(ids(c.agy)[0], 'antigravity');
  assert.ok(ids(c.agy).includes('gemini-3.1-pro-high'));
  assert.ok(ids(c.agy).includes('gemini-3.8-flash-low'));
});

test('agy: `agy models` runs at most once per CK_AGY_REFRESH_MS window', async () => {
  const counter = path.join(dir, 'agy-calls.log');
  process.env.CK_AGY_BIN = bin('agy-count', `#!/bin/sh\necho x >> "${counter}"\nprintf 'gemini-9-pro\\tGemini 9 Pro\\n'\n`);
  process.env.CK_AGY_REFRESH_MS = String(60 * 60 * 1000);
  const m = fresh();
  await m.refresh();
  await m.refresh();
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
  assert.ok(m.isAllowedModel('agy', 'gemini-9-pro'), 'kept between throttled refreshes');
  // also across a restart (window persisted in the disk cache)
  const m2 = fresh();
  await m2.refresh();
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
});

test('last-good catalog survives a failed refresh (in memory and across restart)', async () => {
  process.env.CK_CODEX_BIN = nodeBinPrinting('codex', JSON.stringify(CODEX_FIXTURE));
  process.env.CK_AGY_BIN = nodeBinPrinting('agy', 'gemini-9-pro\tGemini 9 Pro\n');
  process.env.CK_AGY_REFRESH_MS = '1';
  const m = fresh();
  await m.refresh();
  assert.ok(m.isAllowedModel('codex', 'gpt-5.5'));

  // sources break
  process.env.CK_CODEX_BIN = bin('codex-fail', '#!/bin/sh\nexit 3\n');
  process.env.CK_AGY_BIN = bin('agy-fail', '#!/bin/sh\nexit 3\n');
  await new Promise(r => setTimeout(r, 5));
  const c = await m.refresh();
  assert.deepEqual(ids(c.codex), ['gpt-6-astra', 'gpt-5.5'], 'last good codex list kept');
  assert.equal(c.codex.source, 'cache');
  assert.deepEqual(ids(c.agy), ['antigravity', 'gemini-9-pro'], 'last good agy list kept');

  // restart with every source still broken: the disk cache is the last good
  const m2 = fresh();
  assert.ok(m2.isAllowedModel('codex', 'gpt-5.5'));
  assert.ok(m2.isAllowedModel('agy', 'gemini-9-pro'));
  assert.equal(m2.getCatalog().codex.source, 'cache');
});

test('a tampered disk cache is sanitized on load (unsafe ids, unknown fields dropped)', () => {
  fs.writeFileSync(process.env.CK_MODELS_CACHE, JSON.stringify({
    providers: { codex: { models: [{ id: '$(touch x)', label: 'x' }, { id: 'gpt-7', label: 'GPT-7', efforts: ['low', 'bad effort'], secret: 'S3CR3T' }], default: 'gpt-7', source: 'live' } },
  }));
  const m = fresh();
  const c = m.getCatalog();
  assert.deepEqual(ids(c.codex), ['gpt-7']);
  assert.deepEqual(m.effortsFor('codex', 'gpt-7'), ['low']);
  assert.ok(!JSON.stringify(c).includes('S3CR3T'));
});

test('safety: SAFE_ID_RE / isAllowedModel reject shell-unsafe and [1m] ids; ollama allows namespaces but not ..', () => {
  const m = fresh();
  for (const bad of ['claude-x[1m]', 'a;b', '$(x)', 'a b', '-rf', '', '`id`', 'a|b', 'x'.repeat(65)]) {
    assert.equal(m.isSafeId(bad), false, bad);
    assert.equal(m.SAFE_ID_RE.test(bad), false, bad);
    assert.equal(m.isAllowedModel('claude', bad), false, bad);
    assert.equal(m.isAllowedModel('codex', bad), false, bad);
    assert.equal(m.isAllowedModel('agy', bad), false, bad);
  }
  assert.equal(m.isSafeId('gpt-5.6-sol'), true);
  assert.equal(m.isAllowedModel('ollama', 'library/qwen2.5-coder:32b'), true);
  assert.equal(m.isAllowedModel('ollama', 'hf.co/org/model:q4'), true);
  assert.equal(m.isAllowedModel('ollama', 'not-installed-yet:1b'), true, 'ollama is format-checked, not membership');
  for (const bad of ['../x', 'a/../b', './x', 'a;b', '$(x)', 'a b', '/abs', 'x/']) assert.equal(m.isAllowedModel('ollama', bad), false, bad);
  assert.equal(m.isAllowedModel('nope', 'sonnet'), false);
});

test('start() is a no-op when CK_MODELS_DISABLE_REFRESH=1 (no CLI spawned)', async () => {
  const counter = path.join(dir, 'codex-calls.log');
  process.env.CK_CODEX_BIN = bin('codex-count', `#!/bin/sh\necho x >> "${counter}"\nexit 1\n`);
  const m = fresh();
  m.start();
  m.getCatalog();
  m.isAllowedModel('codex', 'gpt-6-astra');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.existsSync(counter), false);
});

const realInstalled = name => ['/opt/homebrew/bin', '/usr/local/bin'].some(d => fs.existsSync(path.join(d, name)));

test('bin resolution: PATH hit is used; child PATH gets /opt/homebrew/bin etc. prepended (codex needs node)', async () => {
  delete process.env.CK_CODEX_BIN;
  process.env.HOME = dir;
  const pathDump = path.join(dir, 'child-path.txt');
  const pathDir = path.join(dir, 'pathbin');
  fs.mkdirSync(pathDir);
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(CODEX_FIXTURE));
  fs.writeFileSync(path.join(pathDir, 'codex'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pathDump)}, process.env.PATH);\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(dir, 'codex.json'))}, 'utf8'));\n`);
  fs.chmodSync(path.join(pathDir, 'codex'), 0o755);
  process.env.PATH = pathDir + ':/usr/bin:/bin';
  const m = fresh();
  const c = await m.refresh();
  assert.equal(c.codex.source, 'live');
  assert.deepEqual(ids(c.codex), ['gpt-6-astra', 'gpt-5.5']);
  const childPath = fs.readFileSync(pathDump, 'utf8').split(':');
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', path.join(dir, '.local', 'bin'), pathDir, '/usr/bin']) assert.ok(childPath.includes(d), 'child PATH has ' + d);
  assert.ok(childPath.indexOf('/opt/homebrew/bin') < childPath.indexOf('/usr/bin'), 'extra dirs prepended');
});

test('bin resolution: launchd PATH (no override) falls back to ~/.local/bin', { skip: realInstalled('agy') ? 'a real agy is installed in /opt/homebrew/bin or /usr/local/bin (checked first)' : false }, async () => {
  delete process.env.CK_AGY_BIN; // codex keeps its (missing) override so the real codex is never run
  process.env.HOME = dir;
  const local = path.join(dir, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'agy'), `#!/bin/sh\nprintf 'gemini-9-pro\\tGemini 9 Pro\\n'\n`);
  fs.chmodSync(path.join(local, 'agy'), 0o755);
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const m = fresh();
  const c = await m.refresh();
  assert.equal(c.agy.source, 'live');
  assert.deepEqual(ids(c.agy), ['antigravity', 'gemini-9-pro']);
});

test('agy: a missing binary does not burn the 6h window (retried once it is installed)', async () => {
  process.env.CK_AGY_REFRESH_MS = String(60 * 60 * 1000);
  process.env.CK_AGY_BIN = path.join(dir, 'agy-not-yet'); // ENOENT
  const m = fresh();
  let c = await m.refresh();
  assert.equal(c.agy.source, 'fallback');
  // installed later: the very next refresh runs it (window was not consumed by the ENOENT)
  nodeBinPrinting('agy-not-yet', 'gemini-9-pro\tGemini 9 Pro\n');
  c = await m.refresh();
  assert.equal(c.agy.source, 'live');
  assert.deepEqual(ids(c.agy), ['antigravity', 'gemini-9-pro']);
  // with no override and nothing on PATH/fallback dirs it is also a no-run
  delete process.env.CK_AGY_BIN;
  process.env.HOME = dir;
  process.env.PATH = path.join(dir, 'empty-path');
  const m2 = fresh();
  fs.rmSync(process.env.CK_MODELS_CACHE, { force: true });
  await m2.refresh();
  const disk = JSON.parse(fs.readFileSync(process.env.CK_MODELS_CACHE, 'utf8'));
  if (!realInstalled('agy')) assert.equal(disk.agyAttemptAt, 0);
});

test('requestRefresh (the ?refresh=1 kick) runs at most once per CK_MODELS_MIN_REFRESH_MS', async () => {
  const counter = path.join(dir, 'codex-calls.log');
  process.env.CK_CODEX_BIN = bin('codex-count', `#!/bin/sh\necho x >> "${counter}"\nexit 1\n`);
  process.env.CK_MODELS_MIN_REFRESH_MS = '60000';
  const m = fresh();
  assert.equal(m.requestRefresh(), true);
  assert.equal(m.requestRefresh(), false, 'in flight');
  await m.refresh(); // joins the in-flight refresh
  for (let i = 0; i < 5; i++) assert.equal(m.requestRefresh(), false, 'throttled');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'codex spawned once');
  process.env.CK_MODELS_MIN_REFRESH_MS = '1';
  await new Promise(r => setTimeout(r, 5));
  assert.equal(m.requestRefresh(), true, 'allowed again after the interval');
  await m.refresh();
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2);
});

test('claude default: state.model alias is kept; a [1m] suffix is stripped before lookup; else sonnet', () => {
  const opus = claudeModel('claude-opus-5-5', 'Opus 5.5', 'Opus', 'main', ['low', 'high']);
  writeClaudeCatalog('a-cc.json', 'cc', 100, [opus], 'opus');
  assert.equal(fresh().getCatalog().claude.default, 'opus');
  writeClaudeCatalog('a-cc.json', 'cc', 100, [opus], 'claude-opus-5-5[1m]');
  assert.equal(fresh().getCatalog().claude.default, 'claude-opus-5-5');
  writeClaudeCatalog('a-cc.json', 'cc', 100, [opus], 'fable[1m]');
  assert.equal(fresh().getCatalog().claude.default, 'fable');
  writeClaudeCatalog('a-cc.json', 'cc', 100, [opus], 'claude-gone-1');
  assert.equal(fresh().getCatalog().claude.default, 'sonnet');
});
