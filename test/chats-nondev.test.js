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
    assert.ok(prof.permissions.allow.includes('Edit(//' + nd.cwd.replace(/^\/+/, '') + '/**)'), 'Edit scoped to this workspace (double-slash absolute; Edit covers Write+NotebookEdit)');
    const homeFloor = 'Edit(//' + os.homedir().replace(/^\/+/, '') + '/.claude/**)';
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

// Safe mode bare-allows Read/Grep/Glob, so the read floor is the ONLY thing keeping a safe-mode chat
// out of ~/.claude.json (MCP tokens), the shell rc files and the vault. Only Read(...) rules are ever
// matched by Claude Code's file permission checks (they then cover Grep/Glob best-effort), and only
// //-anchored or ~/-anchored ones reach outside the throwaway workspace — so those are what we pin.
for (const rule of ['Read(//**/.claude.json)', 'Read(//**/id_rsa*)', 'Read(//**/.ssh/**)', 'Read(~/.zshrc)', 'Read(~/.bashrc)']) {
  test(`nondev launch fails CLOSED when the read floor drops ${rule}`, (t, done) => {
    const { dir, chats } = setup(t);
    const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
    const before = profile.permissions.deny.length;
    profile.permissions.deny = profile.permissions.deny.filter(r => r !== rule);
    assert.strictEqual(profile.permissions.deny.length, before - 1, `${rule} must exist in the real profile to begin with`);
    fs.writeFileSync(path.join(dir, 'nondev-profile.json'), JSON.stringify(profile));
    chats.createChat({ title: 'noread', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
      assert.ok(err && /validation/i.test(err.message), `must reject a profile missing ${rule}`);
      done();
    });
  });
}

test('nondev launch fails CLOSED when the resolved home read floor is dropped', (t, done) => {
  const { dir, chats } = setup(t);
  // Drop only the placeholder rule that resolves to ~/.claude.json. The static `**/.claude.json`
  // rule stays, so this proves RESOLVED_REQUIRED is enforced and not shadowed by the relative rule.
  const text = fs.readFileSync(REAL_PROFILE, 'utf8').replace('"Read(//__HOME__/.claude.json)", ', '');
  fs.writeFileSync(path.join(dir, 'nondev-profile.json'), text);
  chats.createChat({ title: 'nohome', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ok(err && /validation/i.test(err.message), 'must reject a profile whose resolved home read floor is missing');
    done();
  });
});

// A BARE tool name in `allow` is as permissive as the `(*)` spelling — bare `Bash` allows every command
// and makes the entire Bash denylist moot. The guard used to reject only `Bash(*)`.
for (const bare of ['Bash', 'Write', 'Edit', 'WebFetch', '*']) {
  test(`nondev launch fails CLOSED when allow contains bare ${bare}`, (t, done) => {
    const { dir, chats } = setup(t);
    const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
    profile.permissions.allow.push(bare);
    fs.writeFileSync(path.join(dir, 'nondev-profile.json'), JSON.stringify(profile));
    chats.createChat({ title: 'bare', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
      assert.ok(err && /validation/i.test(err.message), `must reject a bare ${bare} allow`);
      done();
    });
  });
}

