'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const GIT_TIMEOUT_MS = 30000;

function normalizeUpdateConfig(config) {
  const update = config && typeof config.update === 'object' && config.update || {};
  return { check: update.check !== false, auto: update.auto !== false };
}

function readUpdateConfig(stateDir) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')); } catch (e) {}
  return normalizeUpdateConfig(config);
}

function sanitizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decideUpdate(input) {
  const behind = Math.max(0, Number(input && input.behind) || 0);
  const dirty = Boolean(input && input.dirty);
  const ffPossible = Boolean(input && input.ffPossible);
  const ahead = Math.max(0, Number(input && input.ahead) || 0);
  const current = String(input && input.current || '');
  const latest = String(input && input.latest || '');
  const changed = Boolean(current && latest && current !== latest);
  const aheadOrDiverged = ahead > 0 || (changed && !ffPossible);
  let blocked;
  if (changed && dirty) blocked = 'dirty-tree';
  else if (aheadOrDiverged) blocked = 'diverged';
  return {
    behind,
    aheadOrDiverged,
    dirty,
    ffPossible,
    canApply: changed && behind > 0 && !dirty && ffPossible && ahead === 0,
    ...(blocked ? { blocked } : {}),
  };
}

function readStateFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) { return {}; }
}

function writeStateFile(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temp, file);
    return true;
  } catch (e) { return false; }
}

