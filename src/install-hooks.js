#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function fail(message) {
  console.error(`install-hooks: ${message}`);
  process.exit(1);
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.deploy-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function commandOf(entry) {
  const hook = Array.isArray(entry.hooks) && entry.hooks.find(item => item && item.type === 'command');
  return hook && typeof hook.command === 'string' ? hook.command : '';
}

function markerFor(entry) {
  return path.join(mirror, commandOf(entry).includes('/start.js') ? 'start.js' : 'session-hook.js');
}

function hasMarker(entries, marker) {
  return Array.isArray(entries) && entries.some(entry => commandOf(entry).includes(marker));
}

const args = process.argv.slice(2);
let mode = null;
let settingsArg = null;
for (let i = 0; i < args.length; i++) {
  if (['--print', '--merge', '--check'].includes(args[i])) {
    if (mode) fail('choose exactly one of --print, --merge, or --check');
    mode = args[i];
  } else if (args[i] === '--settings' && args[i + 1]) {
    settingsArg = args[++i];
  } else {
    fail(`unknown or incomplete argument: ${args[i]}`);
  }
}
if (!mode) fail('choose one of --print, --merge, or --check');

const mirror = path.resolve(process.env.CK_MIRROR_DIR || path.join(os.homedir(), '.claude', 'agent-dashboard'));
const templateFile = path.join(__dirname, 'hooks.template.json');
let resolved;
try {
  resolved = JSON.parse(fs.readFileSync(templateFile, 'utf8').replaceAll('__MIRROR__', mirror));
} catch (err) {
  fail(`could not read hook template: ${err.message}`);
}

if (mode === '--print') {
  const text = JSON.stringify(resolved, null, 2) + '\n';
  atomicWrite(path.join(mirror, 'generated-hooks.json'), text);
  process.stdout.write(text);
  process.exit(0);
}

const settingsFile = path.resolve(settingsArg || process.env.CK_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json'));
let settings = {};
let original = null;
try {
  original = fs.readFileSync(settingsFile, 'utf8');
  settings = JSON.parse(original);
} catch (err) {
  if (err.code !== 'ENOENT') fail(`refusing to modify unparsable settings ${settingsFile}: ${err.message}`);
}

if (mode === '--check') {
  for (const [event, entries] of Object.entries(resolved.hooks)) {
    for (const entry of entries) {
      if (!hasMarker(settings.hooks && settings.hooks[event], markerFor(entry))) process.exit(1);
    }
  }
  process.exit(0);
}

if (original !== null) {
  fs.copyFileSync(settingsFile, `${settingsFile}.bak-cockpit-${Date.now()}`);
}
if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
for (const [event, entries] of Object.entries(resolved.hooks)) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  for (const entry of entries) {
    if (!hasMarker(settings.hooks[event], markerFor(entry))) settings.hooks[event].push(entry);
  }
}
atomicWrite(settingsFile, JSON.stringify(settings, null, 2) + '\n');
