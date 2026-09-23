const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const chat = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'chat.html'), 'utf8');
const live = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', 'live.html'), 'utf8');

function themeTokens(html, selector) {
  const start = html.indexOf(selector + '{');
  assert.ok(start >= 0, `missing ${selector} theme block`);
  const body = html.slice(start + selector.length + 1, html.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):([^;]+);/g)].map(match => [match[1], match[2]]));
}

test('chat v2 keeps a persistent desktop sidebar and mobile picker breakpoint', () => {
  assert.match(chat, /<aside id="chatSidebar"[^>]*>[\s\S]*id="sidebarList"/);
  assert.match(chat, /@media \(min-width:900px\)[^{]*\{[\s\S]*?\.chat-sidebar\{[^}]*display:flex/);
  assert.match(chat, /@media \(max-width:899px\)/);
  assert.match(chat, /\.desktop-picker-empty\{display:none\}/);
  assert.match(chat, /\.picker \.desktop-picker-empty\{[^}]*display:flex/);
  assert.doesNotMatch(chat, /min-width:1100px/, 'dead >=1100 picker grid removed (sidebar owns >=900)');
  assert.match(chat, /html!==lastSidebarHTML/, 'sidebar innerHTML guarded against unchanged-content churn');
  assert.match(chat, /pickerHTML!==lastPickerHTML/, 'picker innerHTML guarded against unchanged-content churn');
  assert.match(chat, /answeredPending\.delete/, 'answered latch released when the prompt is observed gone');
});

test('chat cards share live anatomy and expose delegated answer controls', () => {
  for (const fragment of ['--card-accent:', 'class="pill ', 'class="badge provider"', 'class="ctx ', 'Last activity · ']) {
    assert.ok(chat.includes(fragment), `missing live-style card fragment: ${fragment}`);
  }
  assert.match(chat, /function pendingCardHTML\(name,pending\)/);
  assert.match(chat, /providerKey\(s&&s\.provider\?s:c\)/, 'provider badge must come from the matched live session');
  assert.match(chat, /pendingCardHTML\(c\.name,s\.pending\)/);
  assert.match(chat, /pendingCardHTML\(NAME,p\)/);
  assert.match(chat, /data-action="answer-card" data-chat="\$\{esc\(name\)\}" data-key="\$\{esc\(o\.key\)\}"/);
  assert.match(chat, /closest\('\[data-action="answer-card"\]'\)/);
  assert.doesNotMatch(chat, /\sonclick\s*=/i);
});

test('chat pending latch key is stable and changes with question identity', () => {
  const start = chat.indexOf('function pendingKey(');
  const end = chat.indexOf('function isAnswered(', start);
  assert.ok(start >= 0 && end > start, 'pendingKey must remain a standalone pure function');
  const context = vm.createContext({});
  vm.runInContext(chat.slice(start, end), context);
  const first = vm.runInContext("pendingKey('ck-one',{title:'Pick',options:[{key:'1'},{key:'2'}]})", context);
  const same = vm.runInContext("pendingKey('ck-one',{title:'Pick',options:[{key:'1'},{key:'2'}]})", context);
  const changedTitle = vm.runInContext("pendingKey('ck-one',{title:'Choose',options:[{key:'1'},{key:'2'}]})", context);
  const changedKeys = vm.runInContext("pendingKey('ck-one',{title:'Pick',options:[{key:'1'},{key:'3'}]})", context);
  const changedChat = vm.runInContext("pendingKey('ck-two',{title:'Pick',options:[{key:'1'},{key:'2'}]})", context);
  assert.equal(first, same);
  assert.notEqual(first, changedTitle);
  assert.notEqual(first, changedKeys);
  assert.notEqual(first, changedChat);
});

test('chat answered latch survives polling for two minutes and rolls back failures', () => {
  assert.match(chat, /const answeredPending=new Map\(\)/);
  assert.match(chat, /Date\.now\(\)-at<120000/);
  assert.match(chat, /answeredPending\.set\(pkey,Date\.now\(\)\)/);
  assert.match(chat, /answeredPending\.delete\(pkey\)/);
  assert.match(chat, /\/api\/chats\/\$\{encodeURIComponent\(name\)\}\/keys/);
});

test('chat theme is restored before paint and cycles System Light Dark', () => {
  const styleAt = chat.indexOf('<style>');
  const firstScriptAt = chat.indexOf('<script>');
  const firstScriptEnd = chat.indexOf('</script>', firstScriptAt);
  assert.ok(firstScriptAt >= 0 && firstScriptAt < styleAt, 'theme script must run before CSS and paint');
  const headScript = chat.slice(firstScriptAt + '<script>'.length, firstScriptEnd);
  assert.match(headScript, /localStorage\.getItem\('ck-theme'\)/);
  assert.match(headScript, /document\.documentElement\.dataset\.theme=theme/);
  assert.doesNotThrow(() => new Function(headScript));
  assert.match(chat, /const THEME_MODES=\['system','light','dark'\]/);
  assert.match(chat, /localStorage\.setItem\('ck-theme',theme\)/);
  assert.match(chat, /:root\[data-theme="light"\]/);
  assert.match(chat, /:root\[data-theme="dark"\]/);
  assert.match(chat, /id="themeButton"[^>]*aria-label="Theme: System\. Activate for Light\."[^>]*title="Theme: System"/);
});

test('chat explicit themes carry the same palette tokens as the established live theme', () => {
  const light = themeTokens(chat, ':root[data-theme="light"]');
  const dark = themeTokens(chat, ':root[data-theme="dark"]');
  const base = themeTokens(chat, ':root');
  const liveDark = themeTokens(live, ':root[data-theme="dark"]');
  const tokens = ['--bg', '--surface', '--surface-2', '--ink', '--ink-2', '--ink-3', '--line', '--line-2', '--blue', '--blue-press', '--link', '--green', '--amber', '--red', '--gray', '--green-bg', '--amber-bg', '--gray-bg', '--blue-bg', '--shadow', '--shadow-lift'];
  for (const token of tokens) {
    assert.equal(light[token], base[token], `${token}: explicit light must match the default palette`);
    assert.equal(dark[token], liveDark[token], `${token}: chat dark must match live dark`);
  }
});
