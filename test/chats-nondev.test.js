const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-tests.sh flattens src/ into the test root, so the profile sits beside the flattened modules.
const REAL_PROFILE = path.join(__dirname, '..', 'nondev-profile.json');

// Load chats.js against a temp state dir + a temp nondev root + a tmux RECORDER (writes its argv, exits 0).
function setup(t) {
  // The dev-cwd guard only accepts workspaces under $HOME; macOS os.tmpdir() is under /private/var,
  // so keep the fixture under the repo (or $HOME) like production.
  const dir = fs.mkdtempSync(path.join(process.env.CK_REPO_ROOT || os.homedir(), '.cknd-'));
  const ndroot = fs.mkdtempSync(path.join(process.env.CK_REPO_ROOT || os.homedir(), '.cknd-root-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(ndroot, { recursive: true, force: true }); });
  const rec = path.join(dir, 'tmux-args.log');
  const recorder = path.join(dir, 'tmux');
  fs.writeFileSync(recorder, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${rec}"\ncase "$1" in\n  has-session) exit 1;;\n  capture-pane) echo "? for shortcuts";;\nesac\nexit 0\n`, { mode: 0o755 });
  process.env.COCKPIT_DIR = dir;
  process.env.CK_NONDEV_ROOT = ndroot;
  process.env.CK_TMUX_BIN = recorder;
  delete process.env.CK_TEST_CMD;
  delete require.cache[require.resolve('../chats.js')];
  const chats = require('../chats.js');
  return { dir, ndroot, rec, chats };
}
function seedRealProfile(dir) {
  fs.copyFileSync(REAL_PROFILE, path.join(dir, 'nondev-profile.json'));
}

test('dev launch (default) has NO permission flags and no forced workspace', (t, done) => {
  const { dir, rec, chats } = setup(t);
  chats.createChat({ title: 'dev one', cwd: dir, model: 'sonnet', effort: 'medium' }, (err) => {
    assert.ifError(err);
    const log = fs.readFileSync(rec, 'utf8');
    assert.ok(/new-session/.test(log));
    assert.ok(!/--setting-sources/.test(log), 'dev must not get --setting-sources');
    assert.ok(!/--settings/.test(log), 'dev must not get --settings');
    assert.strictEqual(chats.listChats().find(c => c.title === 'dev one').profile, 'dev');
    done();
  });
});

test('nondev launch adds the flags, uses a FRESH per-session workspace, and generates a workspace-scoped profile', (t, done) => {
  const { dir, ndroot, rec, chats } = setup(t);
  seedRealProfile(dir);
  chats.createChat({ title: 'safe one', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ifError(err);
    const log = fs.readFileSync(rec, 'utf8');
    assert.ok(/--setting-sources project/.test(log), 'nondev needs --setting-sources project');
    assert.ok(/--settings /.test(log), 'nondev needs --settings <profile>');
    const nd = chats.listChats().find(c => c.title === 'safe one');
    assert.strictEqual(nd.profile, 'nondev');
    // fresh per-session workspace under the nondev root, empty, no planted .claude/
    assert.ok(nd.cwd.startsWith(ndroot + path.sep) && /\/ws-[^/]+$/.test(nd.cwd), 'cwd is a fresh ws- dir under the nondev root');
    assert.ok(fs.existsSync(nd.cwd) && fs.readdirSync(nd.cwd).length === 0, 'workspace exists and is empty');
    // generated profile: exists, workspace-scoped writes, NO bare Write/Edit, retains the deny floor
    assert.ok(nd.nondevProfileFile && fs.existsSync(nd.nondevProfileFile), 'per-session profile generated');
    const prof = JSON.parse(fs.readFileSync(nd.nondevProfileFile, 'utf8'));
    assert.ok(!prof.permissions.allow.includes('Write'), 'no bare Write tool (would write any absolute path)');
    assert.ok(!prof.permissions.allow.includes('Edit'), 'no bare Edit tool');
    assert.ok(prof.permissions.allow.includes('Write(//' + nd.cwd.replace(/^\/+/, '') + '/**)'), 'Write scoped to this workspace (double-slash absolute)');
    const homeFloor = 'Write(//' + os.homedir().replace(/^\/+/, '') + '/.claude/**)';
    assert.ok(prof.permissions.deny.includes(homeFloor), 'resolved absolute write floor for ~/.claude retained');
    assert.ok(!/__HOME__|__MIRROR__|__COCKPIT__/.test(JSON.stringify(prof)), 'no portability placeholder remains');
    assert.ok(prof.permissions.deny.length >= 80, 'full deny floor retained');
    done();
  });
});

test('two nondev launches get DIFFERENT workspaces (no shared dir to plant settings into)', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  chats.createChat({ title: 'a', model: 'sonnet', effort: 'low', profile: 'nondev' }, (e1) => {
    assert.ifError(e1);
    chats.createChat({ title: 'b', model: 'sonnet', effort: 'low', profile: 'nondev' }, (e2) => {
      assert.ifError(e2);
      const cs = chats.listChats();
      const a = cs.find(c => c.title === 'a'), b = cs.find(c => c.title === 'b');
      assert.notStrictEqual(a.cwd, b.cwd, 'each nondev chat gets its own fresh workspace');
      done();
    });
  });
});

test('killChat removes a nondev chat workspace + generated profile', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  chats.createChat({ title: 'temp', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ifError(err);
    const nd = chats.listChats().find(c => c.title === 'temp');
    assert.ok(fs.existsSync(nd.cwd) && fs.existsSync(nd.nondevProfileFile));
    chats.killChat(nd.name);
    assert.ok(!fs.existsSync(nd.cwd), 'workspace removed on kill');
    assert.ok(!fs.existsSync(nd.nondevProfileFile), 'generated profile removed on kill');
    done();
  });
});

test('nondev launch fails CLOSED when the profile template is missing (never launch unprofiled)', (t, done) => {
  const { chats } = setup(t); // no profile file seeded
  chats.createChat({ title: 'no profile', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ok(err && /profile/i.test(err.message), 'must error when the nondev profile template is absent');
    done();
  });
});

test('nondev launch fails CLOSED when the template deny floor is too small (tampered profile)', (t, done) => {
  const { dir, chats } = setup(t);
  fs.writeFileSync(path.join(dir, 'nondev-profile.json'), '{"permissions":{"defaultMode":"default","allow":["Read"],"deny":["Bash(rm:*)"]}}');
  chats.createChat({ title: 'tiny', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ok(err && /deny floor|validation/i.test(err.message), 'must reject a too-small deny floor');
    done();
  });
});

test('nondev launch fails CLOSED when a placeholder survives JSON decoding', (t, done) => {
  const { dir, chats } = setup(t);
  const text = fs.readFileSync(REAL_PROFILE, 'utf8').replace('Read(**/.ssh/**)', 'Read(//__HOME\\u005f_/.extra/**)');
  fs.writeFileSync(path.join(dir, 'nondev-profile.json'), text);
  chats.createChat({ title: 'placeholder', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ok(err && /validation/i.test(err.message), 'must reject a resolved object containing a placeholder');
    done();
  });
});

test('nondev settings path is POSIX-quoted when the root contains a space and apostrophe', (t, done) => {
  const fixture = setup(t);
  seedRealProfile(fixture.dir);
  const oddRoot = path.join(process.env.CK_REPO_ROOT || os.homedir(), ".cknd odd'root");
  fs.mkdirSync(oddRoot, { recursive: true });
  t.after(() => fs.rmSync(oddRoot, { recursive: true, force: true }));
  process.env.CK_NONDEV_ROOT = oddRoot;
  fixture.chats.createChat({ title: 'quoted', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ifError(err);
    const nd = fixture.chats.listChats().find(c => c.title === 'quoted');
    const expected = "--settings '" + nd.nondevProfileFile.replace(/'/g, "'\\''") + "'";
    assert.ok(fs.readFileSync(fixture.rec, 'utf8').includes(expected), 'constructed command preserves the exact profile argv');
    done();
  });
});

test('__COCKPIT__ floors resolve from the mirror .repo-root stamp when the env override is absent', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  const saved = process.env.CK_REPO_ROOT;
  delete process.env.CK_REPO_ROOT;
  t.after(() => { if (saved !== undefined) process.env.CK_REPO_ROOT = saved; });
  fs.writeFileSync(path.join(dir, '.repo-root'), '/Users/example/team cockpit');
  chats.createChat({ title: 'nd stamp', model: 'sonnet', effort: 'medium', profile: 'nondev' }, (err, chat) => {
    assert.ifError(err);
    const prof = JSON.parse(fs.readFileSync(chat.nondevProfileFile, 'utf8'));
    assert.ok(prof.permissions.deny.includes('Write(//Users/example/team cockpit/**)'), 'repo floor comes from the stamp');
    // The location-independent relative backstop is always present too (defense in depth).
    assert.ok(prof.permissions.deny.includes('Write(**/falaq-cockpit/**)'), 'relative backstop present');
    done();
  });
});

test('nondev safe mode FAILS CLOSED when the source root cannot be positively resolved (no guess)', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  const saved = process.env.CK_REPO_ROOT;
  delete process.env.CK_REPO_ROOT;
  t.after(() => { if (saved !== undefined) process.env.CK_REPO_ROOT = saved; });
  // No CK_REPO_ROOT and no .repo-root stamp in the state dir → the exact-path cockpit floor cannot be
  // placed. Guessing ~/falaq-cockpit would put the boundary on the WRONG checkout (panel BLOCKER), so
  // launch must be refused rather than silently misplaced.
  chats.createChat({ title: 'nd unresolved', model: 'sonnet', effort: 'medium', profile: 'nondev' }, (err) => {
    assert.ok(err && /source root/i.test(err.message), 'must refuse when the source root is unstamped');
    done();
  });
});

