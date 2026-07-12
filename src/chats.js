#!/usr/bin/env node
// chats.js — tmux-managed Claude Code chats for the Falaq Cockpit.
// Zero dependencies. Registry in chats.json (atomic writes).
// Security: tmux always via execFileSync arg arrays; names/models/efforts/keys allowlisted.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME_RE = /^ck-[a-z0-9-]{1,40}$/;
const MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SPECIAL_KEYS = { enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', tab: 'Tab' };
const CHAR_KEYS = /^[yn1-9]$/;
// Full keyboard passthrough (the chat panel forwards real keydowns): an optional stack of
// C-/M-/S- modifiers followed by a named key OR a single printable char (0x21-0x7E). Everything
// goes to tmux via execFileSync argv, so a rejected/odd value is at worst a no-op keystroke —
// never shell injection. Literal typed text goes through the `text` path with `send-keys -l`.
const TERM_KEY_RE = /^(C-|M-|S-){0,3}(Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|IC|DC|F[1-9]|F1[0-2]|[!-~])$/;

function stateDir() { return process.env.COCKPIT_DIR || __dirname; }
function chatsFile() { return path.join(stateDir(), 'chats.json'); }
function nondevProfilePath() { return path.join(stateDir(), 'nondev-profile.json'); }
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// Non-dev workspaces + generated per-session profiles live OUTSIDE ~/.claude and the repo (default
// ~/.cockpit-nondev), so the profile's Write deny floors for those trees never overlap the workspace
// the non-dev is allowed to write. Overridable for tests.
function nondevRoot() { return process.env.CK_NONDEV_ROOT || path.join(os.homedir(), '.cockpit-nondev'); }
function tmuxBin() {
  if (process.env.CK_TMUX_BIN) return process.env.CK_TMUX_BIN;
  return fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
}
function tmux(args, opts) { return execFileSync(tmuxBin(), args, { encoding: 'utf8', ...opts }); }

function loadChats() { try { return JSON.parse(fs.readFileSync(chatsFile(), 'utf8')); } catch (e) { return []; } }
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
  const words = text.split(' ').slice(0, 6);
  while (words.length && words.join(' ').length > 48) words.pop();
  return words.join(' ');
}
function validate({ cwd, model, effort }) {
  if (!MODELS.has(model)) return 'invalid model';
  if (!EFFORTS.has(effort)) return 'invalid effort';
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
  saveChats(loadChats().filter(c => c.name !== name));
}
function createChat(opts, cb) {
  const title = opts.title && String(opts.title).trim()
    ? opts.title
    : (deriveTitle(opts.prompt || '') || 'chat');
  const model = opts.model || 'sonnet';
  const effort = opts.effort || 'medium';
  const profile = opts.profile === 'nondev' ? 'nondev' : 'dev';
  let cwd = opts.cwd || os.homedir();
  let permFlags = '';
  let nondevProfileFile = null;
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
    const safePath = (value, label) => {
      const stripped = String(value || '').replace(/^\/+/, '');
      if (!stripped || /[*?[\]{}()!@+|^"\\\x00-\x1f]/.test(stripped)) throw new Error('unsafe ' + label + ' path (glob/JSON metacharacter) while resolving non-dev profile');
      return stripped;
    };
    try {
      const home = safePath(os.homedir(), 'home');
      const mirror = safePath(stateDir(), 'mirror');
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
        .replace(/__COCKPIT__/g, safePath(repo, 'cockpit'));
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
  // The dev cwd is user-provided → full validate (incl. the under-$HOME jail). The nondev cwd is ALWAYS
  // the cockpit-owned neutral workspace under stateDir (never user input), so it only needs model/effort
  // validated — the under-$HOME check would wrongly reject a stateDir that lives outside $HOME (e.g. tests).
  const err = profile === 'nondev'
    ? (MODELS.has(model) ? (EFFORTS.has(effort) ? null : 'invalid effort') : 'invalid model')
    : validate({ cwd, model, effort });
  if (err) return cb(new Error(err));
  const name = slugify(title);
  // model/effort come from allowlists above, so this string is injection-safe
  const command = process.env.CK_TEST_CMD || ('claude' + permFlags + ' --model ' + model + ' --effort ' + effort);
  // -e CK_CHAT=<name>: the session-hook reads this env var and stamps `chatName` onto the monitored
  //   session file, binding this controlled chat to its Claude session by EXACT identity. That kills
  //   the old cwd+time-guess correlation that produced duplicate (non-clickable) cards when the
  //   session's reported cwd differed from the chat's launch cwd.
  // -y 200: a taller VIRTUAL pane (it's detached, so height is not tied to any real terminal) so the
  //   full-screen Claude TUI renders far more rows — much more of the live conversation is visible /
  //   scrollable at once. capture-pane reads this virtual frame.
  try { tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '200', '-e', 'CK_CHAT=' + name, command]); }
  catch (e) { return cb(new Error('tmux new-session failed: ' + e.message)); }
  const chat = { name, title: String(title || name).slice(0, 80), cwd, model, effort, ultracode: !!opts.ultracode, profile, createdAt: Date.now() };
  if (nondevProfileFile) chat.nondevProfileFile = nondevProfileFile;
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
module.exports = { createChat, listChats, screen, sendInput, sendKey, sendTermKey, killChat, slugify, deriveTitle, validate, NAME_RE };
