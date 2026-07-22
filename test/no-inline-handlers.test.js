const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('cockpit pages contain no inline onclick handlers', () => {
  const root = process.env.CK_REPO_ROOT;
  for (const file of ['src/live.html', 'src/mobile.html', 'src/chat.html', 'src/home.html', 'src/help.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(html.includes('onclick='), false, file + ' contains onclick=');
  }
});

test('cockpit pages contain no inline event-handler attributes', () => {
  const root = process.env.CK_REPO_ROOT;
  for (const file of ['src/live.html', 'src/mobile.html', 'src/home.html', 'src/help.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${file} contains an inline event handler`);
  }
});
