'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const chats = require('./chats.js');
const transcript = require('./transcript.js');

const REFRESH_MS = 10 * 60 * 1000;
const LOCAL_TIMEOUT_MS = 15000;

function cleanPrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function substantive(value) {
  const text = cleanPrompt(value);
  return /[\p{L}\p{N}]{3}/u.test(text) ? text : '';
}

function promptsForSession(session) {
  const prompts = Array.isArray(session && session.prompts) ? session.prompts.map(substantive).filter(Boolean) : [];
  if (session && session.transcriptPath) {
    try {
      for (const turn of transcript.parseTranscript(session.transcriptPath, { maxTurns: 120 })) {
        if (turn.role !== 'you') continue;
        const text = substantive((turn.blocks || []).filter(b => b.type === 'text').map(b => b.text).join(' '));
        if (text) prompts.push(text);
      }
    } catch (e) {}
  }
  const last = substantive(session && session.lastPrompt);
  if (last && !prompts.includes(last)) prompts.push(last);
  return prompts;
}

function signature(prompts, subject) {
  // subject participates so a late-arriving client/cwd mapping regenerates an otherwise-stable title
  return crypto.createHash('sha256').update([String(subject || '')].concat(prompts.slice(-4)).join('\0')).digest('hex').slice(0, 20);
}

function humanizeSubject(value) {
  const known = new Map([
    ['ai', 'AI'], ['api', 'API'], ['crm', 'CRM'], ['os', 'OS'],
    ['seo', 'SEO'], ['ui', 'UI'], ['ux', 'UX'],
  ]);
  return String(value || '').split('-').filter(Boolean).map(segment => {
    const lower = segment.toLowerCase();
    return known.get(lower) || segment.charAt(0).toUpperCase() + segment.slice(1);
  }).join('-');
}

function subjectForSession(session) {
  if (!session) return '';
  const cwdValue = String(session.cwd || '').trim();
  const home = path.resolve(os.homedir());
  const cwd = cwdValue === '~' ? home : (cwdValue ? path.resolve(cwdValue) : '');
  if (cwd && cwd === home) return '';

  // session-hook's resolveClient falls back to basename(cwd) for unmapped repos — that raw
  // folder name (e.g. a worktree branch dir) is not a subject; let the cwd derivation handle it.
  const client = String(session.client || '').trim();
  const cwdBase = cwd ? path.basename(cwd) : '';
  if (client && client !== cwdBase && client.toLowerCase() !== 'falaq (home)' && client.toLowerCase() !== 'unknown') return client;
  if (!cwd || /^(?:unknown|null|undefined)$/i.test(cwdValue)) return '';

  const parts = cwd.split(path.sep).filter(Boolean);
  let repo = parts[parts.length - 1] || '';
  const worktreePart = parts.find(part => /-wt\d*$/i.test(part));
  if (worktreePart) repo = worktreePart;
  repo = repo.replace(/-wt\d*$/i, '');
  return humanizeSubject(repo);
}

function sanitizeTitle(value) {
  const line = String(value || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  return chats.deriveTitle(line.replace(/^(?:purpose|title)\s*:\s*/i, '').replace(/^['"`]+|['"`]+$/g, ''));
}

function heuristicTitle(prompts) {
  if (!prompts.length) return '';
  return chats.deriveTitle(prompts[0]);
}

function localSummary(prompts, options) {
  const bin = options && options.bin || process.env.CK_LOCAL_LLM_BIN || 'local-llm';
  const timeoutMs = options && options.timeoutMs || LOCAL_TIMEOUT_MS;
  const system = !options || options.inferSubject !== false
    ? 'Write only a 3-8 word title in the format Subject — task, where Subject is the client, project, or repository this work concerns, inferred from the prompts. Use an em dash separator. No quotes or labels.'
    : 'Write only a short 3-6 word purpose title naming the main issue this coding session is solving. Use an action verb. No quotes, label, or punctuation.';
  const context = `First user request:\n${prompts[0]}\n\nMost recent requests:\n${prompts.slice(-4).join('\n---\n')}`;
  return new Promise((resolve, reject) => {
    let settled = false, stdout = '';
    const child = spawn(bin, ['--system', system], { stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(new Error('local-llm timeout')); }, timeoutMs);
    child.on('error', finish);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2048) { try { child.kill('SIGKILL'); } catch (e) {} finish(new Error('local-llm output too large')); }
    });
    child.on('close', code => code === 0 ? finish(null, stdout) : finish(new Error('local-llm unavailable')));
    child.stdin.on('error', () => {});
    child.stdin.end(context);
  });
}

class PurposeTitles {
  constructor(options) {
    options = options || {};
    this.stateDir = options.stateDir || process.env.COCKPIT_DIR || __dirname;
    this.file = path.join(this.stateDir, 'purpose-titles.json');
    this.summarize = options.summarize || ((prompts, session) => localSummary(prompts, { ...options, inferSubject: !subjectForSession(session) }));
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (e) { this.cache = {}; }
  }

  get(sessionId) {
    const value = this.cache[String(sessionId || '')];
    return value && value.title ? { title: value.title, source: value.source } : null;
  }

  async refresh(sessions, now = Date.now()) {
    let changed = false;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !session.sessionId || ['ended', 'dead'].includes(session.state)) continue;
      const prompts = promptsForSession(session);
      if (!prompts.length) continue;
      const subject = subjectForSession(session);
      const id = String(session.sessionId), prior = this.cache[id], sig = signature(prompts, subject);
      const currentVersion = prior && prior.v === 2;
      if (currentVersion && now - Number(prior.updatedAt || 0) < REFRESH_MS) continue;
      if (currentVersion && prior.source === 'local' && prior.promptSignature === sig) continue;
      let title = '', source = 'heuristic';
      try { title = sanitizeTitle(await this.summarize(prompts, session)); } catch (e) {}
      if (title) source = 'local';
      else title = heuristicTitle(prompts);
      if (!title) continue;
      if (subject) {
        const afterSubject = title.slice(subject.length);
        if (title.toLowerCase().startsWith(subject.toLowerCase()) && (!afterSubject || /^[\s—–:|-]/.test(afterSubject))) {
          const prefix = title.slice(0, subject.length);
          const task = afterSubject.replace(/^\s*(?:—|–|:|\||-)?\s*/, '');
          title = task ? `${prefix} — ${task}` : prefix;
        } else {
          title = `${subject} — ${title}`;
        }
      }
      this.cache[id] = { title, source, updatedAt: now, promptSignature: sig, v: 2 };
      changed = true;
    }
    if (changed) {
      try {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.cache, null, 2));
        fs.renameSync(this.file + '.tmp', this.file);
      } catch (e) {}
    }
  }
}

module.exports = { REFRESH_MS, PurposeTitles, promptsForSession, sanitizeTitle, localSummary, subjectForSession };
