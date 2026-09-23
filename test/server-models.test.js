// server-models.test.js — GET /api/models serves the sanitized registry (no secret fields), ?refresh=1
// is non-blocking, and /api/new-chat-defaults swaps a retired saved model for the provider default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3951;
const BASE = `http://localhost:${PORT}`;
const SECRET_ORG = 'org-SECRET-9a8b7c6d-5e4f-3a2b-1c0d-ffeeddccbbaa';

test('GET /api/models: all four providers, sanitized, no secret fields; retired default model replaced', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmodels-srv-'));
  const catalogDir = path.join(state, 'claude-catalog');
  fs.mkdirSync(catalogDir);
  fs.writeFileSync(path.join(catalogDir, 'tok-ccd.json'), JSON.stringify({
    version: 1, fetchedAt: 1000, organizationUuid: SECRET_ORG, resolution: { org: SECRET_ORG },
    catalog: { surface: 'ccd', config: { models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', section: 'main', thinking: { effort_options: [{ id: 'low' }, { id: 'high' }] } },
      { id: 'claude-fable-5-1[1m]', name: 'Fable 1M', short_name: 'Fable', section: 'overflow' },
    ] }, state: { model: 'claude-opus-5-5' } },
  }));
  const cache = path.join(state, 'models-cache.json');
  fs.writeFileSync(cache, JSON.stringify({ providers: { codex: {
    models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'high'], base_instructions: 'SECRET PROMPT' }],
    default: 'gpt-6-astra', source: 'live', token: 'SECRET TOKEN',
  } } }));
  fs.writeFileSync(path.join(state, 'new-chat-defaults.json'), JSON.stringify({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'minimal' }));
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_TEST_CMD: 'sleep 5', CK_CCUSAGE_CMD: '/usr/bin/false',
      CK_MODELS_DISABLE_REFRESH: '1', CK_MODELS_CACHE: cache, CK_CLAUDE_CATALOG_DIR: catalogDir, CK_CLAUDE_VERSION: '99.0.0',
      CK_CODEX_BIN: path.join(state, 'no-codex'), CK_CODEX_MODELS_CACHE: path.join(state, 'no-codex-cache.json'),
      CK_CODEX_CONFIG: path.join(state, 'no-config.toml'), CK_AGY_BIN: path.join(state, 'no-agy'), CK_OLLAMA_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const res = await fetch(`${BASE}/api/models`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const text = await res.text();
    const cat = JSON.parse(text);
    assert.deepEqual(Object.keys(cat).sort(), ['agy', 'claude', 'codex', 'ollama']);
    for (const p of Object.keys(cat)) {
      assert.ok(Array.isArray(cat[p].models) && cat[p].models.length > 0, p);
      assert.equal(typeof cat[p].default, 'string');
      assert.ok(['live', 'cache', 'fallback'].includes(cat[p].source));
      for (const m of cat[p].models) {
        for (const k of Object.keys(m)) assert.ok(['id', 'label', 'group', 'efforts', 'defaultEffort'].includes(k), `${p} model field ${k}`);
      }
    }
    for (const secret of [SECRET_ORG, 'SECRET PROMPT', 'SECRET TOKEN', 'organization', 'base_instructions', '[1m]']) {
      assert.ok(!text.includes(secret), 'must not leak: ' + secret);
    }
    assert.ok(cat.claude.models.some(m => m.id === 'claude-opus-5-5'));
    assert.equal(cat.claude.default, 'claude-opus-5-5');
    assert.deepEqual(cat.codex.models.map(m => m.id), ['gpt-6-astra']);
    assert.equal(cat.agy.models[0].id, 'antigravity');

    // ?refresh=1 is non-blocking and still returns the current catalog
    const t0 = Date.now();
    const r2 = await fetch(`${BASE}/api/models?refresh=1`);
    assert.equal(r2.status, 200);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok((await r2.json()).codex.models.length > 0);

    // saved default model no longer offered → provider default (and a valid effort)
    const defaults = await (await fetch(`${BASE}/api/new-chat-defaults`)).json();
    assert.equal(defaults.provider, 'codex');
    assert.equal(defaults.model, 'gpt-6-astra');
    assert.ok(['low', 'high'].includes(defaults.effort));
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 100));
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('/api/new-chat-defaults repairs an invalid effort for a still-offered model; ?refresh=1 is throttled (codex spawned once)', async () => {
  const PORT2 = 3953;
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckmodels-srv2-'));
  const counter = path.join(state, 'codex-calls.log');
  const codexBin = path.join(state, 'codex-count');
  fs.writeFileSync(codexBin, `#!/bin/sh\necho x >> "${counter}"\nexit 1\n`);
  fs.chmodSync(codexBin, 0o755);
  const cache = path.join(state, 'models-cache.json');
  fs.writeFileSync(cache, JSON.stringify({ providers: { codex: {
    models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
    default: 'gpt-6-astra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', source: 'live',
  } } }));
  fs.writeFileSync(path.join(state, 'new-chat-defaults.json'), JSON.stringify({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }));
  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT2), COCKPIT_DIR: state, CK_TEST_CMD: 'sleep 5', CK_CCUSAGE_CMD: '/usr/bin/false',
      CK_MODELS_DISABLE_REFRESH: '1', CK_MODELS_CACHE: cache, CK_CLAUDE_CATALOG_DIR: path.join(state, 'none'),
      CK_CODEX_BIN: codexBin, CK_CODEX_MODELS_CACHE: path.join(state, 'no-codex-cache.json'),
      CK_CODEX_CONFIG: path.join(state, 'no-config.toml'), CK_AGY_BIN: path.join(state, 'no-agy'), CK_OLLAMA_URL: 'http://127.0.0.1:9',
      CK_MODELS_MIN_REFRESH_MS: '60000' },
    stdio: 'ignore',
  });
  try {
    // wait for the server under suite load (poll instead of a fixed sleep)
    for (let i = 0; i < 100; i++) {
      try { await fetch(`http://localhost:${PORT2}/api/new-chat-defaults`); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }
    const defaults = await (await fetch(`http://localhost:${PORT2}/api/new-chat-defaults`)).json();
    assert.equal(defaults.model, 'gpt-6-astra', 'still-offered model kept');
    assert.equal(defaults.effort, 'medium', 'invalid effort repaired to the model default');

    const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0);
    assert.equal((await fetch(`http://localhost:${PORT2}/api/models?refresh=1`)).status, 200);
    for (let i = 0; i < 100 && !calls(); i++) await new Promise(r => setTimeout(r, 100)); // first kick spawns codex
    assert.equal(calls(), 1);
    await new Promise(r => setTimeout(r, 1000)); // let that refresh finish, so only the 60s window can block
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://localhost:${PORT2}/api/models?refresh=1`);
      assert.equal(r.status, 200);
      await new Promise(res => setTimeout(res, 100));
    }
    await new Promise(r => setTimeout(r, 1000));
    assert.equal(calls(), 1, 'codex spawned once despite repeated ?refresh=1');
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 100));
    fs.rmSync(state, { recursive: true, force: true });
  }
});
