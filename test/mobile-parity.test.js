const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const source = file =>
  fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', file), 'utf8');
const live = source('live.html');
const mobile = source('mobile.html');
const chat = source('chat.html');

function paletteFrom(html, file) {
  const start = html.indexOf('const CARD_COLORS=');
  const end = html.indexOf('function colorTag(', start);
  assert.ok(start >= 0 && end > start, `${file}: missing CARD_COLORS source`);
  const context = vm.createContext({});
  vm.runInContext(html.slice(start, end), context);
  return JSON.parse(vm.runInContext('JSON.stringify(CARD_COLORS)', context));
}

test('desktop, mobile, and chat picker use identical named card palettes', () => {
  const livePalette = paletteFrom(live, 'live.html');
  const mobilePalette = paletteFrom(mobile, 'mobile.html');
  const chatPalette = paletteFrom(chat, 'chat.html');

  assert.deepEqual(
    mobilePalette,
    livePalette,
    'mobile and desktop color names and hex values must stay identical'
  );
  assert.deepEqual(
    chatPalette,
    livePalette,
    'chat picker and desktop color names and hex values must stay identical'
  );
  assert.deepEqual(
    mobilePalette.map(color => color.name),
    ['Teal', 'Violet', 'Gold', 'Rose', 'Sky', 'Lime', 'Coral', 'Indigo']
  );
  assert.match(mobile, /function colorTag\(color\).*<i><\/i>\$\{esc\(color\.name\)\}/);
  assert.match(mobile, /\$\{colorTag\(color\)\}/);
});

test('chat picker cards expose cockpit parity details', () => {
  assert.match(chat, /cardColor\(c\.name\)/);
  assert.match(chat, /style="--card-accent:\$\{esc\(color\.hex\)\}"/);
  assert.match(chat, /function colorTag\(color\).*<i><\/i>\$\{esc\(color\.name\)\}/);
  assert.match(chat, /function ctxHtml\(c\)/);
  assert.match(chat, /\$\{ctxHtml\(s\.context\)\}/);
  assert.match(chat, /<span class="badge provider">\$\{esc\(providerKey\(s&&s\.provider\?s:c\)\)\}<\/span>/);
  assert.match(chat, /c\.profile==='nondev'\?'<span class="badge">Safe<\/span>'/);
  assert.match(chat, /s\.state==='needs_you'&&s\.needsYou&&s\.needsYou\.message/);
  assert.match(chat, /class="needs-msg">\$\{esc\(s\.needsYou\.message\)\}/);
  assert.match(chat, /Last activity · \$\{s\.lastActivityAt\?esc\(cardAgo\(s\.lastActivityAt\)\):'—'\}/);
  assert.match(chat, /class="open new-chat-mobile" data-new/);
});

test('mobile opens its new-chat sheet from the chat picker hash link', () => {
  assert.match(mobile, /location\.hash==='#new-chat'/);
  assert.match(mobile, /function openNewChatFromHash\(\)/);
  assert.match(mobile, /window\.addEventListener\('hashchange',openNewChatFromHash\)/);
  assert.match(mobile, /openNewChatFromHash\(\);/);
});

test('mobile polling aborts stalled fetches and clears each timeout', () => {
  assert.match(mobile, /function json\(path,options\).*new AbortController\(\).*9000.*signal:controller\.signal.*await r\.json\(\).*clearTimeout\(timer\)/s);
  assert.match(mobile, /if\(!TOKEN\).*new AbortController\(\).*9000.*fetch\('\/api\/token',\{signal:controller\.signal\}\).*await r\.text\(\).*clearTimeout\(timer\)/s);
});