function defaultRunGit(repo, args, options) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo].concat(args), {
      timeout: options && options.timeoutMs || GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

function defaultSpawnDeploy(repo) {
  const child = spawn(path.join(repo, 'deploy.sh'), [], { cwd: repo, detached: true, stdio: 'ignore' });
  // A detached deploy may fail after this server has already returned the API response. An
  // error listener keeps that asynchronous failure from becoming an uncaught exception.
  child.on('error', () => {});
  child.unref();
}

class Updater {
  constructor(options) {
    options = options || {};
    this.stateDir = options.stateDir || process.env.COCKPIT_DIR || __dirname;
    this.file = path.join(this.stateDir, 'update-state.json');
    this.runGit = options.runGit || defaultRunGit;
    this.spawnDeploy = options.spawnDeploy || defaultSpawnDeploy;
    this.gitTimeoutMs = options.gitTimeoutMs || GIT_TIMEOUT_MS;
    this.now = options.now || (() => Date.now());
    this.bootAt = options.bootAt === undefined ? Date.now() : options.bootAt;
    this.auto = options.auto === undefined ? readUpdateConfig(this.stateDir).auto : Boolean(options.auto);
    this._queue = Promise.resolve();
  }

  readState() { return readStateFile(this.file); }
  getState() { return this.readState(); }

  _write(state) {
    writeStateFile(this.file, state);
    return state;
  }

  _serialize(task) {
    const result = this._queue.then(task, task);
    this._queue = result.catch(() => {});
    return result;
  }

  _repo() {
    let raw;
    try { raw = fs.readFileSync(path.join(this.stateDir, '.repo-root'), 'utf8').trim(); } catch (e) { return ''; }
    if (!raw || raw.includes('\0')) return '';
    const repo = path.resolve(raw);
    try {
      if (!fs.statSync(repo).isDirectory() || !fs.existsSync(path.join(repo, '.git'))) return '';
    } catch (e) { return ''; }
    return repo;
  }

  async _git(repo, args) {
    const result = await this.runGit(repo, args, { timeoutMs: this.gitTimeoutMs });
    return String(result && result.stdout !== undefined ? result.stdout : result || '').trim();
  }

  async _upstream(repo) {
    try {
      const upstream = await this._git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (upstream) return upstream;
    } catch (e) {}
    const branch = await this._git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') throw new Error('current branch has no upstream');
    return `origin/${branch}`;
  }

  async _inspect(repo, fetchFirst) {
    if (fetchFirst) await this._git(repo, ['fetch', '--quiet', 'origin']);
    const upstream = await this._upstream(repo);
    const current = await this._git(repo, ['rev-parse', 'HEAD']);
    const latest = await this._git(repo, ['rev-parse', upstream]);
    const dirty = Boolean(await this._git(repo, ['status', '--porcelain']));
    let ffPossible = false;
    try {
      await this._git(repo, ['merge-base', '--is-ancestor', 'HEAD', upstream]);
      ffPossible = true;
    } catch (e) {
      if (!(e && (e.code === 1 || e.exitCode === 1))) throw e;
    }
    const behind = Number.parseInt(await this._git(repo, ['rev-list', '--count', `HEAD..${upstream}`]), 10) || 0;
    const ahead = Number.parseInt(await this._git(repo, ['rev-list', '--count', `${upstream}..HEAD`]), 10) || 0;
    let log = [];
    if (behind > 0) {
      const rawLog = await this._git(repo, ['log', '--oneline', '-5', `HEAD..${upstream}`]);
      log = rawLog.split(/\r?\n/).map(sanitizeText).filter(Boolean).slice(0, 5);
    }
    return { upstream, current, latest, dirty, ffPossible, behind, ahead, log };
  }

  // Resolve a prior in-flight update against reality. 'ok' requires the server process to have
  // restarted after the update began (deploy.sh restarts us) — HEAD alone can't distinguish
  // "pulled + redeployed" from "pulled, deploy died, old server still running".
  _reconcile(prior, currentHead) {
    if (!prior || prior.status !== 'started' || !prior.to) return prior && prior.lastUpdate;
    const at = Number(prior.updateStartedAt) || 0;
    if (currentHead === prior.to && this.bootAt > at) return { status: 'ok', from: prior.from, to: prior.to, at };
    if (this.now() - at > 10 * 60 * 1000) return { status: 'failed', from: prior.from, to: prior.to, at };
    return prior.lastUpdate;
  }

  check() {
    return this._serialize(async () => {
      const repo = this._repo();
      if (!repo) return this._write({ status: 'no-repo' });
      try {
        const prior = this.readState();
        const inspected = await this._inspect(repo, true);
        const decision = decideUpdate(inspected);
        const lastUpdate = this._reconcile(prior, inspected.current);
        const stillStarted = prior.status === 'started' && lastUpdate === prior.lastUpdate;
        const state = this._write({
          ...(stillStarted ? { status: 'started', updateStartedAt: prior.updateStartedAt, from: prior.from, to: prior.to } : {}),
          ...(lastUpdate ? { lastUpdate } : {}),
          checkedAt: this.now(),
          behind: decision.behind,
          aheadOrDiverged: decision.aheadOrDiverged,
          dirty: decision.dirty,
          current: inspected.current,
          latest: inspected.latest,
          log: inspected.log,
          ffPossible: decision.ffPossible,
          ...(decision.blocked ? { blocked: decision.blocked } : {}),
        });
        return this.auto && decision.canApply ? this._applyUpdate(repo) : state;
      } catch (e) {
        return this._write({ checkedAt: this.now(), status: 'error', error: sanitizeText(e && (e.stderr || e.message) || e) || 'update check failed' });
      }
    });
  }

  applyUpdate() {
    return this._serialize(async () => {
      const repo = this._repo();
      if (!repo) return this._write({ status: 'no-repo', blocked: 'no-repo' });
      return this._applyUpdate(repo);
    });
  }

  async _applyUpdate(repo) {
    try {
      const prior = this.readState();
      const inspected = await this._inspect(repo, false);
      const decision = decideUpdate(inspected);
      if (!decision.canApply) {
        const blocked = decision.blocked || 'up-to-date';
        // repo already pulled but the detached deploy died → allow a redeploy retry
        if (blocked === 'up-to-date' && !decision.dirty && prior.lastUpdate && prior.lastUpdate.status === 'failed') {
          const started = this._write({
            ...prior, status: 'started', updateStartedAt: this.now(),
            from: inspected.current, to: inspected.current,
          });
          this.spawnDeploy(repo);
          return started;
        }
        return this._write({
          ...this.readState(), status: 'blocked', blocked,
          behind: decision.behind, aheadOrDiverged: decision.aheadOrDiverged,
          dirty: decision.dirty, current: inspected.current, latest: inspected.latest,
          log: inspected.log, ffPossible: decision.ffPossible,
        });
      }
      const started = this._write({
        ...this.readState(), status: 'started', updateStartedAt: this.now(),
        from: inspected.current, to: inspected.latest,
      });
      // final invariant immediately before the pull — the tree may have gone dirty since inspect
      if (await this._git(repo, ['status', '--porcelain'])) throw new Error('working tree changed during update — aborted before pull');
      await this._git(repo, ['pull', '--ff-only']);
      this.spawnDeploy(repo);
      return started;
    } catch (e) {
      const failed = { ...this.readState() };
      delete failed.updateStartedAt;
      delete failed.from;
      delete failed.to;
      return this._write({ ...failed, status: 'error', error: sanitizeText(e && (e.stderr || e.message) || e) || 'update failed' });
    }
  }
}

module.exports = {
  GIT_TIMEOUT_MS,
  Updater,
  decideUpdate,
  normalizeUpdateConfig,
  readUpdateConfig,
  readStateFile,
  writeStateFile,
  sanitizeText,
  defaultRunGit,
};
