const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src/live.html'), 'utf8');

function htmlFunction(name) {
  const match = html.match(new RegExp(`function ${name}\\([^\\n]+`));
  assert.ok(match, `${name} must be present`);
  return vm.runInNewContext(`${match[0]};${name}`);
}

test('fmtTok fails closed for non-finite and HTML inputs', () => {
  const fmtTok = htmlFunction('fmtTok');
  for (const value of [NaN, Infinity, -Infinity, '<img src=x onerror=alert(1)>']) {
    const formatted = fmtTok(value);
    assert.equal(formatted, '0');
    assert.doesNotMatch(formatted, /[<>]/);
  }
  assert.equal(fmtTok(1234), '1k');
});

test('desktop and mobile state classes use only fixed literals', () => {
  for (const file of ['live.html', 'mobile.html']) {
    const source = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', file), 'utf8');
    const match = source.match(/function stateClass\([^\n]+/);
    assert.ok(match, `${file} must define stateClass`);
    const stateClass = vm.runInNewContext(`${match[0]};stateClass`);
    for (const state of ['running', 'needs_you', 'idle', 'stale', 'ended', 'dead']) {
      assert.equal(stateClass(state), state);
    }
    assert.equal(stateClass('x"><img src=x onerror=alert(1)><span class="'), 'unknown');
  }
});

test('context token formatting is escaped at live HTML sinks', () => {
  assert.match(html, /\$\{esc\(fmtTok\(c\.limit\)\)\} limit/);
  assert.match(html, /\$\{esc\(fmtTok\(c\.tokens\)\)\}\/\$\{esc\(fmtTok\(c\.limit\)\)\}/);
});

// /chat renders the same context object and was missed in the first pass: a session record can carry
// an inherited `context.tokens` string with no valid transcriptPath, so opening /chat fired the
// payload even after live.html was fixed. Every surface that formats tokens needs both halves.
test('EVERY surface that renders context tokens fails closed and escapes', () => {
  for (const file of ['live.html', 'mobile.html', 'chat.html']) {
    const source = fs.readFileSync(path.join(process.env.CK_REPO_ROOT, 'src', file), 'utf8');
    const match = source.match(/function fmtTok\([^\n]+/);
    if (!match) continue; // a surface that never formats tokens has nothing to escape
    const fmtTok = vm.runInNewContext(`${match[0]};fmtTok`);
    assert.equal(fmtTok('<img src=x onerror=alert(1)>'), '0', `${file}: fmtTok must not pass HTML through`);
    assert.equal(fmtTok(NaN), '0', `${file}: fmtTok must fail closed`);
    assert.equal(fmtTok(1234), '1k', `${file}: fmtTok must still format normally`);

    for (const call of source.match(/\$\{[^}]*fmtTok\([^}]*\}/g) || []) {
      assert.match(call, /esc\(fmtTok\(/, `${file}: unescaped fmtTok interpolation -> ${call}`);
    }
  }
});