test('mobile context details include warning states, token totals, and unavailable limits', () => {
  assert.match(mobile, /function ctxHtml\(c\)/);
  assert.match(mobile, /(?:pct|raw)>=WARN\?'red':(?:pct|raw)>=AMBER\?'amber':''/);
  // context tokens are esc()-wrapped at every sink (see live-xss.test.js) — assert the ESCAPED form
  assert.match(mobile, /n\/a\$\{Number\.isFinite\(c\.limit\)\?\s*` · \$\{esc\(fmtTok\(c\.limit\)\)\} limit`/);
  assert.match(mobile, /\$\{pct\}% · \$\{esc\(fmtTok\(c\.tokens\)\)\}\/\$\{esc\(fmtTok\(c\.limit\)\)\}/);
  assert.match(mobile, /<div class="(?:ctx-)?bar"><i style="width:\$\{(?:esc\()?Math\.min\(100,pct\)\)?\}%"><\/i><\/div>/);
});

test('mobile uncontrolled cards expose resume details', () => {
  assert.match(mobile, /function resumeHtml\(x\)/);
  assert.match(mobile, /\(x&&x\.completedActions\)\|\|\[\]/);
  assert.match(mobile, /While you were away/);
  assert.match(mobile, /class="resume-card"/);
  assert.match(mobile, /x\.controlled\?[\s\S]{0,220}:`<div class="resume-card">\$\{resumeHtml\(x\)\}<\/div>`/);
});

test('mobile remembers answered pending questions across polling renders', () => {
  assert.match(mobile, /const answeredPending=new Map\(\)/);
  assert.match(mobile, /function pendingKey\(name,pending\)/);
  assert.match(mobile, /function isAnswered\(name,pending\)/);
  assert.match(mobile, /isAnswered\(x\.chat\.name,pending\)/);
  assert.match(mobile, /data-pkey="\$\{esc\(pkey\)\}"/);
  assert.match(mobile, /answeredPending\.set\(pkey,Date\.now\(\)\)/);
  assert.match(mobile, /answeredPending\.delete\(pkey\)/);
});

test('chat and mobile pending questions share the option-row contract', () => {
  for (const [file, html] of [['chat.html', chat], ['mobile.html', mobile]]) {
    assert.match(html, /class="[^"]*option-row/, `${file}: pending options must use option-row`);
  }
});

test('mobile new-chat bottom sheet mirrors provider options and submits through delegated actions', () => {
  for (const id of ['newChatSheet', 'mProvider', 'mModel', 'mEffort', 'mTitle', 'mCwd', 'mPrompt', 'mSafe']) {
    assert.match(mobile, new RegExp(`id="${id}"`));
  }
  assert.match(mobile, /function setNewChatProvider\(provider,model\)/);
  assert.match(mobile, /\/api\/models/);
  assert.match(source('server.js'), /\/api\/providers\/ollama\/models/);
  assert.match(mobile, /fetch\('\/api\/new-chat-defaults'\)/);
  assert.match(mobile, /safe\.disabled=isCodex\|\|isOllama\|\|isAgy/);
  assert.match(mobile, /data-action="open-new-chat"/);
  assert.match(mobile, /el\.dataset\.action==='create-chat'/);
  assert.match(mobile, /fetch\('\/api\/chats',\{method:'POST',headers:H\(\),body:JSON\.stringify\(body\)\}\)/);
  assert.match(mobile, /location='\/chat\?name='\+encodeURIComponent\(chat\.name\)/);
});

test('controlled mobile cards expose delegated wrap and kill confirmation flows', () => {
  assert.match(mobile, /data-action="wrap-chat"/);
  assert.match(mobile, /data-action="kill-chat"/);
  assert.match(mobile, /min-height:44px[^}]*\.card-action|\.card-action\{[^}]*min-height:44px/);
  assert.match(mobile, /function wrapChat\(el\).*confirm\(/s);
  assert.match(mobile, /\/wrap`,\{method:'POST',headers:H\(\)/);
  assert.match(mobile, /function killChat\(el\).*confirm\(/s);
  assert.match(mobile, /method:'DELETE',headers:H\(\)/);
  assert.match(mobile, /Wrap-up sent ✓/);
  assert.match(mobile, /el\.dataset\.action==='wrap-chat'/);
  assert.match(mobile, /el\.dataset\.action==='kill-chat'/);
});
