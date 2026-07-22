'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const chats = require('../chats.js');
const values = {
  home: '/Users/o',
  mirror: '/Users/o/.claude/agent-dashboard',
  cockpit: '/Users/o/falaq-cockpit',
  worktree: '/Users/o/.cockpit-dispatch/wt-t1',
};

test('generated dispatch profile has the exact security-critical deny and scoped allow surface', () => {
  const prof = chats.buildDispatchProfile(values);
  const deny = new Set(prof.permissions.deny);
  ['Bash(git push:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)', 'Bash(vercel:*)',
    'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(git diff:*)'].forEach(rule => assert.ok(deny.has(rule), 'must deny ' + rule));
  assert.ok(prof.permissions.allow.includes('Write(//Users/o/.cockpit-dispatch/wt-t1/**)'));
  assert.ok(prof.permissions.allow.includes('Bash(gh pr create:*)'));
  assert.ok(!prof.permissions.allow.includes('Write'));
  assert.ok(!prof.permissions.allow.includes('Edit'));
  assert.ok(!prof.permissions.allow.includes('Bash(*)'));
  assert.ok(!prof.permissions.allow.includes('Bash(git:*)'), 'no broad git allow (would let git -C push bypass the git-push deny)');
  assert.ok(prof.permissions.allow.includes('Bash(git commit:*)'), 'specific safe git subcommands are allowed instead');
  assert.strictEqual(prof.permissions.defaultMode, 'default');
  assert.ok(!/__.*__/.test(JSON.stringify(prof)), 'all four placeholders must resolve');
});

test('glob/JSON metacharacters in a substituted worktree path fail closed', () => {
  assert.throws(() => chats.buildDispatchProfile({ ...values, worktree: '/x/wt-{a,b}' }), /unsafe|metacharacter/i);
});

test('template missing a required deny rule fails closed', (t) => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.dispatch-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '..', 'dispatch-profile.json.template'), 'utf8');
  fs.writeFileSync(path.join(dir, 'dispatch-profile.json.template'), source.replace('"Bash(git push:*)", ', ''));
  const saved = process.env.COCKPIT_DIR;
  process.env.COCKPIT_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.COCKPIT_DIR; else process.env.COCKPIT_DIR = saved; });
  assert.throws(() => chats.buildDispatchProfile(values), /validation|invalid/i);
});

test('unknown permission profile fails closed instead of launching as dev', (t, done) => {
  chats.createChat({ profile: 'bogus' }, (err) => {
    assert.ok(err);
    assert.strictEqual(err.message, 'unknown permission profile');
    done();
  });
});
