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
const PROVIDERS = new Set(['claude', 'codex', 'ollama', 'agy']);
// Model/effort allowlists come from the background-refreshed registry (src/models.js), which always
// serves a non-empty fallback catalog even when cold. Required lazily so a registry load problem can
// never break requiring chats.js itself.
let modelsModule = null;
function modelsReg() { return modelsModule || (modelsModule = require('./models')); }
// Hard safety floor, independent of the registry: every claude/codex/agy model id and every effort
// that can reach the tmux command string must match this (rejects `[1m]` suffixes, `;`, `$(`, spaces).
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isSafeId(id) { return typeof id === 'string' && SAFE_ID_RE.test(id); }
// Ollama ids may be namespaced (`library/model:tag`); any `.`/`..` path segment is rejected.
const OLLAMA_MODEL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?::[A-Za-z0-9._-]+)?$/;
function isOllamaModelId(id) {
  const s = String(id || '');
  if (s.length > 200 || !OLLAMA_MODEL_RE.test(s)) return false;
  return !s.split(/[\/:]/).some(seg => seg === '.' || seg === '..');
}
// Providers whose CLI takes no effort (agy/ollama): the server ignores effort, but still only stores
// a known value (or none) so the registry/UI never persist arbitrary strings.
const LEGACY_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
// The ONE model/effort check used by validate(), the dispatch profile and the nondev profile.
function validateModelEffort(provider, model, effort) {
  if (!PROVIDERS.has(provider)) return 'invalid provider';
  const reg = modelsReg();
  if (provider === 'ollama') {
    if (!isOllamaModelId(model) || !reg.isAllowedModel('ollama', model)) return 'invalid model';
  } else if (!isSafeId(model) || !reg.isAllowedModel(provider, model)) return 'invalid model';
  const efforts = reg.effortsFor(provider, model) || [];
  if (!efforts.length) {
    if (effort === undefined || effort === null || effort === '') return null;
    return LEGACY_EFFORTS.has(effort) ? null : 'invalid effort';
  }
  if (!isSafeId(effort) || !efforts.includes(effort)) return 'invalid effort';
  return null;
}
const SPECIAL_KEYS = { enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', tab: 'Tab' };
const CHAR_KEYS = /^[yn1-9]$/;
// Full keyboard passthrough (the chat panel forwards real keydowns): an optional stack of
// C-/M-/S- modifiers followed by a named key OR a single printable char (0x21-0x7E). Everything
// goes to tmux via execFileSync argv, so a rejected/odd value is at worst a no-op keystroke —
// never shell injection. Literal typed text goes through the `text` path with `send-keys -l`.
const TERM_KEY_RE = /^(C-|M-|S-){0,3}(Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|IC|DC|F[1-9]|F1[0-2]|[!-~])$/;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const LIVE_SESSIONS_TTL_MS = 1000;
let liveSessionsCache = { at: -Infinity, names: new Set() };

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
function liveSessionNames(now = Date.now()) {
  if (now >= liveSessionsCache.at && now - liveSessionsCache.at < LIVE_SESSIONS_TTL_MS) {
    return liveSessionsCache.names;
  }
  let names = new Set();
  try {
    names = new Set(tmux(['list-sessions', '-F', '#{session_name}'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean));
  } catch (e) {
    // tmux exits non-zero when no server is running; that simply means no live chats.
  }
  // Start the TTL after the subprocess returns; under load the tmux invocation
  // itself can consume a meaningful part of the cache window.
  liveSessionsCache = { at: Date.now(), names };
  return names;
}
function invalidateLiveSessions() {
  liveSessionsCache = { at: -Infinity, names: new Set() };
}

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
    // Edit(...) not Write(...) — a Write(path) rule is never matched by the file permission checks and
    // only emits a startup warning; Edit(path) covers every file-editing tool. See nondev guard below.
    const requiredDeny = ['Bash(git push:*)', 'Bash(gh pr merge:*)', 'Bash(gh api:*)', 'Bash(vercel:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(git diff:*)', 'Edit(**/.claude/**)'];
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
// Strict variant for callers that must distinguish "registry unreadable" from "chat absent"
// (dispatch releases a slot on confirmed absence — a swallowed EACCES/parse error must HOLD).
// A missing file is a confirmed empty registry; anything else propagates.
function loadChatsStrict() {
  let raw;
  try { raw = fs.readFileSync(chatsFile(), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const chats = JSON.parse(raw);
  if (!Array.isArray(chats)) throw new Error('chats.json is not an array');
  return chats.map(c => ({ ...c, provider: c.provider || 'claude' }));
}
function saveChats(chats) {
  fs.writeFileSync(chatsFile() + '.tmp', JSON.stringify(chats, null, 2));
  fs.renameSync(chatsFile() + '.tmp', chatsFile());
}
function persistTranscriptPath(name, transcriptPath) {
  if (!NAME_RE.test(name) || !transcriptPath) return false;
  const value = String(transcriptPath);
  // Jail-side sanity check (defense-in-depth): only persist pointers that live under the
  // transcript jail, so a garbage session record can never widen the registry.
  const jail = (process.env.CK_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')) + path.sep;
  if (!path.resolve(value).startsWith(jail)) return false;
  const chats = loadChats();
  const chat = chats.find(c => c.name === name && !c.closed);
  if (!chat || chat.transcriptPath === value) return false;
  chat.transcriptPath = value;
  saveChats(chats);
  return true;
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
  const modelErr = validateModelEffort(provider, model, effort);
  if (modelErr) return modelErr;
  let real;
  try { real = fs.realpathSync(cwd); } catch (e) { return 'cwd does not exist'; }
  if (!fs.statSync(real).isDirectory()) return 'cwd is not a directory';
  const home = os.homedir();
  if (real !== home && !(real + path.sep).startsWith(home + path.sep)) return 'cwd must be under home';
  return null;
}
function isAlive(name) {
  const registered = loadChats().find(c => c.name === name);
  // A mediated chat is owned by the cockpit process rather than a tmux pane. Its
  // durable registry record is therefore its liveness record.
  if (registered && registered.mediated) return true;
  return liveSessionNames().has(name);
}
function listChats() {
  const registered = loadChats();
  // Mediated chats never touch tmux. For all other chats, derive liveness from one
  // cached list-sessions snapshot instead of spawning one tmux process per chat.
  const names = registered.some(c => !c.mediated) ? liveSessionNames() : null;
  return registered.map(c => ({ ...c, alive: c.mediated ? true : names.has(c.name) }));
}
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
function killChat(name, opts) {
  if (!NAME_RE.test(name)) throw new Error('bad name');
  const chat = loadChats().find(c => c.name === name);
  if (!chat || !chat.mediated) {
    // A settle loop still waiting to type this chat's first prompt must stop now, or it could submit
    // the prompt into a pane the operator just closed (if kill-session failed and the pane lingers).
    try { const cancel = settleLoops.get(name); if (cancel) cancel(); } catch (e) {}
    // tmux kill-session only SIGHUPs the pane process, and Claude Code ignores SIGHUP — live
    // 2026-09-07 six "killed" chats had left six `claude` processes running for 4–7 days (~1.2 GB).
    // Read the pane pid BEFORE kill-session (the session is gone afterwards) and terminate it
    // ourselves. tmux starts each pane as a session/process-group leader, so signalling the group
    // (-pid) also reaches the MCP servers and subagents claude spawned; the bare pid is the fallback.
    // Signal immediately after kill-session, before the pid could be reused.
    const panePids = [];
    try {
      for (const line of String(tmux(['list-panes', '-t', '=' + name, '-F', '#{pane_pid}'])).split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 1) panePids.push(pid);
      }
    } catch (e) {}
    try { tmux(['kill-session', '-t', '=' + name]); } catch (e) {}
    for (const pid of panePids) {
      try { process.kill(-pid, 'SIGTERM'); } catch (e) {}
      try { process.kill(pid, 'SIGTERM'); } catch (e) {}
    }
    invalidateLiveSessions();
  }
  if (chat && chat.mediated) {
    // Abort any in-flight generation and delete the transcript — a reused slug must
    // start empty, never resurrect (or replay to the model) a dead conversation.
    try { require('./providers/ollama-chat').discard(name); } catch (e) {}
  }
  // Clean up a non-dev chat's per-session workspace + generated profile so nothing persists across
  // sessions. Guard the recursive remove to a cockpit-owned `ws-*` dir under nondevRoot() — never a
  // user cwd or an arbitrary path.
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
  // Archive instead of erase: the record (title/provider/closed-at/transcript pointer) powers the
  // Closed-chats history. opts.transcriptPath is captured by the SERVER from the linked session at
  // kill time (this module has no session knowledge). Keep the 50 most recent closed records.
  const remaining = loadChats();
  const idx = remaining.findIndex(c => c.name === name);
  if (idx >= 0) {
    remaining[idx].closed = Date.now();
    if (opts && opts.transcriptPath) remaining[idx].transcriptPath = String(opts.transcriptPath);
    delete remaining[idx].nondevProfileFile;
  }
  const open = remaining.filter(c => !c.closed);
  const closed = remaining.filter(c => c.closed).sort((a, b) => b.closed - a.closed).slice(0, 50);
  saveChats([...open, ...closed]);
}
function createChat(opts, cb) {
  const provider = opts.provider || 'claude';
  if (!PROVIDERS.has(provider)) return cb(new Error('invalid provider'));
  const title = opts.title && String(opts.title).trim()
    ? opts.title
    : (deriveTitle(opts.prompt || '') || 'chat');
  const model = opts.model || modelsReg().defaultModel(provider);
  const effort = opts.effort || modelsReg().defaultEffort(provider, model) || 'medium';
  let profile;
  if (opts.profile === undefined || opts.profile === 'dev') profile = 'dev';
  else if (opts.profile === 'nondev') profile = 'nondev';
  else if (opts.profile === 'dispatch') profile = 'dispatch';
  else return cb(new Error('unknown permission profile'));
  // The existing safe/dispatch profiles are Claude Code --settings files. They cannot honestly be
  // advertised as Codex security profiles, so phase-one Codex launches are dev-profile only.
  if (provider !== 'claude' && profile !== 'dev') return cb(new Error(provider + ' supports only the dev permission profile'));
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
    // The Read entries guard the read floor. Safe mode bare-allows Read/Grep/Glob, and per the Claude
    // Code docs only Edit(path)/Read(path) rules are matched by the file permission checks — Read rules
    // are then applied best-effort to Grep/Glob. So Read(...) is the ONLY form that protects anything;
    // a Grep(...)/Glob(...) rule is never matched and merely emits a startup warning. Require the
    // filesystem-anchored forms specifically: a relative rule like Read(**/id_rsa*) matches only at or
    // under the throwaway workspace and would leave the real home wide open.
    const REQUIRED_DENY = ['Bash(cat:*)', 'Bash(curl:*)', 'Bash(rm:*)', 'Bash(git diff:*)', 'Bash(git push:*)', 'Bash(sudo:*)', 'Bash(python3:*)', 'Bash(env:*)', 'Edit(**/.claude/**)', 'Read(**/id_rsa*)',
      'Read(//**/id_rsa*)', 'Read(//**/*.pem)', 'Read(//**/.ssh/**)', 'Read(//**/.env)', 'Read(//**/.claude.json)',
      'Read(~/.zshrc)', 'Read(~/.bashrc)', 'Read(~/.profile)',
      'Edit(//**/.ssh/**)', 'Edit(//**/id_rsa*)', 'Edit(//**/authorized_keys)', 'Edit(~/.zshrc)', 'Edit(~/.bashrc)'];
    // No rule may use a form the file permission checks never match — Write(path), NotebookEdit(path),
    // Glob(path) and Grep(path) are all accepted-but-inert and each makes Claude Code print a startup
    // warning. Edit(path) covers every file-editing tool; Read(path) covers every file-reading tool.
    // A profile carrying inert rules looks protected in review and is not. Verified live 2026-07-26.
    const INERT_RULE = /^(?:Write|NotebookEdit|Glob|Grep)\s*\(/;
    const denySet = new Set(base && base.permissions && Array.isArray(base.permissions.deny) ? base.permissions.deny : []);
    const allowArr = base && base.permissions && Array.isArray(base.permissions.allow) ? base.permissions.allow : [];
    // Also assert the RESOLVED per-machine floors actually landed — a template edit that dropped only
    // the home/cockpit write-denies (keeping size ≥ 120 + the static rules) would otherwise slip through
    // (panel MINOR, defense-in-depth). These are the highest-value portable floors.
    const homeAbs = os.homedir().replace(/^\/+/, '');
    // The mirror floor guards session-hook.js, which every safe-mode session now EXECUTES on six
    // lifecycle events — a template edit dropping only that rule must fail validation (panel MINOR).
    const mirrorAbs = stateDir().replace(/^\/+/, '');
    const RESOLVED_REQUIRED = [`Edit(//${mirrorAbs}/**)`, `Edit(//${homeAbs}/.ssh/**)`, `Edit(//${homeAbs}/.claude/**)`,
      `Edit(//${homeAbs}/.aws/**)`, `Edit(//${homeAbs}/Library/LaunchAgents/**)`, `Edit(//${homeAbs}/.zshrc)`,
      `Read(//${homeAbs}/.claude.json)`, `Read(//${homeAbs}/.claude/**)`,
      `Read(//${homeAbs}/.ssh/**)`, `Read(//${homeAbs}/.aws/**)`, `Read(//${homeAbs}/.gnupg/**)`,
      `Read(//${homeAbs}/.zshrc)`, `Read(//${homeAbs}/.zsh_history)`, `Read(//${homeAbs}/.bash_history)`,
      `Read(//${homeAbs}/Documents/Obsidian Vault/**)`, `Read(//${homeAbs}/Downloads/**)`];
    // A BARE tool name in `allow` is far more permissive than a scoped rule — `Bash` allows every
    // command and makes the whole 225-rule Bash denylist moot, exactly like `Bash(*)`. Reject the bare
    // forms of every dangerous tool, not just the wildcard spelling. `Read`/`Grep`/`Glob` are bare on
    // purpose (safe mode is a write-jail; the deny floors above are what bound them).
    const FORBIDDEN_ALLOW = ['Bash', 'Bash(*)', 'Write', 'Edit', 'NotebookEdit', 'PowerShell', 'PowerShell(*)', 'WebFetch', '*'];
    // Size floor: the template carries 270+ rules, so anything far below that is a gutted profile.
    // Kept well under the real count so ordinary rule edits don't trip it, but high enough to matter.
    if (!base || !base.permissions || base.permissions.defaultMode !== 'default' || denySet.size < 250 ||
        FORBIDDEN_ALLOW.some(t => allowArr.includes(t)) ||
        [...denySet].some(r => INERT_RULE.test(r)) || allowArr.some(r => INERT_RULE.test(r)) ||
        !REQUIRED_DENY.every(r => denySet.has(r)) || !RESOLVED_REQUIRED.every(r => denySet.has(r)) ||
        /__(?:HOME|MIRROR|COCKPIT)__/.test(JSON.stringify(base))) {
      return cb(new Error('non-dev profile template failed security validation at ' + tmpl));
    }
    try { fs.mkdirSync(nondevRoot(), { recursive: true }); } catch (e) {}
    cwd = fs.mkdtempSync(path.join(nondevRoot(), 'ws-'));
    // Edit(path) ALONE — it covers every built-in file-editing tool (Write, NotebookEdit included).
    // A Write(path) or NotebookEdit(path) rule is accepted but never matched by the file permission
    // checks and makes Claude Code print a startup warning for each one. Verified live 2026-07-26.
    base.permissions.allow.push('Edit(//' + cwd.replace(/^\/+/, '') + '/**)');
    // The cockpit's session hooks live in the USER settings layer, which --setting-sources project
    // drops — without re-injecting them here a safe-mode chat never registers a session, so /chat
    // and /m can never show its state or pending-question card (the very audience they exist for).
    // Hooks inside this --settings file DO fire under --setting-sources project (proven 2026-08-18
    // with a SessionStart marker probe). start.js (server keepalive) is deliberately omitted — a
    // chat must not be able to respawn the server. Keep the event list in sync with
    // hooks.template.json (drift-guard in test/chats-nondev.test.js).
    // shq (single-quote shell escaping), NOT JSON.stringify: hook commands run through sh, and inside
    // double quotes a path containing $ or backticks would still expand (panel MINOR).
    const hookRelay = { type: 'command', command: 'node ' + shq(path.join(__dirname, 'session-hook.js')), timeout: 5 };
    base.hooks = {
      SessionStart: [{ hooks: [hookRelay] }],
      UserPromptSubmit: [{ hooks: [hookRelay] }],
      PostToolUse: [{ matcher: '*', hooks: [hookRelay] }],
      // Notification is what flips a session to needs_you when a permission dialog appears — the
      // pending-question card cannot exist without it (permission dialogs fire no other hook).
      Notification: [{ hooks: [hookRelay] }],
      SubagentStart: [{ hooks: [hookRelay] }],
      SubagentStop: [{ hooks: [hookRelay] }],
      Stop: [{ hooks: [hookRelay] }],
      SessionEnd: [{ hooks: [hookRelay] }],
    };
    const profDir = path.join(nondevRoot(), 'profiles');
    // Profiles now carry hooks, which makes every file in this dir a code-execution vector for the
    // NEXT chat that loads it — deny the whole dir with RESOLVED floors so one chat can never edit
    // (or read) a sibling's profile, even when CK_NONDEV_ROOT moves it off the template's default
    // path (panel MAJOR). safePath fails closed on glob-metacharacter roots, like the ws path below.
    try {
      const profAbs = nondevSafePath(profDir, 'profiles-dir');
      base.permissions.deny.push('Edit(//' + profAbs + '/**)', 'Read(//' + profAbs + '/**)');
    } catch (e) { return cb(e); }
    try { fs.mkdirSync(profDir, { recursive: true }); } catch (e) {}
    nondevProfileFile = path.join(profDir, path.basename(cwd) + '.json');
    fs.writeFileSync(nondevProfileFile, JSON.stringify(base), { mode: 0o600 });
    permFlags = ' --setting-sources project --settings ' + shq(nondevProfileFile);
  }
  if (profile === 'dispatch') {
    if (!opts.cwd || !opts.branch) return cb(new Error('dispatch requires a git repo cwd and branch'));
    const dispatchValidation = validateModelEffort(provider, model, effort);
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
    ? validateModelEffort(provider, model, effort)
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
  // Ollama chats are mediated through its HTTP API. Persist the record before
  // starting an initial prompt so history/context correlation can resolve the
  // chat's model immediately; generation continues after this callback returns.
  if (provider === 'ollama') {
    const chat = {
      name,
      title: String(title || name).slice(0, 80),
      cwd,
      model,
      effort,
      provider,
      mediated: true,
      ultracode: !!opts.ultracode,
      profile,
      createdAt: Date.now(),
    };
    saveChats([...loadChats(), chat]);
    const firstPrompt = opts.ultracode ? ('ultracode\n\n' + (opts.prompt || '')).trim() : opts.prompt;
    if (firstPrompt) {
      try {
        require('./providers/ollama-chat').send(
          name,
          model,
          firstPrompt
        );
      } catch (e) {
        // The chat record is a valid empty mediated chat either way; a first-prompt
        // failure must not make creation report failure while the card appears anyway.
      }
    }
    return cb(null, chat);
  }
  // model/effort passed the registry allowlist above; the tmux command is a shell string, so re-assert
  // the hard safety regex right here AND shq() every value (defense in depth).
  if (!isSafeId(model)) return cb(new Error('invalid model'));
  if (provider !== 'agy' && !isSafeId(effort)) return cb(new Error('invalid effort'));
  let providerCommand;
  if (provider === 'codex') providerCommand = 'codex --model ' + shq(model) + ' --config model_reasoning_effort=' + shq(effort) + ' --add-dir ' + shq(requestedCwd);
  // agy: full model ids already encode the effort (and --effort conflicts), so never pass --effort.
  // 'antigravity' is the synthetic "agy's own default" entry → bare `agy`.
  else if (provider === 'agy') providerCommand = model === 'antigravity' ? 'agy' : 'agy --model ' + shq(model);
  else providerCommand = 'claude' + permFlags + ' --model ' + shq(model) + ' --effort ' + shq(effort);
  const command = process.env.CK_TEST_CMD || providerCommand;
  // -e CK_CHAT=<name>: the session-hook reads this env var and stamps `chatName` onto the monitored
  //   session file, binding this controlled chat to its Claude session by EXACT identity. That kills
  //   the old cwd+time-guess correlation that produced duplicate (non-clickable) cards when the
  //   session's reported cwd differed from the chat's launch cwd.
  // -y 200: a taller VIRTUAL pane (it's detached, so height is not tied to any real terminal) so the
  //   full-screen Claude TUI renders far more rows — much more of the live conversation is visible /
  //   scrollable at once. capture-pane reads this virtual frame.
  try {
    tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '200', '-e', 'CK_CHAT=' + name, command]);
    invalidateLiveSessions();
  }
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
  // A promptless chat still needs the startup dialogs settled — otherwise it sits on the trust
  // screen forever (SessionStart never fires, so the cockpit shows nothing). Respond to the caller
  // immediately and keep settling in the background; a prompted chat keeps the historical contract
  // of calling back after prompt delivery.
  if (!firstPrompt) cb(null, chat);
  // wait for the claude TUI input prompt, then type the first message.
  // The trust-dialog first-run screen also renders a "❯"/">" marker, so we can't
  // key off that alone — answer each startup dialog (startupDialogAction) and keep polling for the
  // real REPL footer, which no dialog renders. The footer wording varies by build
  // ("? for shortcuts" or "for agents"), so match either.
  let tries = 0, capFails = 0, importsAnswered = false, finished = false, lastEnterFrame = null, lastTrustDownTick = -Infinity, lastTrustEnterTick = -Infinity;
  // Snapshot the tmux binary at launch: the settle loop can outlive the createChat call (a
  // promptless chat settles in the background), and resolving tmuxBin() per tick would let a loop
  // act through a binary that changed after launch — in the test suite that literally meant one
  // test's leftover timer consuming the next test's stateful tmux stub.
  const binAtLaunch = tmuxBin();
  const tmuxAtLaunch = (args) => execFileSync(binAtLaunch, args, { encoding: 'utf8' });
  // The caller is answered exactly once: on delivery, or — for a slow launch — at the soft window
  // with `promptPending` so the HTTP request doesn't hang while the loop keeps settling.
  let cbCalled = !firstPrompt;
  const answer = (extra) => {
    if (cbCalled) return;
    cbCalled = true;
    cb(null, extra ? { ...chat, ...extra } : chat);
  };
  // The prompt itself is persisted on the record until it is confirmed typed (`pendingPrompt`), so a
  // dashboard restart mid-settle cannot lose the text, /wrap can refuse a chat still waiting for it,
  // and the operator can read it back to send by hand. (Review panel MAJOR #4/#5.)
  const updateRecord = (mutate) => {
    try {
      const chats = loadChats();
      const rec = chats.find(c => c.name === name);
      if (rec) { mutate(rec); saveChats(chats); }
    } catch (e) {}
  };
  if (firstPrompt) updateRecord(rec => { rec.pendingPrompt = firstPrompt; });
  const markUndelivered = (why) => {
    updateRecord(rec => { rec.promptUndelivered = true; });
    try { fs.appendFileSync(path.join(stateDir(), 'error.log'), new Date().toISOString() + ' promptUndelivered ' + name + ' (' + why + ')\n'); } catch (e) {}
  };
  // deliver: true = footer seen, type it now; false = hard cap / pane gone, never type; 'cancel' =
  // the chat was killed while settling — stop silently, record nothing (Review panel MINOR #6).
  const finish = (deliver) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    settleLoops.delete(name);
    if (!firstPrompt) return;
    if (deliver === 'cancel') return answer();
    if (deliver) {
      let sent = false;
      try { sendInput(name, firstPrompt); sent = true; } catch (e) {}
      if (sent) updateRecord(rec => { delete rec.pendingPrompt; delete rec.promptUndelivered; });
      // A pane that vanished between the capture and the send must not report success silently.
      else markUndelivered('send-keys failed after the REPL footer appeared');
    }
    else markUndelivered('REPL footer never appeared within ' + Math.round(SETTLE_HARD_MAX_TICKS / 2) + 's');
    answer();
  };
  settleLoops.set(name, () => finish('cancel'));
  const timer = setInterval(() => {
    tries++;
    let text = null;
    // capture the whole frame (= the pane height, 200 rows): the trust dialog renders mid-screen, so a
    // bottom-50 slice would miss it and the first-prompt auto-send would stall. Capping at the pane
    // height (not more) avoids pulling any stale startup scrollback into the readiness match.
    try { text = tmuxAtLaunch(['capture-pane', '-p', '-e', '-t', '=' + name + ':0', '-S', '-200']); capFails = 0; } catch (e) { capFails++; }
    // pane gone (killed chat, dead tmux) — nothing left to settle; don't grind out the full 30s
    if (capFails >= 6) return finish(false);
    text = text || '';
    // Ollama and Antigravity do not expose Claude's REPL footer. Their process has had a full
    // polling interval to start by the second pass, so deliver the first prompt without a 30s stall.
    // Codex is excluded: its TUI loads config/MCP for several seconds and keeps the footer-or-timeout wait.
    // Ready is checked BEFORE the dialog action: a dialog phrase lingering in the frame alongside the
    // real footer must not fire a stray keystroke into the live REPL (panel MINOR).
    const ready = /\? for shortcuts|for agents/.test(text) || (provider === 'agy' && tries >= 2);
    if (ready) return finish(true);
    // Never type the prompt blind. Live 2026-09-06: Claude auto-updated itself on launch and reached
    // the REPL 90.3s after new-session — the old `tries >= SETTLE_MAX_TICKS → finish(true)` typed the
    // prompt into a still-booting TUI, which discarded it, leaving the chat idle and promptless.
    // Past the soft window, release the caller (promptPending) and keep waiting for the footer.
    if (tries >= SETTLE_HARD_MAX_TICKS) return finish(false);
    if (tries >= SETTLE_MAX_TICKS) answer({ promptPending: true });
    const action = startupDialogAction(text, profile);
    // Enter fires at most once per DISTINCT frame: a dialog lingering across ticks must not queue a
    // second Enter that would land on the NEXT dialog — permission dialogs can default their cursor
    // to "Yes, allow all edits… (shift+tab)", so a stray Enter is a silent-mode-escalation risk.
    if (action === 'enter') {
      if (text !== lastEnterFrame) {
        lastEnterFrame = text;
        try { tmuxAtLaunch(['send-keys', '-t', '=' + name + ':0', 'Enter']); } catch (e) {}
      }
    }
    else if (action === 'trust-down') {
      // Claude 2.1.259 parks the trust dialog's cursor on "No, exit", so a bare Enter now KILLS the
      // chat (verified live 2026-09-04). Step the cursor onto "Yes, I trust this folder" and let the
      // NEXT tick send Enter once the frame shows the cursor there: Down+Enter written back-to-back
      // arrive in one stdin read and the TUI swallows the Enter (probe 2, 2026-09-04). Re-send every
      // TRUST_RESEND_TICKS while the frame still shows "No" — a Down that lands before the dialog is
      // interactive is dropped, and the once-per-frame guard used for 'enter' would then park the
      // chat forever. Down on the last row does not wrap (verified), so re-sending is idempotent.
      if (tries - lastTrustDownTick >= TRUST_RESEND_TICKS) {
        lastTrustDownTick = tries;
        try { tmuxAtLaunch(['send-keys', '-t', '=' + name + ':0', 'Down']); } catch (e) {}
      }
    }
    else if (action === 'trust-enter') {
      // Trust dialog with the cursor on the accept row (either layout): Enter accepts. Rate-limited
      // re-send rather than once-per-frame, because a swallowed Enter leaves the frame unchanged;
      // ready is checked first every tick so nothing reaches the live REPL.
      if (tries - lastTrustEnterTick >= TRUST_RESEND_TICKS) {
        lastTrustEnterTick = tries;
        try { tmuxAtLaunch(['send-keys', '-t', '=' + name + ':0', 'Enter']); } catch (e) {}
      }
    }
    else if (action === 'key-2' && !importsAnswered) {
      // once per lifetime: a slow TUI redraw showing the already-answered dialog must not type a
      // second literal '2' that would land in the next dialog or the REPL input
      importsAnswered = true;
      try { tmuxAtLaunch(['send-keys', '-t', '=' + name + ':0', '-l', '2']); } catch (e) {}
    }
  }, 500);
  // unref: the settle loop must never keep a process alive on its own (test runners, one-shot CLIs)
  timer.unref();
}

// Settle-loop tuning. SETTLE_MAX_TICKS × 500ms is the SOFT window: how long createChat holds the
// caller waiting for the REPL footer before answering with `promptPending` (90s: the 2026-09-04
// probes drew the trust dialog at ~28s and the footer at ~59s). SETTLE_HARD_MAX_TICKS × 500ms is
// the HARD cap (10 min) after which the loop stops without ever typing the prompt — a prompt typed
// before the REPL is ready is discarded (2026-09-04 dialog case, 2026-09-06 auto-update case).
// TRUST_RESEND_TICKS × 500ms is the interval at which each trust keystroke is re-sent.
// Both caps take an env override so the timeout paths are testable in seconds, not minutes.
// Overrides must be whole positive integers (bounded): "-5", "3abc" or "1e9" fall back to the default
// rather than collapsing the caps to the first poll (Review panel MINOR #9).
function tickOverride(envName, fallback) {
  const raw = process.env[envName];
  if (raw == null || !/^\d{1,6}$/.test(String(raw).trim())) return fallback;
  const n = Number(raw);
  return n >= 1 ? n : fallback;
}
const SETTLE_MAX_TICKS = tickOverride('CK_SETTLE_MAX_TICKS', 180);
const SETTLE_HARD_MAX_TICKS = Math.max(SETTLE_MAX_TICKS + 1, tickOverride('CK_SETTLE_HARD_MAX_TICKS', 1200));
// name → cancel function of the settle loop still waiting to type that chat's first prompt.
const settleLoops = new Map();
const TRUST_RESEND_TICKS = 6;
// Cursor marker ("❯" or ">") at the start of a row, optionally numbered, on the decline option.
// Frames come from capture-pane -e, so callers strip ANSI first.
const TRUST_CURSOR_ON_NO = /^\s*[❯>]\s*(?:\d+\.\s*)?No\b/im;
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''); }

