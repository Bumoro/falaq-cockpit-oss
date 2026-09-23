const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { render } = require('../md.js');

test('exports the renderer for Node and as a callable browser API', () => {
  assert.equal(typeof render, 'function');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'md.js'), 'utf8'), { window });
  assert.equal(typeof window.ckMd, 'function');
  assert.equal(window.ckMd.render, window.ckMd);
});

test('renders the supported inline constructs', () => {
  const html = render('**bold** *italic* ~~gone~~ `**literal**` and ***both***\n\n[site](https://example.com/a?q=1&b=2)');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.match(html, /<strong><em>both<\/em><\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/a\?q=1&amp;b=2"/);
});

test('renders nested emphasis without exposing generated markup', () => {
  assert.match(render('**bold and *italic***'), /<strong>bold and <em>italic<\/em><\/strong>/);
  assert.match(render('*italic and **bold** text*'), /<em>italic and <strong>bold<\/strong> text<\/em>/);
  assert.match(render('**bold and _italic_**'), /<strong>bold and <em>italic<\/em><\/strong>/);
});

test('renders headings, rules, quotes, paragraphs and hard line breaks', () => {
  const html = render('# One\n\n#### Four\n\n---\n\n> first\n> second\n\nline one\nline two');
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<h4>Four<\/h4>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote>first<br>second<\/blockquote>/);
  assert.match(html, /<p>line one<br>line two<\/p>/);
});

test('renders ordered and unordered lists with one nesting level', () => {
  const html = render('- first\n  - nested\n- second\n\n1. one\n2. two');
  assert.match(html, /<ul><li>first<ul><li>nested<\/li><\/ul><\/li><li>second<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('renders simple pipe tables and preserves escaped pipes in cells', () => {
  const html = render('| Name | Note |\n| --- | --- |\n| Falaq | a \\| b |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>Name<\/th><th>Note<\/th>/);
  assert.match(html, /<td>Falaq<\/td><td>a \| b<\/td>/);
});

test('renders fenced code as escaped, untransformed content with a language caption', () => {
  const html = render('```js\nconst tag = "<img onerror=x>";\n**not bold**\n```');
  assert.match(html, /<small class="md-code-language">js<\/small>/);
  assert.match(html, /<pre><code>const tag = &quot;&lt;img onerror=x&gt;&quot;;\n\*\*not bold\*\*<\/code><\/pre>/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<img\b/);
});

test('renders an empty closed fence without treating its delimiter as code', () => {
  const html = render('```\n```');
  assert.equal(html, '<div class="md-code-block"><pre><code></code></pre></div>');
});

test('treats an unclosed fence as safe code through end of input', () => {
  const html = render('before\n\n```html\n<script>bad()</script>\n**literal**');
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<small class="md-code-language">html<\/small>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('escapes raw HTML before applying the markdown whitelist', () => {
  const html = render('# hi **safe** <img src=x onerror="alert(1)"> <style>body{}</style> <script>x</script>');
  assert.match(html, /<h1>hi <strong>safe<\/strong> &lt;img/);
  assert.match(html, /onerror=&quot;alert\(1\)&quot;/);
  assert.doesNotMatch(html, /<img\b|<style\b|<script\b/i);
});

test('leaves javascript and data links as escaped plain text', () => {
  const html = render('[js](javascript:alert(1)) [data](data:text/html,bad) [relative](/safe) [upper](HTTPS://example.com)');
  assert.equal(html, '<p>[js](javascript:alert(1)) [data](data:text/html,bad) [relative](/safe) [upper](HTTPS://example.com)</p>');
  assert.doesNotMatch(html, /href=/);
});

test('markdown image syntax becomes a link and never an image', () => {
  const html = render('![alt](https://example.com/picture.png)');
  assert.match(html, /^<p><a href="https:\/\/example\.com\/picture\.png"/);
  assert.doesNotMatch(html, /<img\b/);
});

test('large input completes promptly and render never throws', () => {
  const input = Array.from({ length: 10000 }, (_, i) => `line ${i}`).join('\n');
  const started = Date.now();
  let html;
  assert.doesNotThrow(() => { html = render(input); });
  assert.ok(html.length > input.length);
  assert.ok(Date.now() - started < 2000, '10k-line render should remain linear-time');
  const hostile = { toString() { throw new Error('no string'); } };
  let fallback;
  assert.doesNotThrow(() => { fallback = render(hostile); });
  assert.equal(fallback, '');
});

test('indent-only list items are promoted, never dropped', () => {
  // regression: renderList used to emit nothing for a nested item with no open root item,
  // so "Options:\n  - a\n  - b" rendered as just the paragraph and both bullets vanished
  assert.equal(render('Options:\n  - first\n  - second'), '<p>Options:</p>\n<ul><li>first</li><li>second</li></ul>');
  assert.equal(render('  - lone'), '<ul><li>lone</li></ul>');
  // promotion must not flatten a REAL nested list under a root item
  assert.equal(render('- root\n  - nested\n- root2'), '<ul><li>root<ul><li>nested</li></ul></li><li>root2</li></ul>');
  // after a promoted run, a flush-left item restores normal root/nested behavior
  assert.equal(render('  - a\n- real root\n  - realnested'), '<ul><li>a</li><li>real root<ul><li>realnested</li></ul></li></ul>');
});
