// Every inline <script> in every served page must PARSE — a single SyntaxError kills a page's
// entire script block silently (the 2026-07-22 /chat apostrophe incident: the page rendered but
// nothing was interactive). new Function() parses without executing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// run-tests.sh flattens src/ next to test/ — fall back to the flat layout
const candidate = path.join(__dirname, '..', 'src');
const SRC = fs.existsSync(candidate) ? candidate : path.join(__dirname, '..');
const pages = fs.readdirSync(SRC).filter(f => f.endsWith('.html'));

for (const page of pages) {
  test(`inline scripts in ${page} parse without SyntaxError`, () => {
    const html = fs.readFileSync(path.join(SRC, page), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    assert.ok(scripts.length > 0 || !/onclick|addEventListener/.test(html), `${page}: no inline scripts found`);
    scripts.forEach((code, i) => {
      try { new Function(code); } catch (e) {
        assert.fail(`${page} script #${i + 1} does not parse: ${e.message}`);
      }
    });
  });
}
