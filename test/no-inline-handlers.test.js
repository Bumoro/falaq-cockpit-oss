const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('live and chat pages contain no inline onclick handlers', () => {
  const root = process.env.CK_REPO_ROOT;
  for (const file of ['src/live.html', 'src/chat.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(html.includes('onclick='), false, file + ' contains onclick=');
  }
});