// Pure decision for the startup-dialog settle loop, extracted so real captured dialog frames can be
// regression-tested (the trust wording has now changed three times; an inline regex was untestable).
// Returns 'enter' (accept the dialog's default), 'trust-down' (trust dialog with the cursor parked
// on "No, exit" — step down to Yes), 'trust-enter' (trust dialog with the cursor on the accept row —
// Enter accepts), 'key-2' (pick option 2), or null (no dialog visible).
// The external-imports dialog (new in Claude ~2.1.3x) is checked FIRST and answered per profile:
// only DEV chats accept the default (Yes) — nondev AND dispatch decline (option 2), because an
// out-of-workspace CLAUDE.md import is exactly the vector those hardened profiles exist to avoid
// (panel MAJOR: the first cut gave dispatch the dev answer).
function startupDialogAction(text, profile) {
  if (!text) return null;
  if (/allow external imports|disable external imports/i.test(text)) {
    return profile === 'dev' ? 'enter' : 'key-2';
  }
  if (/trust the files|Yes, proceed|Do you trust|trust this folder|Is this a project you|I trust this folder|Quick safety check/i.test(text)) {
    // Claude 2.1.259 re-ordered the options ("❯ No, exit" above "Yes, I trust this folder") and
    // defaults the cursor to No. Enter there exits the CLI. Step down first ('trust-down'); once the
    // cursor row is the accept option, Enter accepts ('trust-enter', rate-limited re-send).
    if (TRUST_CURSOR_ON_NO.test(stripAnsi(text))) return 'trust-down';
    return 'trust-enter';
  }
  return null;
}
// The operator typed into the chat by hand (the recovery the "Prompt not delivered" badge asks for):
// the chat is prompted now, so clear the undelivered/pending markers and let /wrap work again.
// Returns true when a marker was cleared. (Review panel MAJOR #2.)
function clearPromptState(name) {
  if (!NAME_RE.test(name)) return false;
  // Manual recovery supersedes automatic delivery: a settle loop still waiting must not type the
  // original prompt a second time once the footer appears, nor re-mark the chat undelivered later.
  try { const cancel = settleLoops.get(name); if (cancel) cancel(); } catch (e) {}
  const chats = loadChats();
  const rec = chats.find(c => c.name === name);
  if (!rec || (!rec.pendingPrompt && !rec.promptUndelivered)) return false;
  delete rec.pendingPrompt;
  delete rec.promptUndelivered;
  saveChats(chats);
  return true;
}

