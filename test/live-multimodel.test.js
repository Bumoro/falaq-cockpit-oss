const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('/live exposes provider-aware cards, usage tiles, and chat launch controls', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');
  assert.match(html, /class="badge provider"/);
  assert.match(html, /<select id="mProvider">/);
  assert.match(html, /value="codex">Codex/);
  assert.match(html, /value="ollama">Ollama/);
  assert.match(html, /value="agy">Antigravity/);
  assert.match(html, /provider:document\.getElementById\('mProvider'\)\.value/);
  assert.match(html, /<span class="cap">claude<\/span>/);
  assert.match(html, /<span class="cap">codex<\/span>/);
  assert.match(html, /usage&&usage\.codexWeek/);
  assert.match(html, /usage&&usage\.codexBlock/);
  assert.match(html, /usage&&usage\.ollamaWeek/);
  assert.match(html, /usage&&usage\.ollamaBlock/);
  assert.match(html, /<span class="cap">ollama<\/span>/);
  assert.match(html, /ollamaBlock\.totalTokens/);
  assert.match(html, /ollamaWeek\.totalTokens/);
  assert.match(html, /let codexSub='no Codex activity'/);
  assert.match(html, /function groupedCardsHtml\(cards\)/);
  assert.match(html, /const order=\['claude','codex','ollama','antigravity'\]/);
  assert.match(html, /if\(present\.length<=1\)return cards\.map\(cardHtml\)\.join\(''\)/);
  assert.match(html, /\/api\/models/);
  assert.doesNotMatch(html, /<option>minimal<\/option>/);
  assert.match(html, /function setModelEfforts\(/);
  assert.match(html, /High context/);
  assert.match(html, /c\.chat&&c\.chat\.cwd===t\.cwd/);
  assert.match(html, /<h2 class="sec">Active Tasks<\/h2>/);
  assert.match(html, /stale tasks ·/);
  assert.match(html, /staleTasksOpen\?'hide':'show'/);
  assert.match(html, /data-action="task-done"/);
  assert.match(html, /data-action="task-abandon"/);
  assert.match(html, /data-action="clear-stale-tasks"/);
  assert.match(html, /purposeTitle\|\|/);
  assert.match(html, /document\.title=.*purpose/);
  assert.match(html, /⚠ Duplicate work detected/);
  assert.match(html, /Save &amp; kill:/);
  assert.match(html, /\/api\/sessions\/save-kill/);
  assert.match(html, /not a duplicate/);
  assert.match(html, /open both/);
  assert.match(html, /Needs you:/);
  assert.match(html, /at this pace:/);
  assert.match(html, /usage&&usage\.framing/);
  assert.match(html, /toggle-active-filter/);
  assert.match(html, /While you were away/);
  assert.match(html, /tool calls · last 24h/);
  assert.match(html, /tool calls · last 7d/);
});

test('/live renders Ollama usage as conditional token-only tiles and opens mediated cards in chat', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');
  assert.match(html, /if\(ollamaWeek\)tiles\.push/);
  assert.match(html, /if\(ollamaBlock\)secondary\.push/);
  assert.match(html, /x\.chat&&x\.chat\.mediated\?'open-chat':'open-panel'/);
  assert.match(html, /'open-chat':el=>location='\/chat\?name='\+encodeURIComponent\(el\.dataset\.chat\)/);
  assert.match(html, /if\(chat\.mediated\)location='\/chat\?name='\+encodeURIComponent\(chat\.name\)/);

  const ollamaTileSource = html.slice(
    html.indexOf('const ollamaBlock=usage&&usage.ollamaBlock'),
    html.indexOf('tiles.push(...secondary)')
  );
  assert.ok(ollamaTileSource, 'Ollama tile source must be present');
  assert.doesNotMatch(ollamaTileSource, /cost|['"]\$['"]/i);
  assert.doesNotMatch(ollamaTileSource, /blockPct|meter/);
});

test('/chat polls mediated history, shows thinking, and surfaces busy-guard errors', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/chat.html'), 'utf8');
  assert.match(html, /if\(\(chat&&chat\.mediated\)\|\|s\.transcriptPath\|\|openTP\|\|closedTP\)/);
  assert.match(html, /mediatedAwaiting/);
  assert.match(html, /Thinking…/);
  assert.match(html, /if\(!r\.ok\)throw new Error\(body\.error\|\|'Could not send message\.'\)/);
  assert.match(html, /setComposerError\(e\.message\|\|'Could not send message\.'\)/);
  assert.match(html, /input\.disabled=false/);
});

