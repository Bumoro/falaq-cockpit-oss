const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');

test('main and panel polling have in-flight guards and abort timeouts', () => {
  assert.match(html, /if\(tickInFlight\)return; tickInFlight=true/);
  assert.match(html, /timeout=setTimeout\(\(\)=>controller\.abort\(\),10000\)/);
  assert.match(html, /\.finally\(\(\)=>\{clearTimeout\(timeout\);tickInFlight=false;\}\)/);
  assert.match(html, /if\(!openChat\|\|panelRequest\)return/);
  assert.match(html, /if\(panelRequest===controller\)panelRequest=null/);
});

test('cwd options are rebuilt and beep closes its AudioContext', () => {
  assert.match(html, /cwds=new Set\(sessions\.map\(s=>s\.cwd\)\.filter\(Boolean\)\)/);
  assert.doesNotMatch(html, /sessions\.forEach\(s=>\{if\(s\.cwd\)cwds\.add/);
  assert.match(html, /addEventListener\('ended',\(\)=>\{c\.close\(\)\.catch/);
});

test('new chat submission is guarded and always restores its button', () => {
  assert.match(html, /id="mCreate"[^>]*data-action="create-chat"/);
  assert.match(html, /let creatingChat=false;/);
  const createStart = html.indexOf('async function createChat(){');
  const createEnd = html.indexOf('\n}\n/* panel */', createStart);
  const createChat = html.slice(createStart, createEnd);
  assert.match(createChat, /if\(creatingChat\)return;/);
  assert.match(createChat, /creatingChat=true;/);
  assert.match(createChat, /button\.disabled=true; button\.textContent='Creating…';/);
  assert.match(createChat, /finally\{[\s\S]*creatingChat=false;[\s\S]*button\.disabled=false;[\s\S]*button\.textContent='Start chat';/);

  const closeStart = html.indexOf('function closeModal(){');
  const closeEnd = html.indexOf('\n}\nasync function createChat()', closeStart);
  const closeModal = html.slice(closeStart, closeEnd);
  assert.match(closeModal, /button\.disabled=false; button\.textContent='Start chat';/);
});
