'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const transcript = require('./transcript.js');

const STOP = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'task', 'work']);
const SEMANTIC_CACHE_MS = 10 * 60 * 1000;
const gitCache = new Map();

function tokens(title) {
  return [...new Set(String(title || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
    .filter(token => token.length > 1 && !STOP.has(token));
}

function titleOverlap(a, b) {
  const aa = tokens(a), bb = tokens(b);
  if (aa.length < 2 || bb.length < 2) return 0;
  const bs = new Set(bb), intersection = aa.filter(x => bs.has(x)).length;
  return intersection / new Set([...aa, ...bb]).size;
}

function pairKey(a, b) { return [String(a), String(b)].sort().join('\0'); }

// A session whose Claude process is a descendant of another session's process is that session's
// subagent (headless `claude -p`, dispatch worker, cockpit-created chat) — the parent delegating a
// task to it is coordination, not a duplicate. Walk ppid chains once per refresh.
function ancestorPids(pid, readPpid) {
  const chain = new Set();
  let current = Number(pid);
  for (let depth = 0; depth < 15 && Number.isInteger(current) && current > 1; depth++) {
    let parent;
    try { parent = Number(readPpid(current)); } catch (e) { break; }
    if (!Number.isInteger(parent) || parent <= 1 || chain.has(parent)) break;
    chain.add(parent);
    current = parent;
  }
  return chain;
}

function defaultReadPpid(pid) {
  return parseInt(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim(), 10);
}

function processRelated(a, b, readPpid) {
  const pa = Number(a && a.pid), pb = Number(b && b.pid);
  if (!Number.isInteger(pa) || !Number.isInteger(pb) || pa <= 1 || pb <= 1 || pa === pb) return false;
  return ancestorPids(pa, readPpid).has(pb) || ancestorPids(pb, readPpid).has(pa);
}

function structuralPairs(sessions, options) {
  const readPpid = (options && options.readPpid) || defaultReadPpid;
  const live = (Array.isArray(sessions) ? sessions : [])
    .filter(s => s && s.sessionId && (s.live === true || ['running', 'needs_you'].includes(s.state)))
    .sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
  const pairs = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j], signals = [];
    if (a.repoKey && b.repoKey && a.branch && b.branch && a.repoKey === b.repoKey && a.branch === b.branch) signals.push('repo_branch');
    const af = new Set(a.touchedFiles || []);
    if ((b.touchedFiles || []).some(file => af.has(file))) signals.push('file_overlap');
    if (titleOverlap(a.purposeTitle, b.purposeTitle) >= 0.6) signals.push('title_overlap');
    if (signals.length && processRelated(a, b, readPpid)) continue;
    if (signals.length) pairs.push({ pairKey: pairKey(a.sessionId, b.sessionId), a, b, signals });
  }
  return pairs;
}

function parseConfirmation(value) {
  const match = /^\s*(yes|no)\b[\s|:—,-]*(.*)$/i.exec(String(value || '').trim());
  return match ? { same: match[1].toLowerCase() === 'yes', reason: match[2].trim().slice(0, 180) } : null;
}

function localConfirm(pair, options) {
  const bin = options && options.bin || process.env.CK_LOCAL_LLM_BIN || 'local-llm';
  const timeoutMs = options && options.timeoutMs || 15000;
  const system = 'Decide whether two active coding sessions are solving the same task. Reply exactly YES | one-line reason or NO | one-line reason.';
  const prompt = `Session A: ${pair.a.purposeTitle || pair.a.lastPrompt || 'unknown'}\nSession B: ${pair.b.purposeTitle || pair.b.lastPrompt || 'unknown'}\nStructural signals: ${pair.signals.join(', ')}`;
  return new Promise((resolve, reject) => {
    let output = '', done = false;
    const child = spawn(bin, ['--system', system], { stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(new Error('local-llm timeout')); }, timeoutMs);
    child.on('error', finish);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2048) { try { child.kill('SIGKILL'); } catch (e) {} finish(new Error('local-llm output too large')); } });
    child.on('close', code => code === 0 ? finish(null, output) : finish(new Error('local-llm unavailable')));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function compactSession(session) {
  return {
    sessionId: session.sessionId,
    chatName: session.chatName || '',
    purposeTitle: session.purposeTitle || session.lastPrompt || session.client || 'Untitled session',
  };
}

class DuplicateDetector {
  constructor(options) {
    options = options || {};
    this.stateDir = options.stateDir || process.env.COCKPIT_DIR || __dirname;
    this.file = path.join(this.stateDir, 'duplicate-dismissals.json');
    this.confirm = options.confirm || ((pair) => localConfirm(pair, options));
    this.maxSemanticPairs = Number.isInteger(options.maxSemanticPairs) ? options.maxSemanticPairs : 8;
    this.semantic = new Map();
    this.currentCandidates = new Set();
    this.pairs = [];
    try { this.dismissed = new Set(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { this.dismissed = new Set(); }
  }

  async refresh(sessions, now = Date.now()) {
    const candidates = structuralPairs(sessions);
    this.currentCandidates = new Set(candidates.map(pair => pair.pairKey));
    const active = candidates.filter(pair => !this.dismissed.has(pair.pairKey));
    const evaluate = async (pair, mayConfirm) => {
      const evidence = JSON.stringify([pair.signals, pair.a.purposeTitle, pair.b.purposeTitle, pair.a.touchedFiles, pair.b.touchedFiles]);
      let result = this.semantic.get(pair.pairKey);
      if (!result || result.evidence !== evidence || now - result.checkedAt >= SEMANTIC_CACHE_MS) {
        if (mayConfirm) {
          try {
            const parsed = parseConfirmation(await this.confirm(pair));
            result = parsed ? { ...parsed, evidence, checkedAt: now } : { same: null, reason: '', evidence, checkedAt: now };
          } catch (e) { result = { same: null, reason: '', evidence, checkedAt: now }; }
        } else result = { same: null, reason: '', evidence, checkedAt: now };
        this.semantic.set(pair.pairKey, result);
      }
      if (result.same === false) return null;
      return {
        pairKey: pair.pairKey, a: compactSession(pair.a), b: compactSession(pair.b), signals: pair.signals,
        status: result.same === true ? 'confirmed' : 'unconfirmed', reason: result.reason || '',
      };
    };
    // A large same-branch fleet creates O(n²) pairs. Bound local processes per
    // cycle; excess structural matches remain visible and explicitly unconfirmed.
    const results = await Promise.all(active.map((pair, i) => evaluate(pair, i < this.maxSemanticPairs)));
    this.pairs = results.filter(Boolean);
    return this.pairs;
  }

  dismiss(key) {
    key = String(key || '');
    if (!this.currentCandidates.has(key)) return false;
    this.dismissed.add(key);
    this.pairs = this.pairs.filter(pair => pair.pairKey !== key);
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify([...this.dismissed], null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {}
    return true;
  }
}

function gitMetadata(cwd) {
  if (!cwd) return {};
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  try {
    const lines = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 750, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    const [common, repoRoot, branch] = lines;
    const repoKey = fs.realpathSync(path.resolve(cwd, common));
    const value = repoKey && branch && branch !== 'HEAD' ? { repoKey, repoRoot, branch } : {};
    gitCache.set(cwd, { at: Date.now(), value });
    return value;
  } catch (e) { gitCache.set(cwd, { at: Date.now(), value: {} }); return {}; }
}

function enrichSession(session, now = Date.now()) {
  const git = gitMetadata(session && session.cwd);
  const touched = Array.isArray(session && session.touchedFiles) ? session.touchedFiles
    : session && session.transcriptPath ? transcript.recentTouchedFiles(session.transcriptPath, session.cwd, { now }) : [];
  return {
    ...session,
    ...git,
    touchedFiles: touched.map(file => git.repoKey && git.repoRoot && (file === git.repoRoot || file.startsWith(git.repoRoot + path.sep))
      ? `${git.repoKey}:${path.relative(git.repoRoot, file)}` : file),
  };
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 200 * 1024;

function oneLine(value, fallback) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

function transcriptTail(text) {
  const buffer = Buffer.from(String(text || ''), 'utf8');
  if (buffer.length <= MAX_TRANSCRIPT_BYTES) return buffer.toString('utf8');
  return '… [transcript truncated to the most recent 200KB] …\n\n' + buffer.subarray(buffer.length - MAX_TRANSCRIPT_BYTES).toString('utf8');
}

function sessionInPairs(sessionId, pairs) {
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    for (const side of [pair && pair.a, pair && pair.b]) {
      if (side && side.sessionId === sessionId) return side;
    }
  }
  return null;
}

function readSessionRecord(stateDir, sessionId) {
  try {
    const file = path.join(stateDir, 'sessions', sessionId + '.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record && record.sessionId === sessionId ? record : null;
  } catch (e) {
    return null;
  }
}

function saveLog({ session, stateDir, transcriptMod, now }) {
  if (!session.transcriptPath) throw new Error('session transcript path is unavailable');
  if (transcriptMod.isAllowed && !transcriptMod.isAllowed(session.transcriptPath)) {
    throw new Error('session transcript is outside the allowed projects directory');
  }
  const recentTranscript = transcriptMod.readTranscript(session.transcriptPath, {
    maxBytes: MAX_TRANSCRIPT_BYTES,
    readCap: 4 * 1024 * 1024,
  });
  const savedAt = now instanceof Date ? now : new Date(now || Date.now());
  const directory = path.join(stateDir, 'killed-sessions');
  const savedPath = path.join(directory, `${session.sessionId}-${savedAt.toISOString().slice(0, 10)}.md`);
  const temporaryPath = savedPath + '.' + process.pid + '.tmp';
  const markdown = [
    '# Saved duplicate session',
    '',
    `- Session ID: ${session.sessionId}`,
    `- Purpose: ${oneLine(session.purposeTitle, 'Untitled session')}`,
    `- Chat: ${oneLine(session.chatName, 'uncontrolled')}`,
    `- Started: ${iso(session.startedAt)}`,
    `- Last activity: ${iso(session.lastActivityAt)}`,
    `- Ended: ${session.endedAt ? iso(session.endedAt) : 'not recorded'}`,
    `- Saved: ${savedAt.toISOString()}`,
    '',
    '## Recent transcript',
    '',
    transcriptTail(recentTranscript) || '_Transcript contained no readable conversation turns._',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryPath, markdown, { mode: 0o600 });
    fs.renameSync(temporaryPath, savedPath);
  } catch (e) {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw e;
  }
  return savedPath;
}

function saveKillSession(options) {
  options = options || {};
  const sessionId = String(options.sessionId || '');
  if (!SESSION_ID_RE.test(sessionId)) return { status: 400, reason: 'invalid sessionId' };

  const pairSide = sessionInPairs(sessionId, options.pairs);
  if (!pairSide) return { status: 409, reason: 'Session is not in the current duplicate pair list.' };

  // The banner's pair snapshot can be up to a minute stale. Re-check against a FRESH structural
  // pairing (synchronous, no LLM confirm) so a session that stopped being a duplicate — e.g. one
  // side wrapped up and moved to new work — can no longer be killed from an outdated banner.
  if (options.freshPairs !== undefined && !sessionInPairs(sessionId, options.freshPairs)) {
    return { status: 409, reason: 'This session no longer looks like a duplicate — the banner was stale. Nothing was killed.' };
  }

  const listed = (Array.isArray(options.sessions) ? options.sessions : []).find(s => s && s.sessionId === sessionId);
  const stored = readSessionRecord(options.stateDir, sessionId);
  const session = { ...pairSide, ...(stored || {}), ...(listed || {}), sessionId };
  let savedPath;
  try {
    savedPath = saveLog({ session, stateDir: options.stateDir, transcriptMod: options.transcriptMod, now: options.now });
  } catch (e) {
    return { status: 500, reason: 'Could not save the session log; nothing was killed: ' + e.message };
  }

  if (session.state === 'ended') {
    return { status: 200, savedPath, killed: false, alreadyEnded: true, handle: 'already-ended' };
  }

  const chatsMod = options.chatsMod;
  const chatName = String(session.chatName || '');
  let controlled;
  try { controlled = chatsMod.listChats().find(chat => chat && chat.name === chatName); }
  catch (e) { controlled = null; }

  // killChat suppresses tmux errors internally, so a thrown error is NOT the only failure mode —
  // re-check liveness after the kill and refuse to report success while the session survives.
  const verifiedKill = handle => {
    chatsMod.killChat(chatName);
    if (typeof chatsMod.isAlive !== 'function') {
      return { status: 500, savedPath, killed: false, reason: 'The log was saved, but the kill could not be verified (no liveness check available).' };
    }
    let stillAlive;
    try { stillAlive = chatsMod.isAlive(chatName); }
    catch (e) { return { status: 500, savedPath, killed: false, reason: 'The log was saved, but the kill could not be verified: ' + e.message }; }
    if (stillAlive) return { status: 500, savedPath, killed: false, reason: 'The log was saved, but the session is still alive after the kill attempt.' };
    return { status: 200, savedPath, killed: true, alreadyEnded: false, handle };
  };

  if (controlled && controlled.alive) {
    try {
      return verifiedKill('controlled-chat');
    } catch (e) {
      return { status: 500, savedPath, reason: 'The log was saved, but the controlled chat could not be killed: ' + e.message };
    }
  }

  const safeTmuxName = chatsMod.NAME_RE && chatsMod.NAME_RE.test(chatName);
  let tmuxAlive = false;
  if (safeTmuxName && typeof chatsMod.isAlive === 'function') {
    try { tmuxAlive = chatsMod.isAlive(chatName); } catch (e) { tmuxAlive = false; }
  }
  if (tmuxAlive) {
    try {
      return verifiedKill('hook-tmux');
    } catch (e) {
      return { status: 500, savedPath, reason: 'The log was saved, but the tmux session could not be killed: ' + e.message };
    }
  }

  // PID fallback for uncontrolled terminal sessions. The hook records its parent (the Claude
  // process) as `pid`; only kill when that PID is alive AND its command line still looks like a
  // Claude CLI process — a recycled PID must never take down an unrelated process.
  const pid = Number(session.pid);
  if (Number.isInteger(pid) && pid > 1) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
    if (alive) {
      let command = '';
      try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch (e) { command = ''; }
      if (!/(^|\/)claude( |$)/.test(command) && !/claude(-code)?\b/.test(command)) {
        return { status: 409, savedPath, killed: false, reason: 'The log was saved, but PID ' + pid + ' no longer looks like a Claude process — refusing to kill it.' };
      }
      try { process.kill(pid, 'SIGTERM'); } catch (e) {
        return { status: 500, savedPath, killed: false, reason: 'The log was saved, but killing PID ' + pid + ' failed: ' + e.message };
      }
      // Bounded synchronous wait (rare operator action on a single-user localhost server;
      // 1.5s max stall is acceptable and keeps saveKillSession's sync contract).
      const deadline = Date.now() + 1500;
      let stillAlive = true;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch (e) { stillAlive = false; break; }
        execFileSync('sleep', ['0.1']);
      }
      if (stillAlive) {
        return { status: 500, savedPath, killed: false, reason: 'The log was saved and SIGTERM was sent, but PID ' + pid + ' is still alive.' };
      }
      return { status: 200, savedPath, killed: true, alreadyEnded: false, handle: 'pid' };
    }
  }

  if ((safeTmuxName && !tmuxAlive) || (controlled && !controlled.alive) || (Number.isInteger(pid) && pid > 1)) {
    return { status: 200, savedPath, killed: false, alreadyEnded: true, handle: 'already-ended' };
  }
  return {
    status: 409,
    savedPath,
    killed: false,
    reason: 'The log was saved, but this session has no safe live PID or tmux handle to terminate.',
  };
}

module.exports = {
  DuplicateDetector, pairKey, titleOverlap, structuralPairs, parseConfirmation, gitMetadata, enrichSession,
  saveKillSession, saveLog, sessionInPairs, SESSION_ID_RE, MAX_TRANSCRIPT_BYTES,
};
