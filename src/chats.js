#!/usr/bin/env node
// chats.js — tmux-managed AI CLI chats for the Falaq Cockpit.
// Zero dependencies. Registry in chats.json (atomic writes).
// Security: tmux always via execFileSync arg arrays; names/models/efforts/keys allowlisted.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME_RE = /^ck-[a-z0-9-]{1,40}$/;
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);
const CODEX_MODELS = new Set(['gpt-5.6-sol']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const PROVIDERS = new Set(['claude', 'codex']);
const SPECIAL_KEYS = { enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', tab: 'Tab' };
const CHAR_KEYS = /^[yn1-9]$/;
// Full keyboard passthrough (the chat panel forwards real keydowns): an optional stack of
// C-/M-/S- modifiers followed by a named key OR a single printable char (0x21-0x7E). Everything
// goes to tmux via execFileSync argv, so a rejected/odd value is at worst a no-op keystroke —
// never shell injection. Literal typed text goes through the `text` path with `send-keys -l`.
const TERM_KEY_RE = /^(C-|M-|S-){0,3}(Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|IC|DC|F[1-9]|F1[0-2]|[!-~])$/;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function chatsFile() { return path.join(stateDir(), 'chats.json'); }
function nondevProfilePath() { return path.join(stateDir(), 'nondev-profile.json'); }
function dispatchProfilePath() { return path.join(stateDir(), 'dispatch-profile.json.template'); }
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// Non-dev workspaces + generated per-session profiles live OUTSIDE ~/.claude and the repo (default
// ~/.cockpit-nondev), so the profile's Write deny floors for those trees never overlap the workspace
// the non-dev is allowed to write. Overridable for tests.
function nondevRoot() { return process.env.CK_NONDEV_ROOT || path.join(os.homedir(), '.cockpit-nondev'); }
function dispatchRoot() { return process.env.CK_DISPATCH_ROOT || path.join(os.homedir(), '.cockpit-dispatch'); }
function codexLaunchRoot() { return process.env.CK_CODEX_LAUNCH_ROOT || path.join(os.homedir(), '.cockpit-codex'); }
function tmuxBin() {
  if (process.env.CK_TMUX_BIN) return process.env.CK_TMUX_BIN;
  return fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
}
function tmux(args, opts) { return execFileSync(tmuxBin(), args, { encoding: 'utf8', ...opts }); }

// Paths embedded in permission globs must remain literals after substitution.
function safePath(value, label, profile) {
  const stripped = String(value || '').replace(/^\/+/, '');
  if (!stripped || /[*?[\]{}()!@+|^"\\\x00-\x1f]/.test(stripped)) throw new Error('unsafe ' + label + ' path (glob/JSON metacharacter) while resolving ' + profile + ' profile');
  return stripped;
}

// Generates the per-session dispatch permission profile. IMPORTANT — this validates TEMPLATE INTEGRITY
// (no tampering, all placeholders resolved, critical denies present), NOT confinement. The profile is
// DEFENSE-IN-DEPTH, not a sandbox: a dispatched coding session has allow-listed interpreters (python3/node)
// and file tools that can read secrets, reach the network, and write outside the worktree via subprocess —
// the real boundary for unattended runs is OS-level (dedicated low-priv user, secret-free $HOME, egress
// firewall, read-only parent repo). Dispatch ships enabled:false; enabling it requires that OS isolation.
function buildDispatchProfile({ home, mirror, cockpit, worktree }) {
  const tmpl = dispatchProfilePath();
  let text;
  try { text = fs.readFileSync(tmpl, 'utf8'); }
  catch (e) { throw new Error('dispatch profile template missing/invalid at ' + tmpl); }
  try {
    text = text
      .replace(/__HOME__/g, safePath(home, 'home', 'dispatch'))
      .replace(/__MIRROR__/g, safePath(mirror, 'mirror', 'dispatch'))
      .replace(/__COCKPIT__/g, safePath(cockpit, 'cockpit', 'dispatch'))
      .replace(/__WORKTREE__/g, safePath(worktree, 'worktree', 'dispatch'));
    const base = JSON.parse(text);
    const requiredDeny = ['Bash(git push:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)', 'Bash(vercel:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(git diff:*)', 'Write(**/.claude/**)'];
    const deny = new Set(base && base.permissions && Array.isArray(base.permissions.deny) ? base.permissions.deny : []);
    const allow = base && base.permissions && Array.isArray(base.permissions.allow) ? base.permissions.allow : [];
    if (!base || !base.permissions || base.permissions.defaultMode !== 'default' ||
        allow.includes('Bash(*)') || allow.includes('Bash(git:*)') || allow.includes('Write') || allow.includes('Edit') ||
        !requiredDeny.every(rule => deny.has(rule)) || /__.*?__/.test(JSON.stringify(base))) {
      throw new Error('security validation failed');
    }
    return base;
  } catch (e) {
    throw new Error('dispatch profile template missing/invalid at ' + tmpl + ': ' + e.message);
  }
}

function loadChats() {
  try {
    const chats = JSON.parse(fs.readFileSync(chatsFile(), 'utf8'));
    return Array.isArray(chats) ? chats.map(c => ({ ...c, provider: c.provider || 'claude' })) : [];
  } catch (e) { return []; }
}
function saveChats(chats) {
  fs.writeFileSync(chatsFile() + '.tmp', JSON.stringify(chats, null, 2));
  fs.renameSync(chatsFile() + '.tmp', chatsFile());
}
function slugify(title) {
  const base = String(title || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'chat';
  let name = 'ck-' + base, i = 2;
  const taken = new Set(loadChats().map(c => c.name));
  while (taken.has(name)) name = 'ck-' + base.slice(0, 20) + '-' + i++;
  return name;
}
function deriveTitle(prompt) {
  let text = String(prompt == null ? '' : prompt)
    .replace(/^\s*ultracode\b[\s\p{P}\p{S}]*/iu, '')
    .split(/\r?\n|[.!?](?:\s|$)/, 1)[0]
    .replace(/^\s+|\s+$/g, '')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
  const filler = /^(?:please|can\s+you|could\s+you|help\s+me|i\s+need\s+to|i\s+want\s+to|let['’]?s|lets|hey|hi|ok|okay|so)\b[\s\p{P}\p{S}]*/iu;
  let previous;
  do {
    previous = text;
    text = text.replace(filler, '').replace(/^[\s\p{P}\p{S}]+/gu, '');
  } while (text && text !== previous);
  text = text.replace(/[\s\p{P}\p{S}]+$/gu, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const words = text.split(' ').slice(0, 8);
  while (words.length && words.join(' ').length > 80) words.pop();
  return words.join(' ');
}
function sanitizeUploadFilename(filename) {
  // Normalize both separator styles before taking the basename so Windows-looking
  // names cannot become nested paths when the server runs on macOS or Linux.
  const base = path.posix.basename(String(filename || '').replace(/\\/g, '/'));
  return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'paste.png';
}
function saveUpload(uploadStateDir, chatName, filename, dataBase64, now = Date.now()) {
  if (!NAME_RE.test(chatName)) throw new Error('bad name');
  if (typeof dataBase64 !== 'string' || !dataBase64.length) throw new Error('file data is required');
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length) throw new Error('file data is required');
  if (data.length > MAX_UPLOAD_BYTES) throw new Error('file is larger than 15 MB');
  const dir = path.resolve(uploadStateDir, 'uploads', chatName);
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeUploadFilename(filename);
  let savedPath = path.join(dir, `${now}-${safe}`);
  try {
    fs.writeFileSync(savedPath, data, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    savedPath = path.join(dir, `${now}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
    fs.writeFileSync(savedPath, data, { flag: 'wx' });
  }
  return savedPath;
}
function validate({ cwd, model, effort, provider = 'claude' }) {
  if (!PROVIDERS.has(provider)) return 'invalid provider';
  const models = provider === 'codex' ? CODEX_MODELS : MODELS;
  const efforts = provider === 'codex' ? CODEX_EFFORTS : EFFORTS;
  if (!models.has(model)) return 'invalid model';
  if (!efforts.has(effort)) return 'invalid effort';
  let real;
  try { real = fs.realpathSync(cwd); } catch (e) { return 'cwd does not exist'; }
  if (!fs.statSync(real).isDirectory()) return 'cwd is not a directory';
  const home = os.homedir();
  if (real !== home && !(real + path.sep).startsWith(home + path.sep)) return 'cwd must be under home';
  return null;
}
function isAlive(name) {
  try { tmux(['has-session', '-t', '=' + name], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch (e) { return false; }
}
function listChats() { return loadChats().map(c => ({ ...c, alive: isAlive(c.name) })); }
function screen(name, lines) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  return tmux(['capture-pane', '-p', '-e', '-t', '=' + name + ':0', '-S', String(-(lines || 120))]);
}
function cursor(name) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  // "cursor_y cursor_x pane_height" — 0-indexed y/x from the top-left of the visible pane
  return tmux(['display-message', '-p', '-t', '=' + name + ':0', '-F', '#{cursor_y} #{cursor_x} #{pane_height}']).trim();
}
function sendInput(name, text) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 4000);
  if (!clean) return;
  tmux(['send-keys', '-t', '=' + name + ':0', '-l', clean]);
  tmux(['send-keys', '-t', '=' + name + ':0', 'Enter']);
}
function sendKey(name, key) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  if (SPECIAL_KEYS[key]) tmux(['send-keys', '-t', '=' + name + ':0', SPECIAL_KEYS[key]]);
  else if (CHAR_KEYS.test(key)) tmux(['send-keys', '-t', '=' + name + ':0', '-l', key]);
  else throw new Error('key not allowed');
}
// Full-keyboard passthrough for the chat terminal. spec = { t:'text', v:'<chars>' } to type
// literal characters, or { t:'key', v:'<C-/M-/S- + key>' } for a control/special key.
function sendTermKey(name, spec) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  const t = spec && spec.t, v = spec && spec.v;
  if (t === 'text') {
    const s = String(v == null ? '' : v).slice(0, 8192);
    if (!s) return;
    tmux(['send-keys', '-t', '=' + name + ':0', '-l', s]);
    return;
  }
  if (t === 'key') {
    const k = String(v == null ? '' : v);
    if (!TERM_KEY_RE.test(k)) throw new Error('key not allowed');
    tmux(['send-keys', '-t', '=' + name + ':0', k]);
    return;
  }
  throw new Error('bad key spec');
}
function killChat(name) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  try { tmux(['kill-session', '-t', '=' + name]); } catch (e) {}
  // Clean up a non-dev chat's per-session workspace + generated profile so nothing persists across
  // sessions. Guard the recursive remove to a cockpit-owned `ws-*` dir under nondevRoot() — never a
  // user cwd or an arbitrary path.
  const chat = loadChats().find(c => c.name === name);
  if (chat && chat.profile === 'nondev') {
    try { if (chat.nondevProfileFile) fs.rmSync(chat.nondevProfileFile, { force: true }); } catch (e) {}
    try {
      const root = nondevRoot();
      if (chat.cwd && chat.cwd.startsWith(root + path.sep) && /\/ws-[^/]+\/?$/.test(chat.cwd)) {
        fs.rmSync(chat.cwd, { recursive: true, force: true });
      }
    } catch (e) {}
  }
  if (chat && chat.profile === 'dispatch') {
    try { if (chat.dispatchProfileFile) fs.rmSync(chat.dispatchProfileFile, { force: true }); } catch (e) {}
    try {
      const root = dispatchRoot();
      if (chat.repo && chat.worktree && chat.worktree.startsWith(root + path.sep) && /\/wt-[^/]+\/?$/.test(chat.worktree)) {
        execFileSync('git', ['-C', chat.repo, 'worktree', 'remove', '--force', chat.worktree], { stdio: 'ignore' });
      }
    } catch (e) {}
  }
  if (chat && chat.provider === 'codex') {
    try {
      const root = codexLaunchRoot();
      if (chat.cwd && chat.cwd.startsWith(root + path.sep) && /\/run-[^/]+\/?$/.test(chat.cwd)) {
        fs.rmSync(chat.cwd, { recursive: true, force: true });
      }
    } catch (e) {}
  }
  saveChats(loadChats().filter(c => c.name !== name));
}
function createChat(opts, cb) {
  const provider = opts.provider || 'claude';
  if (!PROVIDERS.has(provider)) return cb(new Error('invalid provider'));
  const title = opts.title && String(opts.title).trim()
    ? opts.title
    : (deriveTitle(opts.prompt || '') || 'chat');
  const model = opts.model || (provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet');
  const effort = opts.effort || 'medium';
  let profile;
  if (opts.profile === undefined || opts.profile === 'dev') profile = 'dev';
  else if (opts.profile === 'nondev') profile = 'nondev';
  else if (opts.profile === 'dispatch') profile = 'dispatch';
  else return cb(new Error('unknown permission profile'));
  // The existing safe/dispatch profiles are Claude Code --settings files. They cannot honestly be
  // advertised as Codex security profiles, so phase-one Codex launches are dev-profile only.
  if (provider === 'codex' && profile !== 'dev') return cb(new Error('codex supports only the dev permission profile'));
  let cwd = opts.cwd || os.homedir();
  let requestedCwd = cwd;
  let permFlags = '';
  let nondevProfileFile = null;
  let dispatchProfileFile = null;
  let worktree = null;
  let repo = null;
  if (profile === 'nondev') {
    // Non-dev sessions run on a CLEAN permission baseline: --setting-sources project drops the user +
    // local settings layers (which grant Bash(*)); --settings loads the curated hybrid profile. Two
    // hard rules the review panel proved necessary:
    //  (1) FRESH per-session workspace (empty dir) — a SHARED workspace lets one chat Write a
    //      <ws>/.claude/settings.json that the NEXT chat's --setting-sources project would inherit,
    //      re-introducing Bash(*). A fresh dir has nothing planted; killChat removes it.
    //  (2) Write/Edit/NotebookEdit are NOT bare-allowed (Claude Code does NOT auto-jail an allow-listed
    //      edit tool → bare Write silently overwrites ANY absolute path incl ~/.zshrc, ~/.claude, this
    //      profile). Instead we generate a per-session profile = the static template PLUS write/edit
    //      SCOPED to THIS workspace only (the `//<abs>/**` double-slash form auto-approves in-ws writes;
    //      a single slash is read as cwd-relative and fails). Deny beats allow, so the template's write
    //      floors still block ~/.claude, rc files, etc. even inside an oddly-named ws path.
    // Fail CLOSED: a missing/invalid template must never launch a non-dev unprofiled.
    const tmpl = nondevProfilePath();
    let base, templateText;
    try { templateText = fs.readFileSync(tmpl, 'utf8'); } catch (e) { return cb(new Error('non-dev profile template missing/invalid at ' + tmpl)); }
    // A path substituted into a permission-rule GLOB must be a literal — reject anything glob-meaningful
    // in the minimatch family so the resolved deny rule matches exactly the path it names, never a
    // pattern. Rejected: * ? [ ] { } ( ) ! @ + | ^ (glob/extglob/brace/negation), plus " \ and control
    // chars (JSON-string break / injection). Everything ELSE is kept, so the realistic portability cases
    // the panel flagged still work: accents (/Users/José), umlauts, spaces, hyphens, apostrophes, commas,
    // '.', '_', '~', ':' are all literal in a glob and legal in a JSON string. A path that DOES contain a
    // glob metacharacter (e.g. a clone at ~/repo{a,b}) fails CLOSED — safe mode is refused with a clear
    // message rather than installing a floor that guards the wrong (expanded) path. The old allowlist of
    // only [A-Za-z0-9._ -] over-rejected accents/punctuation and silently broke safe mode (panel MAJOR);
    // the intermediate broadened set under-rejected glob metacharacters (panel re-review BLOCKER).
    const nondevSafePath = (value, label) => safePath(value, label, 'non-dev');
    try {
      const home = nondevSafePath(os.homedir(), 'home');
      const mirror = nondevSafePath(stateDir(), 'mirror');
      // The cockpit SOURCE checkout deny floor: env (tests) → the .repo-root stamp install.sh/deploy.sh
      // write into the mirror. There is NO guessed fallback: guessing ~/falaq-cockpit when the real
      // clone is elsewhere would put the floor on the WRONG path, and writing the real checkout is then
      // a self-approvable prompt (panel BLOCKER). If we can't POSITIVELY resolve the source root we fail
      // closed — the relative `**/falaq-cockpit/**` backstop in the template still covers the default
      // clone name, but a non-dev chat must never launch with the exact-path floor silently misplaced.
      let repo = process.env.CK_REPO_ROOT;
      if (!repo) { try { repo = fs.readFileSync(path.join(stateDir(), '.repo-root'), 'utf8').trim(); } catch (e) {} }
      if (!repo) return cb(new Error('non-dev safe mode unavailable: cockpit source root is not stamped — run ./install.sh or ./deploy.sh so the source deny floor resolves correctly'));
      templateText = templateText
        .replace(/__HOME__/g, home)
        .replace(/__MIRROR__/g, mirror)
        .replace(/__COCKPIT__/g, nondevSafePath(repo, 'cockpit'));
      base = JSON.parse(templateText);
    } catch (e) { return cb(new Error('non-dev profile template missing/invalid at ' + tmpl + ': ' + e.message)); }
    // Validate the template is genuinely the hardened profile, not merely a large one: defaultMode must
    // prompt-by-default, the CRITICAL deny rules must be present (a tampered/relaxed profile that dropped
    // any of these would silently exfil/exec), and no blanket Bash(*) allow.
    const REQUIRED_DENY = ['Bash(cat:*)', 'Bash(curl:*)', 'Bash(rm:*)', 'Bash(git diff:*)', 'Bash(git push:*)', 'Bash(sudo:*)', 'Bash(python3:*)', 'Bash(env:*)', 'Write(**/.claude/**)', 'Read(**/id_rsa*)'];
    const denySet = new Set(base && base.permissions && Array.isArray(base.permissions.deny) ? base.permissions.deny : []);
    const allowArr = base && base.permissions && Array.isArray(base.permissions.allow) ? base.permissions.allow : [];
    // Also assert the RESOLVED per-machine floors actually landed — a template edit that dropped only
    // the home/cockpit write-denies (keeping size ≥ 120 + the static rules) would otherwise slip through
    // (panel MINOR, defense-in-depth). These are the highest-value portable floors.
    const homeAbs = os.homedir().replace(/^\/+/, '');
    const RESOLVED_REQUIRED = [`Write(//${homeAbs}/.ssh/**)`, `Write(//${homeAbs}/.claude/**)`];
    if (!base || !base.permissions || base.permissions.defaultMode !== 'default' || denySet.size < 120 ||
        allowArr.includes('Bash(*)') || allowArr.includes('Write') || allowArr.includes('Edit') ||
        !REQUIRED_DENY.every(r => denySet.has(r)) || !RESOLVED_REQUIRED.every(r => denySet.has(r)) ||
        /__(?:HOME|MIRROR|COCKPIT)__/.test(JSON.stringify(base))) {
      return cb(new Error('non-dev profile template failed security validation at ' + tmpl));
    }
    try { fs.mkdirSync(nondevRoot(), { recursive: true }); } catch (e) {}
    cwd = fs.mkdtempSync(path.join(nondevRoot(), 'ws-'));
    base.permissions.allow.push('Edit(//' + cwd.replace(/^\/+/, '') + '/**)', 'Write(//' + cwd.replace(/^\/+/, '') + '/**)', 'NotebookEdit(//' + cwd.replace(/^\/+/, '') + '/**)');
    const profDir = path.join(nondevRoot(), 'profiles');
    try { fs.mkdirSync(profDir, { recursive: true }); } catch (e) {}
    nondevProfileFile = path.join(profDir, path.basename(cwd) + '.json');
    fs.writeFileSync(nondevProfileFile, JSON.stringify(base), { mode: 0o600 });
    permFlags = ' --setting-sources project --settings ' + shq(nondevProfileFile);
  }
  if (profile === 'dispatch') {
    if (!opts.cwd || !opts.branch) return cb(new Error('dispatch requires a git repo cwd and branch'));
    const dispatchValidation = MODELS.has(model) ? (EFFORTS.has(effort) ? null : 'invalid effort') : 'invalid model';
    if (dispatchValidation) return cb(new Error(dispatchValidation));
    try {
      repo = fs.realpathSync(execFileSync('git', ['-C', opts.cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      if (!fs.statSync(repo).isDirectory()) throw new Error('not a directory');
    } catch (e) { return cb(new Error('dispatch cwd is not a real git repo')); }
    let cockpit = process.env.CK_REPO_ROOT;
    if (!cockpit) { try { cockpit = fs.readFileSync(path.join(stateDir(), '.repo-root'), 'utf8').trim(); } catch (e) {} }
    if (!cockpit) return cb(new Error('dispatch profile unavailable: cockpit source root is not stamped'));
    try {
      fs.mkdirSync(dispatchRoot(), { recursive: true });
      worktree = fs.mkdtempSync(path.join(dispatchRoot(), 'wt-'));
      const base = buildDispatchProfile({ home: os.homedir(), mirror: stateDir(), cockpit, worktree });
      execFileSync('git', ['-C', repo, 'worktree', 'add', worktree, '-b', String(opts.branch)], { stdio: 'ignore' });
      // Neutralize any in-repo .claude/ in the checkout: `--setting-sources project` would otherwise load the
      // worktree's committed settings/hooks, which can add `allow` rules or run shell OUTSIDE the permission
      // layer (review-panel MAJOR — code exec just by starting the session there). Best-effort defense-in-depth.
      try { fs.rmSync(path.join(worktree, '.claude'), { recursive: true, force: true }); } catch (e) {}
      cwd = worktree;
      const profDir = path.join(dispatchRoot(), 'profiles');
      fs.mkdirSync(profDir, { recursive: true });
      dispatchProfileFile = path.join(profDir, path.basename(worktree) + '.json');
      fs.writeFileSync(dispatchProfileFile, JSON.stringify(base), { mode: 0o600 });
      permFlags = ' --setting-sources project --settings ' + shq(dispatchProfileFile);
    } catch (e) {
      try { if (dispatchProfileFile) fs.rmSync(dispatchProfileFile, { force: true }); } catch (_) {}
      try { if (worktree) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' }); } catch (_) {}
      try { if (worktree) fs.rmSync(worktree, { recursive: true, force: true }); } catch (_) {}
      return cb(new Error('dispatch worktree/profile setup failed: ' + e.message));
    }
  }
  // The dev cwd is user-provided → full validate (incl. the under-$HOME jail). The nondev cwd is ALWAYS
  // the cockpit-owned neutral workspace under stateDir (never user input), so it only needs model/effort
  // validated — the under-$HOME check would wrongly reject a stateDir that lives outside $HOME (e.g. tests).
  const err = profile === 'nondev' || profile === 'dispatch'
    ? (MODELS.has(model) ? (EFFORTS.has(effort) ? null : 'invalid effort') : 'invalid model')
    : validate({ cwd, model, effort, provider });
  if (err) return cb(new Error(err));
  requestedCwd = fs.realpathSync(cwd);
  // Codex exposes no launch-settable session tag. Give every cockpit launch a unique real cwd so
  // codex.js can correlate its rollout session_meta by cwd + fresh mtime. The requested workspace is
  // retained in the registry, linked from the correlation dir, and allow-listed for Codex writes.
  if (provider === 'codex') {
    let correlationCwd = null;
    try {
      fs.mkdirSync(codexLaunchRoot(), { recursive: true });
      correlationCwd = fs.mkdtempSync(path.join(codexLaunchRoot(), 'run-'));
      fs.symlinkSync(requestedCwd, path.join(correlationCwd, 'workspace'), 'dir');
      cwd = correlationCwd;
    } catch (e) {
      try { if (correlationCwd) fs.rmSync(correlationCwd, { recursive: true, force: true }); } catch (_) {}
      return cb(new Error('codex correlation cwd setup failed: ' + e.message));
    }
  }
  const name = slugify(title);
  // model/effort come from allowlists above, so this string is injection-safe
  const command = process.env.CK_TEST_CMD || (provider === 'codex'
    ? ('codex --model ' + model + ' --config model_reasoning_effort=' + effort + ' --add-dir ' + shq(requestedCwd))
    : ('claude' + permFlags + ' --model ' + model + ' --effort ' + effort));
  // -e CK_CHAT=<name>: the session-hook reads this env var and stamps `chatName` onto the monitored
  //   session file, binding this controlled chat to its Claude session by EXACT identity. That kills
  //   the old cwd+time-guess correlation that produced duplicate (non-clickable) cards when the
  //   session's reported cwd differed from the chat's launch cwd.
  // -y 200: a taller VIRTUAL pane (it's detached, so height is not tied to any real terminal) so the
  //   full-screen Claude TUI renders far more rows — much more of the live conversation is visible /
  //   scrollable at once. capture-pane reads this virtual frame.
  try { tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '200', '-e', 'CK_CHAT=' + name, command]); }
  catch (e) {
    if (provider === 'codex') {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
    }
    if (profile === 'dispatch') {
      try { if (dispatchProfileFile) fs.rmSync(dispatchProfileFile, { force: true }); } catch (_) {}
      try { if (repo && worktree) execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' }); } catch (_) {}
    }
    return cb(new Error('tmux new-session failed: ' + e.message));
  }
  const chat = { name, title: String(title || name).slice(0, 80), cwd, model, effort, provider, ultracode: !!opts.ultracode, profile, createdAt: Date.now() };
  if (provider === 'codex') chat.requestedCwd = requestedCwd;
  if (nondevProfileFile) chat.nondevProfileFile = nondevProfileFile;
  if (dispatchProfileFile) Object.assign(chat, { worktree, dispatchProfileFile, repo, branch: String(opts.branch) });
  saveChats([...loadChats(), chat]);
  // "ultracode" is a keyword (not a CLI flag) that opts the session into multi-agent
  // workflow orchestration — inject it into the first message we send.
  const firstPrompt = opts.ultracode ? ('ultracode\n\n' + (opts.prompt || '')).trim() : opts.prompt;
  if (!firstPrompt) return cb(null, chat);
  // wait for the claude TUI input prompt, then type the first message.
  // The trust-dialog first-run screen also renders a "❯"/">" marker, so we can't
  // key off that alone — accept its default (Enter) and keep polling for the real
  // REPL footer, which the trust dialog never renders. The footer wording varies
  // by build ("? for shortcuts" or "for agents"), so match either.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    let text = '';
    // capture the whole frame (= the pane height, 200 rows): the trust dialog renders mid-screen, so a
    // bottom-50 slice would miss it and the first-prompt auto-send would stall. Capping at the pane
    // height (not more) avoids pulling any stale startup scrollback into the readiness match.
    try { text = screen(name, 200); } catch (e) {}
    if (/trust the files|Yes, proceed|Do you trust|trust this folder|Is this a project you|I trust this folder/i.test(text)) {
      try { sendKey(name, 'enter'); } catch (e) {}
    }
    const ready = /\? for shortcuts|for agents/.test(text);
    if (ready || tries >= 60) {
      clearInterval(timer);
      try { sendInput(name, firstPrompt); } catch (e) {}
      cb(null, chat);
    }
  }, 500);
}
module.exports = { createChat, listChats, isAlive, screen, cursor, sendInput, sendKey, sendTermKey, killChat, slugify, deriveTitle, sanitizeUploadFilename, saveUpload, validate, buildDispatchProfile, NAME_RE, MAX_UPLOAD_BYTES };
