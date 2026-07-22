// ~/.claude/agent-dashboard/test/server-usage.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3897;
const BASE = `http://localhost:${PORT}`;

test('/api/usage serves the cache; /api/sessions includes context', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'srvusage-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvusage-codex-'));
  // seed a usage cache
  fs.writeFileSync(path.join(state, 'usage-cache.json'), JSON.stringify({ generatedAt: Date.now(), block: { totalTokens: 999, costUSD: 1.23 }, week: null }));
  // seed a session with a transcript that has usage
  fs.mkdirSync(path.join(state, 'sessions'), { recursive: true });
  const tr = path.join(state, 'tr.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 0, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0 } } }));
  fs.writeFileSync(path.join(state, 'sessions', 'a.json'), JSON.stringify({ sessionId: 'a', state: 'running', lastActivityAt: Date.now(), transcriptPath: tr }));
  const dayDir = path.join(codexDir, '2026', '07', '19');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-codex.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'cx', cwd: state, originator: 'cli' } }) + '\n');

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_CODEX_DIR: codexDir, CK_CCUSAGE_CMD: '/usr/bin/false' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 700));
    const usage = await (await fetch(`${BASE}/api/usage`)).json();
    assert.equal(usage.block.totalTokens, 999);
    assert.equal(usage.framing, undefined, 'volume mode omits framing');
    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const weekLabel = [weekStart.getFullYear(), String(weekStart.getMonth() + 1).padStart(2, '0'), String(weekStart.getDate()).padStart(2, '0')].join('-');
    fs.writeFileSync(path.join(state, 'usage-cache.json'), JSON.stringify({
      generatedAt: Date.now(),
      week: { week: weekLabel, totalTokens: 500 },
      weeklyTokenCap: 1000,
    }));
    const framedUsage = await (await fetch(`${BASE}/api/usage`)).json();
    assert.match(framedUsage.framing, /^≈\d+ days? of weekly limit left at the current pace$/);
    const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
    const a = sessions.find(s => s.sessionId === 'a');
    assert.ok(a.context, 'session should carry context');
    assert.equal(a.context.tokens, 500000);
    assert.equal(a.context.limit, 1000000);
    assert.equal(a.context.pct, 0.6); // usable-window normalization: 500k / (1M * 0.835) → 0.6
    assert.equal(a.provider, 'claude', 'legacy session files default to Claude');
    const cx = sessions.find(s => s.sessionId === 'cx');
    assert.equal(cx.provider, 'codex');
    assert.equal(cx.state, 'running');
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 200);
  } finally { srv.kill(); fs.rmSync(codexDir, { recursive: true, force: true }); }
});