// Per the Claude Code permissions docs, file permission checks match only Edit(path)/Read(path). A
// Grep(path) or Glob(path) rule is accepted but NEVER matched and emits a startup warning for each one.
// They were briefly added here in cc83af6 on a wrong premise; this pins them out for good.
test('profile contains NO inert rule forms (Write/NotebookEdit/Glob/Grep paths are never matched)', () => {
  const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
  const bad = [...profile.permissions.deny, ...profile.permissions.allow]
    .filter(r => /^(Grep|Glob|Write|NotebookEdit)\s*\(/.test(r));
  assert.deepStrictEqual(bad, [], 'inert rule form — use Edit(...) for writes and Read(...) for reads');
});

// Confirmed live 2026-07-26: Claude Code printed a startup warning for all 26 Write()/NotebookEdit()
// rules and refused to match them, so those paths were NOT write-protected at all. Every path the
// profile means to make unwritable must therefore carry an Edit(...) rule.
test('every write-protected path is expressed as Edit(...), covering all file-editing tools', () => {
  const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
  const edits = profile.permissions.deny.filter(r => r.startsWith('Edit('));
  for (const name of ['.ssh', '.aws', '.gnupg', 'LaunchAgents', 'id_rsa', 'authorized_keys', '.zshrc', '.claude/']) {
    assert.ok(edits.some(r => r.includes(name)), `${name} needs an Edit(...) deny — a Write(...) rule is never matched`);
  }
});

test('a profile carrying an inert rule form fails CLOSED', (t, done) => {
  const { dir, chats } = setup(t);
  const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
  profile.permissions.deny.push('Write(//tmp/anything/**)');
  fs.writeFileSync(path.join(dir, 'nondev-profile.json'), JSON.stringify(profile));
  chats.createChat({ title: 'inert', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ok(err && /validation/i.test(err.message), 'must reject a profile containing an inert Write() rule');
    done();
  });
});

test('the GENERATED workspace allow grant uses Edit(...) only, with no inert Write/NotebookEdit twin', (t, done) => {
  const fixture = setup(t);
  seedRealProfile(fixture.dir);
  fixture.chats.createChat({ title: 'gen', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err) => {
    assert.ifError(err);
    const profDir = path.join(fixture.ndroot, 'profiles');
    const f = fs.readdirSync(profDir).filter(x => x.endsWith('.json'))[0];
    const gen = JSON.parse(fs.readFileSync(path.join(profDir, f), 'utf8'));
    const inert = gen.permissions.allow.filter(r => /^(Write|NotebookEdit|Glob|Grep)\s*\(/.test(r));
    assert.deepStrictEqual(inert, [], 'generated allow must not contain inert forms (they warn at startup)');
    assert.ok(gen.permissions.allow.some(r => /^Edit\(\/\//.test(r)), 'generated allow needs the Edit(workspace) grant');
    done();
  });
});

// Every floor meant to protect something OUTSIDE the throwaway workspace must be // or ~/ anchored;
// a relative rule matches only at or under the cwd and silently protects nothing.
test('every home/secret Read floor is filesystem- or home-anchored, not relative', () => {
  const profile = JSON.parse(fs.readFileSync(REAL_PROFILE, 'utf8'));
  const reads = profile.permissions.deny.filter(r => r.startsWith('Read('));
  for (const name of ['.zshrc', '.bashrc', '.profile', '.zsh_history', '.claude.json']) {
    const anchored = reads.some(r => (r.includes('(~/') || r.includes('(//')) && r.includes(name));
    assert.ok(anchored, `${name} needs a ~/ or // anchored Read floor, not just a relative one`);
  }
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
    assert.ok(prof.permissions.deny.includes('Edit(//Users/example/team cockpit/**)'), 'repo floor comes from the stamp');
    // The location-independent relative backstop is always present too (defense in depth).
    assert.ok(prof.permissions.deny.includes('Edit(**/falaq-cockpit/**)'), 'relative backstop present');
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
    assert.ok(prof.permissions.deny.includes("Edit(//Users/José Müller-O'Brien/.ssh/**)"), 'accented home floor resolves verbatim');
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

// ---- session hooks in the generated safe-mode profile (2026-08-18) ----
// --setting-sources project drops the user settings layer where the cockpit hooks live; without
// hooks re-injected into the generated --settings profile, a safe-mode chat never registers a
// session and /chat can never show its state or pending-question card. Hooks in a --settings file
// were empirically proven to fire under --setting-sources project (SessionStart marker probe).
test('generated nondev profile carries the session hooks (no start.js)', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  chats.createChat({ title: 'hooked', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err, nd) => {
    assert.ifError(err);
    const prof = JSON.parse(fs.readFileSync(nd.nondevProfileFile, 'utf8'));
    assert.ok(prof.hooks, 'profile has a hooks block');
    // drift-guard: same event set the installed user hooks use (hooks.template.json), minus the
    // SessionStart start.js entry — a chat must not be able to respawn the server.
    // run-tests.sh flattens src/ next to test/, so probe both layouts
    const tmplPath = [path.join(__dirname, '..', 'hooks.template.json'), path.join(__dirname, '..', 'src', 'hooks.template.json')].find(fs.existsSync);
    const tmpl = JSON.parse(fs.readFileSync(tmplPath, 'utf8'));
    assert.deepStrictEqual(Object.keys(prof.hooks).sort(), Object.keys(tmpl.hooks).sort(),
      'profile hook events track hooks.template.json');
    const flat = JSON.stringify(prof.hooks);
    assert.ok(flat.includes('session-hook.js'), 'hooks relay to session-hook.js');
    assert.ok(!flat.includes('start.js'), 'server keepalive start.js must NOT run inside a chat');
    assert.ok(prof.hooks.PostToolUse[0].matcher === '*', 'PostToolUse keeps the * matcher');
    done();
  });
});

// ---- startup dialog decisions against REAL captured frames (2026-08-18, Claude ~2.1.3x) ----
test('startupDialogAction answers each real startup dialog correctly', (t) => {
  const { chats } = setup(t);
  const trustFrame = ' Accessing workspace:\n\n /Users/u/.cockpit-nondev/ws-x\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n';
  const importsFrame = '  Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks\n\n  ❯ 1. Yes, allow external imports\n    2. No, disable external imports\n';
  const footerFrame = '❯ Try "fix lint errors"\n  ⏸ manual mode on · ? for shortcuts · ← for agents';
  assert.equal(chats.startupDialogAction(trustFrame, 'nondev'), 'trust-enter');
  assert.equal(chats.startupDialogAction(trustFrame, 'dev'), 'trust-enter');
  // the imports frame CONTAINS the words "files you trust" — it must hit the imports branch,
  // never the generic trust-accept (blind Enter would silently allow external imports in safe mode)
  assert.equal(chats.startupDialogAction(importsFrame, 'nondev'), 'key-2');
  // dispatch is an unattended HARDENED profile — it must decline external imports like nondev,
  // never take the dev default (panel MAJOR: the first cut gave dispatch the dev answer)
  assert.equal(chats.startupDialogAction(importsFrame, 'dispatch'), 'key-2');
  assert.equal(chats.startupDialogAction(importsFrame, 'dev'), 'enter');
  assert.equal(chats.startupDialogAction(footerFrame, 'nondev'), null);
  assert.equal(chats.startupDialogAction('', 'dev'), null);
  // ---- Claude 2.1.259 (2026-09-03) re-ordered the trust options and parks the cursor on "No, exit".
  // Real frame captured 2026-09-04 from a chat the old blind Enter had left stranded; Enter there
  // exits the CLI, so the loop must step down to Yes first.
  const trustNoFirst = ' Accessing workspace:\n /Users/u\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder.\n Claude Code\'ll be able to read, edit, and execute files here.\n Security guide\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n';
  assert.equal(chats.startupDialogAction(trustNoFirst, 'dev'), 'trust-down');
  assert.equal(chats.startupDialogAction(trustNoFirst, 'nondev'), 'trust-down');
  assert.equal(chats.startupDialogAction(trustNoFirst, 'dispatch'), 'trust-down');
  // same dialog once the cursor already sits on Yes (after our Down landed): a bare Enter accepts
  const trustYesRow = trustNoFirst.replace(' ❯ No, exit\n   Yes, I trust this folder', '   No, exit\n ❯ Yes, I trust this folder');
  assert.equal(chats.startupDialogAction(trustYesRow, 'dev'), 'trust-enter');
  // capture-pane -e frames carry colour codes around the cursor glyph — must still be recognised
  const trustNoAnsi = trustNoFirst.replace(' ❯ No, exit', ' \x1b[36m❯\x1b[39m \x1b[1mNo, exit\x1b[22m');
  assert.equal(chats.startupDialogAction(trustNoAnsi, 'dev'), 'trust-down');
  // legacy numbered layout with ">" as the cursor glyph, cursor on the decline row
  assert.equal(chats.startupDialogAction('Do you trust the files in this folder?\n  1. Yes, proceed\n> 2. No, exit\n', 'dev'), 'trust-down');
});

// ---- settle-loop WIRING (not just the pure function): a stateful stub serves the imports dialog
// first, then the footer — a promptless nondev chat must type the literal '2' decline, and the
// profiles-dir floors must land in its generated profile. Pins the loop itself against a revert
// to the old prompt-only/trust-only code (panel MINOR: the wiring was previously unpinned).
test('promptless nondev chat declines external imports through the live settle loop', (t, done) => {
  const { dir, chats } = setup(t);
  seedRealProfile(dir);
  const rec = path.join(dir, 'wiring-tmux.log');
  const counter = path.join(dir, 'wiring-count');
  const stub = path.join(dir, 'wiring-tmux');
  fs.writeFileSync(counter, '0');
  fs.writeFileSync(stub, `#!/bin/bash
echo "$@" >> "${rec}"
if [ "$1" = "capture-pane" ]; then
  n=$(cat "${counter}"); n=$((n+1)); echo "$n" > "${counter}"
  if [ "$n" -le 2 ]; then
    echo "  ❯ 1. Yes, allow external imports"
    echo "    2. No, disable external imports"
  else
    echo "manual mode on · ? for shortcuts"
  fi
fi
exit 0
`, { mode: 0o755 });
  process.env.CK_TMUX_BIN = stub;
  chats.createChat({ title: 'settle wiring', model: 'sonnet', effort: 'low', profile: 'nondev' }, (err, nd) => {
    assert.ifError(err);
    // generated profile carries the resolved profiles-dir floors (Edit + Read)
    const prof = JSON.parse(fs.readFileSync(nd.nondevProfileFile, 'utf8'));
    const profAbs = path.join(process.env.CK_NONDEV_ROOT, 'profiles').replace(/^\/+/, '');
    assert.ok(prof.permissions.deny.includes('Edit(//' + profAbs + '/**)'), 'Edit floor on the generated-profiles dir');
    assert.ok(prof.permissions.deny.includes('Read(//' + profAbs + '/**)'), 'Read floor on the generated-profiles dir');
    // the settle loop runs in the background for this promptless chat — poll for the decline keystroke
    const deadline = Date.now() + 4000;
    (function poll() {
      const calls = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8') : '';
      if (new RegExp('send-keys -t =' + nd.name + ':0 -l 2').test(calls)) return done();
      if (Date.now() > deadline) {
        assert.fail('settle loop never sent the imports decline; tmux calls were:\n' + calls);
      }
      setTimeout(poll, 150);
    })();
  });
});