// Startup reconciliation: a settle loop lives only in memory, so a dashboard restart mid-settle
// orphans any record still carrying `pendingPrompt`. Nothing will ever type it now — mark it
// undelivered (text retained for manual recovery) so the badge, /wrap and dispatch all see the
// truth instead of a slot/refusal that never resolves. Returns the names reconciled.
function reconcilePendingPrompts() {
  const chats = loadChats();
  const hit = [];
  for (const rec of chats) {
    if (!rec || rec.closed || !rec.pendingPrompt || rec.promptUndelivered || settleLoops.has(rec.name)) continue;
    rec.promptUndelivered = true;
    hit.push(rec.name);
  }
  if (hit.length) {
    saveChats(chats);
    try { fs.appendFileSync(path.join(stateDir(), 'error.log'), new Date().toISOString() + ' promptUndelivered ' + hit.join(',') + ' (delivery interrupted by a cockpit restart)\n'); } catch (e) {}
  }
  return hit;
}

module.exports = { createChat, listChats, loadChatsStrict, persistTranscriptPath, clearPromptState, reconcilePendingPrompts, startupDialogAction, isAlive, screen, cursor, sendInput, sendKey, sendTermKey, killChat, slugify, deriveTitle, sanitizeUploadFilename, saveUpload, validate, validateModelEffort, isSafeId, isOllamaModelId, buildDispatchProfile, NAME_RE, MAX_UPLOAD_BYTES };
