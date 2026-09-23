// live-models-ui.test.js — behavioural checks of the /live and /m model-picker glue, run in a vm with
// the page's own function sources (extracted by name) and a stub DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = f => fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', f), 'utf8');
function fnSource(html, name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function ' + name);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
function el(value = '') { return { value, style: {}, innerHTML: '', title: '' }; }

function panelCtx() {
  const html = read('live.html');
  const els = { pModel: el(), pEffort: el() };
  const ctx = {
    document: { getElementById: id => els[id] },
    chatsCache: [], openChat: null, panelProviderHint: {}, panelSwitchFor: null,
    modelOptionsHtml: () => '<option value="opus">Opus</option>', catalogTitle: () => 't', modelEfforts: () => ['low'], esc: s => s,
  };
  vm.createContext(ctx);
  vm.runInContext(fnSource(html, 'openChatProvider') + '\n' + fnSource(html, 'syncPanelModelSwitch'), ctx);
  return { ctx, els, html };
}

test('/live panel model switch: hidden for a just-created codex/agy chat and for unknown providers', () => {
  const { ctx, els, html } = panelCtx();
  // createChat passes the provider into openPanel, which records it for the not-yet-listed chat
  assert.match(html, /openPanel\(chat\.name,chat\.provider\|\|body\.provider\)/);
  assert.match(html, /function openPanel\(name,provider\)\{[^}]*if\(provider\)panelProviderHint\[name\]=provider;/);
  ctx.openChat = 'ck-new';
  ctx.panelProviderHint['ck-new'] = 'codex';
  ctx.syncPanelModelSwitch();
  assert.equal(els.pModel.style.display, 'none');
  assert.equal(els.pEffort.style.display, 'none');
  // unknown provider (not in chatsCache, no hint) → hidden, never assumed claude
  ctx.openChat = 'ck-mystery';
  ctx.syncPanelModelSwitch();
  assert.equal(els.pModel.style.display, 'none');
  // claude hint → shown
  ctx.openChat = 'ck-claude';
  ctx.panelProviderHint['ck-claude'] = 'claude';
  ctx.syncPanelModelSwitch();
  assert.equal(els.pModel.style.display, '');
  // once tick() lists the chat, chatsCache wins (agy → hidden; legacy no-provider row → claude)
  ctx.chatsCache = [{ name: 'ck-claude', provider: 'agy' }, { name: 'ck-old' }];
  ctx.syncPanelModelSwitch();
  assert.equal(els.pModel.style.display, 'none');
  ctx.openChat = 'ck-old';
  ctx.syncPanelModelSwitch();
  assert.equal(els.pModel.style.display, '');
  // tick() re-syncs when the known provider for the open chat changes
  assert.match(html, /chatsCache=chats;\s*if\(openChat&&panelSwitchFor!==openChat\+'\|'\+openChatProvider\(\)\)syncPanelModelSwitch\(\);/);
});

for (const [page, openFn] of [['live.html', 'modalOpen'], ['mobile.html', 'sheetOpen']]) {
  test(`${page}: catalog arriving while the new-chat form is open prefers the saved default once listed, else keeps the pick`, () => {
    const html = read(page);
    const els = { mProvider: el('codex'), mModel: el('gpt-6-astra'), mEffort: el('high') };
    const calls = [];
    const ctx = {
      document: { getElementById: id => els[id] },
      newChatDefaults: { provider: 'codex', model: 'gpt-7', effort: 'low' }, newChatTouched: false, openChat: null,
      catalog: { codex: { models: [{ id: 'gpt-6-astra' }] } },
      applyNewChatDefaults: () => calls.push(['apply']),
      syncPanelModelSwitch: () => {},
      setNewChatProvider: (p, m) => { calls.push(['provider', p, m]); els.mModel.value = m; },
      setModelEfforts: (sel, p, m, wanted) => calls.push(['effort', p, m, wanted]),
    };
    ctx[openFn] = () => true;
    vm.createContext(ctx);
    vm.runInContext('function providerCatalog(p){return catalog[p];}\n' + fnSource(html, 'onModelsLoaded'), ctx);

    // saved default not in the list yet → current selection kept
    ctx.onModelsLoaded();
    assert.deepEqual(calls.splice(0), [['provider', 'codex', 'gpt-6-astra'], ['effort', 'codex', 'gpt-6-astra', 'high']]);
    // fresh catalog now lists the saved default → it wins, with its saved effort
    ctx.catalog.codex.models.push({ id: 'gpt-7' });
    ctx.onModelsLoaded();
    assert.deepEqual(calls.splice(0), [['provider', 'codex', 'gpt-7'], ['effort', 'codex', 'gpt-7', 'low']]);
    // the user already changed a pick → never overridden
    els.mModel.value = 'gpt-6-astra';
    ctx.newChatTouched = true;
    ctx.onModelsLoaded();
    assert.deepEqual(calls.splice(0), [['provider', 'codex', 'gpt-6-astra'], ['effort', 'codex', 'gpt-6-astra', 'high']]);
    // saved default is for another provider → current selection kept
    ctx.newChatTouched = false;
    ctx.newChatDefaults = { provider: 'claude', model: 'gpt-7' };
    ctx.onModelsLoaded();
    assert.equal(calls[0][2], 'gpt-6-astra');
    // closed form → defaults re-applied
    calls.length = 0;
    ctx[openFn] = () => false;
    ctx.onModelsLoaded();
    assert.deepEqual(calls, [['apply']]);
    // opening the form resets the touched flag; user edits set it
    assert.match(html, /newChatTouched=false;applyNewChatDefaults\(\)/);
    assert.match(html, /'mModel'\)\.addEventListener\('change',e=>\{newChatTouched=true;/);
  });
}
