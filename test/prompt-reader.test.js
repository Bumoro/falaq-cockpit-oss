const { test } = require('node:test');
const assert = require('node:assert');
const { parsePrompt } = require('../prompt-reader.js');

// A real-shaped Claude Code permission prompt (numbered options, ❯ marks the selection).
const PERMISSION = [
  '╭─ Bash command ───────────────────────────────╮',
  '│ npm test                                      │',
  '╰───────────────────────────────────────────────╯',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for npm test commands",
  '  3. No, and tell Claude what to do differently (esc)',
  '',
].join('\n');

const CHOICE = [
  'Which plan should I set up?',
  '❯ 1. Weekly Reset',
  '  2. Monthly',
  '  3. Custom',
  '  4. Ask the customer first',
].join('\n');

const IDLE = 'assistant: all done.\n\n❯ \n  ? for shortcuts';
const PROSE_NUMBERS = 'Here is the plan:\n1. First we test\n2. Then we ship\n(no selector, no question)';

test('parsePrompt reads a permission prompt: kind, title, and 1..n option keys', () => {
  const p = parsePrompt(PERMISSION);
  assert.equal(p.kind, 'permission');
  assert.match(p.title, /proceed/i);
  assert.equal(p.options.length, 3);
  assert.deepEqual(p.options[0], { key: '1', label: 'Yes' });
  assert.equal(p.options[1].key, '2');
  assert.equal(p.options[2].key, '3');
  assert.match(p.options[2].label, /No, and tell Claude/);
  assert.doesNotMatch(p.options[2].label, /\(esc\)/); // trimmed
});

test('parsePrompt reads a 4-option choice prompt as kind:choice', () => {
  const p = parsePrompt(CHOICE);
  assert.equal(p.kind, 'choice');
  assert.equal(p.options.length, 4);
  assert.equal(p.options[3].key, '4');
  assert.equal(p.options[3].label, 'Ask the customer first');
});

test('parsePrompt returns none for an idle REPL and for numbered prose', () => {
  assert.equal(parsePrompt(IDLE).kind, 'none');
  assert.equal(parsePrompt(PROSE_NUMBERS).kind, 'none'); // no ❯ selector, no question
  assert.equal(parsePrompt('').kind, 'none');
  assert.equal(parsePrompt(null).kind, 'none');
});

// SAFETY: numbered PROSE above a real permission menu must NOT shadow the real options.
const SHADOW = [
  "Here's my plan:",
  '1. Delete the old records',
  '2. Keep the backups',
  '3. Skip the migration',
  '',
  '╭─ Bash command ─╮',
  '│ rm -rf ./old    │',
  '╰─────────────────╯',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again",
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n');

test('parsePrompt anchors to the real (cursor-bearing) menu, ignoring numbered prose above it', () => {
  const p = parsePrompt(SHADOW);
  assert.equal(p.kind, 'permission');
  assert.equal(p.options.length, 3);
  assert.equal(p.options[0].label, 'Yes');                 // NOT 'Delete the old records'
  assert.equal(p.options[1].label, "Yes, and don't ask again");
  assert.match(p.options[2].label, /^No, and tell Claude/);
  assert.notEqual(p.options[0].label, 'Delete the old records');
});

test('parsePrompt returns none for a prose-only pane (rhetorical question + list, no cursor)', () => {
  const proseOnly = ['Which approach do you prefer?', '1. Refactor now', '2. Ship as-is'].join('\n');
  assert.equal(parsePrompt(proseOnly).kind, 'none');
});

test('parsePrompt survives ANSI-laden capture (capture-pane -e) and strips it from labels', () => {
  const ansi = ['Do you want to proceed?', '\x1b[7m❯ 1. Yes\x1b[0m', '\x1b[2m  2. No\x1b[0m'].join('\n');
  const p = parsePrompt(ansi);
  assert.equal(p.options.length, 2);
  assert.deepEqual(p.options[0], { key: '1', label: 'Yes' });
  assert.equal(p.options[1].label, 'No');
});

// SAFETY: prose numbered list DIRECTLY above the menu (no blank/question/border between them).
test('parsePrompt does not merge CONTIGUOUS prose into the menu (numbering reset splits the run)', () => {
  const contiguous = [
    '1. Delete the old records',
    '2. Keep the backups',
    '3. Skip the migration',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No, and tell Claude what to do differently',
  ].join('\n');
  const p = parsePrompt(contiguous);
  assert.equal(p.options.length, 3);
  assert.equal(p.options[0].label, 'Yes');                 // NOT 'Delete the old records'
  assert.equal(p.options[1].label, "Yes, and don't ask again");
  assert.notEqual(p.options[0].label, 'Delete the old records');
});

test('parsePrompt does not fabricate a menu from > blockquoted/quoted numbered text', () => {
  const quoted = ['Here are the options I considered:', '> 1. Rewrite everything', '> 2. Patch it'].join('\n');
  assert.equal(parsePrompt(quoted).kind, 'none');
});

test('parsePrompt keeps every option when a label wraps onto an indented continuation line', () => {
  const wrapped = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    "  2. Yes, and don't ask again for",
    '     npm test commands',
    '  3. No, and tell Claude what to do differently',
  ].join('\n');
  const p = parsePrompt(wrapped);
  assert.equal(p.options.length, 3);                       // the "No" option is not dropped by the wrap
  assert.equal(p.options[2].key, '3');
  assert.match(p.options[2].label, /^No, and tell Claude/);
});

// A real capture always has a blank line / footer after the menu, which ends the run — so numbered
// prose that continues below the menu does NOT fabricate a phantom option.
test('a blank line after the menu ends the run — trailing numbered prose is not appended', () => {
  const withFooter = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', '3. then I will delete everything'].join('\n');
  const p = parsePrompt(withFooter);
  assert.equal(p.options.length, 2);
  assert.equal(p.options[1].label, 'No');
});
