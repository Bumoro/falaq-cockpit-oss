const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');

function between(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return html.slice(from, to);
}

function browserHarness() {
  const banner = {
    innerHTML: '',
    classList: { add() {}, remove() {} },
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'duplicateBanner' ? banner : null },
  });
  const source = [
    between('function esc(', 'const CARD_COLORS='),
    between('const CARD_COLORS=', 'function mins('),
    between('function ago(', 'function fmtTok('),
    'let duplicateCache=[],duplicateSessions=[],duplicateNotice=null,duplicateBusy=false;',
    between('function duplicateDisambiguator(', 'function renderNeedsStrip('),
  ].join('\n');
  vm.runInContext(source, context);
  return { banner, context };
}

test('cardColor is deterministic, returns palette members, and distributes ids', () => {
  const { context } = browserHarness();
  const result = JSON.parse(vm.runInContext(`JSON.stringify({
    palette:CARD_COLORS,
    first:cardColor('stable-session'),
    second:cardColor('stable-session'),
    colors:Array.from({length:32},(_,i)=>cardColor('session-'+i).hex)
  })`, context));

  assert.deepEqual(result.first, result.second);
  assert.ok(result.palette.some(color => color.name === result.first.name && color.hex === result.first.hex));
  assert.ok(new Set(result.colors).size >= 2, 'distinct ids should span at least two colors');
});

test('cards and duplicate sides use the specified stable keys and visible color labels', () => {
  assert.match(html, /cardColor\(x\.chatName\|\|\(x\.chat&&x\.chat\.name\)\|\|x\.sessionId\|\|''\)/);
  assert.match(html, /cardColor\(pair\.a\.chatName\|\|pair\.a\.sessionId\|\|''\)/);
  assert.match(html, /cardColor\(pair\.b\.chatName\|\|pair\.b\.sessionId\|\|''\)/);
  assert.match(html, /style="--card-accent:\$\{esc\(color\.hex\)\}"/);
  assert.match(html, /border-left:4px solid var\(--card-accent,transparent\)/);
  assert.match(html, /function colorTag\(color\).*<i><\/i>\$\{esc\(color\.name\)\}/);
});

test('same-color duplicate buttons include distinct cwd disambiguators', () => {
  const { banner, context } = browserHarness();
  const collision = JSON.parse(vm.runInContext(`JSON.stringify((()=>{
    const seen=new Map();
    for(let i=0;i<100;i++){
      const id='chat-'+i,color=cardColor(id);
      if(seen.has(color.hex))return {a:seen.get(color.hex),b:id,color};
      seen.set(color.hex,id);
    }
  })())`, context));
  assert.ok(collision && collision.a && collision.b, 'expected to find a palette collision');

  context.pair = {
    pairKey: 'pair', status: 'confirmed',
    a: { sessionId: 'session-alpha-111111', chatName: collision.a, purposeTitle: 'Same task' },
    b: { sessionId: 'session-beta-222222', chatName: collision.b, purposeTitle: 'Same task' },
  };
  context.sessions = [
    { sessionId: 'session-alpha-111111', cwd: '/repo/alpha' },
    { sessionId: 'session-beta-222222', cwd: '/repo/beta' },
  ];
  vm.runInContext('renderDuplicates({pairs:[pair]},sessions)', context);

  const buttons = banner.innerHTML.match(/<button class="kill"[\s\S]*?<\/button>/g) || [];
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], new RegExp(collision.color.name));
  assert.match(buttons[1], new RegExp(collision.color.name));
  assert.match(buttons[0], /alpha/);
  assert.match(buttons[1], /beta/);
  assert.notEqual(buttons[0].replace(/data-session-id="[^"]+"/g, ''), buttons[1].replace(/data-session-id="[^"]+"/g, ''));
  assert.ok((banner.innerHTML.match(/class="color-tag"/g) || []).length >= 4, 'pair and buttons should all show swatches and names');
});