test('desktop and mobile correlate Ollama and Antigravity chats with provider sessions', () => {
  for (const file of ['live.html', 'mobile.html']) {
    const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', file), 'utf8');
    assert.match(html, /const ollamaMatch=c\.provider==='ollama'&&c\.alive&&sessions\.find\(s=>s\.provider==='ollama'&&s\.context&&s\.context\.model===c\.model&&!claimed\.has\(s\.sessionId\)\);/);
    assert.match(html, /const legacyMatch=\(!c\.provider\|\|c\.provider==='claude'\)&&sessions\.find\(s=>!s\.chatName&&\(s\.provider\|\|'claude'\)==='claude'&&s\.cwd===c\.cwd/);
    assert.match(html, /const unclaimedAgy=sessions\.filter\(s=>s\.provider==='antigravity'&&!claimed\.has\(s\.sessionId\)\);/);
    assert.match(html, /const agyMatch=c\.provider==='agy'&&\(unclaimedAgy\.find\(s=>s\.cwd&&\(s\.cwd===c\.cwd\|\|s\.cwd===\(c\.requestedCwd\|\|c\.cwd\)\)\)\|\|\(c\.alive&&unclaimedAgy\.length===1&&!chats\.some\(other=>other!==c&&other\.provider==='agy'&&other\.alive\)&&unclaimedAgy\[0\]\)\);/);
    assert.match(html, /const m=named\[0\]\|\|codexMatch\|\|ollamaMatch\|\|agyMatch\|\|legacyMatch;/);
  }
});

test('desktop and mobile group cards by the same normalized provider keys', () => {
  for (const file of ['live.html', 'mobile.html']) {
    const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', file), 'utf8');
    assert.match(html, /function providerKey\(x\)\{const p=\(x&&x\.provider\)\|\|'claude';return p==='agy'\?'antigravity':p;\}/, file);
    assert.match(html, /function groupedCardsHtml\(cards\)/, file);
    assert.match(html, /const order=\['claude','codex','ollama','antigravity'\]/, file);
    assert.match(html, /const present=order\.filter\(p=>cards\.some\(c=>providerKey\(c\)===p\)\)/, file);
    assert.match(html, /if\(present\.length<=1\)return cards\.map\(cardHtml\)\.join\(''\)/, file);
    assert.match(html, /cards\.filter\(c=>providerKey\(c\)===p\)\.map\(cardHtml\)\.join\(''\)/, file);
  }
});

test('/live developer view gates diagnostics without controlling the palette', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');
  assert.doesNotMatch(html, /:root\.dev,:root\[data-theme="dark"\]/);
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /:root:not\(\.dev\) \.dev-only\{display:none/);
  assert.match(html, /<div class="section-head dev-only"><h2 class="sec">Dispatch<\/h2><\/div>/);
  assert.match(html, /<section class="dispatch dev-only" id="dispatch">/);
  assert.match(html, /<h3 class="dev-only" id="watchersSec"/);
  assert.match(html, /<div class="strip dev-only" id="watchers">/);
  assert.match(html, /<h3 class="dev-only" id="workersSec"/);
  assert.match(html, /<div class="strip dev-only" id="workers">/);
  assert.match(html, /class="row dev-only">❯/);
  assert.match(html, /class="agents dev-only"/);
  assert.doesNotMatch(html, /class="ctx dev-only/);
  assert.match(html, /<div class="ctx \$\{cls\}">/);
  assert.match(html, /class="act dev-only" id="pView"/);
  assert.match(html, /<pre class="dev-only" id="transcript"/);
  assert.match(html, /class="attach dev-only"/);
  assert.match(html, /<footer class="truth-stats dev-only">/);
  assert.match(html, /class="act warn" data-action="wrap-save"/);
  assert.match(html, /class="act danger" data-action="kill-chat"/);
  assert.match(html, /<span class="badge dev-only">High context<\/span>/);
  assert.match(html, /function toggleView\(\)\{ if\(panelMode!=='full'&&!document\.documentElement\.classList\.contains\('dev'\)\)return;/);
  assert.match(html, /<section class="hero">/);
  assert.doesNotMatch(html, /<section class="hero dev-only">/);
  assert.match(html, /<div class="needs-grid" id="needsGrid">/);
  assert.match(html, /<div class="grid" id="grid">/);
  assert.match(html, /<div class="task-list" id="taskList">/);
  assert.match(html, /id="devToggle" role="switch" aria-checked="false"/);
  assert.match(html, /let enabled=false/);
  assert.match(html, /localStorage\.getItem\('ck-devview'\)==='true'/);
  assert.match(html, /button\.setAttribute\('aria-checked',String\(enabled\)\)/);
  assert.match(html, /button\.setAttribute\('aria-checked',String\(on\)\)/);
  assert.match(html, /localStorage\.setItem\('ck-devview',String\(on\)\)/);
  assert.match(html, /if\(!on\)\{try\{localStorage\.setItem\('ck-devview','false'\);\}catch\(e\)\{\}location='\/chat';return;\}/);
  assert.match(html, /:root\.dev \.switch\{background:var\(--blue\)\}/);
});

test('/chat exposes the developer-view switch and routes its ON state to /live', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/chat.html'), 'utf8');
  assert.match(html, /id="devToggle" role="switch" aria-checked="false"/);
  assert.match(html, /localStorage\.getItem\('ck-devview'\)==='true'/);
  assert.match(html, /localStorage\.setItem\('ck-devview',String\(on\)\)/);
  assert.match(html, /if\(on\)\{location='\/live';return;\}/);
  assert.match(html, /@media \(max-width:699px\)\{\.devwrap \.dl\{display:none\}\}/);
});

test('/live defaults to plain-English status, memory, and collapsed usage while preserving developer labels', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /:root:not\(\.dev\) \.autowrap-control\{display:none\}/);
  assert.match(html, /:root\.dev \.nondev-only\{display:none\}/);
  assert.match(html, /<details class="system" id="systemDetails">/);
  assert.match(html, /class="nondev-only">Usage &amp; system/);
  assert.match(html, /class="dev-only">System &amp; usage/);
  // 'Ready' (not 'Paused') for idle: nothing paused the chat — it finished its turn and is waiting.
  for (const label of ['Working', 'Needs you', 'Ready', 'Finished']) assert.match(html, new RegExp(label));
  assert.match(html, /class="nondev-only">Memory/);
  assert.match(html, /class="dev-only">Context used/);
  assert.match(html, /system\.open=enabled/);
  assert.match(html, /system\.open=on/);
});

test('/live session cards support keyboard focus and Enter activation', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');
  assert.match(html, /class="card \$\{[^\n]+tabindex="0"/);
  assert.match(html, /if\(e\.key!=='Enter'\)return;/);
  assert.match(html, /const card=e\.target\.closest\('\.card\[data-action\]'\)/);
  assert.match(html, /ACTIONS\[card\.dataset\.action\]\?\.\(card,e\)/);
  assert.match(html, /:focus-visible\{outline:2px solid var\(--blue\)/);
});

test('legacy cockpit keeps task hygiene, weekly usage, needs-you, and active filter controls', () => {
  const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/index.html'), 'utf8');
  assert.match(html, /id="activeFilter"/);
  assert.match(html, /Weekly tokens vs limit/);
  assert.match(html, /weekProjection/);
  assert.match(html, /stale tasks ·/);
  assert.match(html, /data-task-action="completed"/);
  assert.match(html, /Needs you:/);
  assert.match(html, /Possible duplicate work:/);
  assert.match(html, /tool calls · last 24h/);
});