test('nondev profile resolves a non-ASCII home path (no charset over-rejection)', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  fs.writeFileSync(path.join(dir, '.repo-root'), path.join(os.homedir(), 'falaq-cockpit'));
  // Accents + umlaut + space + hyphen + apostrophe — all literal in a glob and legal in JSON, so safe
  // mode must still work for this teammate (panel MAJOR). None of these are glob metacharacters.
  const oddHome = "/Users/José Müller-O'Brien";
  const savedHome = os.homedir;
  os.homedir = () => oddHome;
  t.after(() => { os.homedir = savedHome; });
  chats.createChat({ title: 'nd i18n', model: 'sonnet', effort: 'medium', profile: 'nondev' }, (err, chat) => {
    assert.ifError(err);
    const prof = JSON.parse(fs.readFileSync(chat.nondevProfileFile, 'utf8'));
    assert.ok(prof.permissions.deny.includes("Write(//Users/José Müller-O'Brien/.ssh/**)"), 'accented home floor resolves verbatim');
    done();
  });
});

// Each of these path values would corrupt the deny GLOB (brace-expansion / extglob / negation / JSON
// break), so resolution must fail CLOSED rather than install a floor that guards the wrong path
// (panel re-review BLOCKER: reject glob metacharacters, not just * ? [ ] " \).
for (const meta of ['/Users/ev"il', '/Users/x/repo{a,b}', '/Users/x/team(work)', '/Users/x/re!po', '/Users/x/a*b']) {
  test(`nondev safe mode fails closed on a glob-metacharacter path: ${meta}`, (t, done) => {
    const { dir, chats } = setup(t);
    seedRealProfile(dir);
    fs.writeFileSync(path.join(dir, '.repo-root'), path.join(os.homedir(), 'falaq-cockpit'));
    const savedHome = os.homedir;
    os.homedir = () => meta;
    t.after(() => { os.homedir = savedHome; });
    chats.createChat({ title: 'nd meta', model: 'sonnet', effort: 'medium', profile: 'nondev' }, (err) => {
      assert.ok(err && /unsafe|invalid|metacharacter/i.test(err.message), 'must reject glob-metacharacter paths');
      done();
    });
  });
}
