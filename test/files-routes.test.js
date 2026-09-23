// files-routes.test.js — transcript-derived file listing and bounded, safe file delivery.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..');
const PORT = 3941;
const BASE = `http://localhost:${PORT}`;
const result = (id, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const write = (id, file, ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file } }] } });

test('files routes enforce transcript/file membership, bounds, types, and mediation', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ckfiles-proj-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ckfiles-state-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ckfiles-work-'));
  fs.mkdirSync(path.join(state, 'sessions'));
  const text = path.join(work, 'notes.md');
  const svg = path.join(work, 'unsafe.svg');
  const binary = path.join(work, 'unknown.bin');
  const large = path.join(work, 'large.txt');
  const missing = path.join(work, 'deleted.txt');
  const outside = path.join(os.tmpdir(), 'ckfiles-outside-' + Date.now() + '.txt');
  const link = path.join(work, 'escape.txt');
  fs.writeFileSync(text, '# hello');
  fs.writeFileSync(svg, '<svg onload="alert(1)"></svg>');
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(large, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  fs.writeFileSync(outside, 'SECRET');
  fs.symlinkSync(outside, link);
  const tx = path.join(proj, 'good.jsonl');
  const rows = [
    write('text', text, '2026-08-18T10:00:00Z'), result('text'),
    write('svg', svg, '2026-08-18T10:01:00Z'), result('svg'),
    write('binary', binary, '2026-08-18T10:01:30Z'), result('binary'),
    write('large', large, '2026-08-18T10:02:00Z'), result('large'),
    write('missing', missing, '2026-08-18T10:03:00Z'), result('missing'),
    write('link', link, '2026-08-18T10:04:00Z'), result('link'),
  ];
  fs.writeFileSync(tx, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(state, 'sessions', 'good.json'), JSON.stringify({ sessionId: 'good', chatName: 'ck-files', cwd: work, transcriptPath: tx }));
  const jailed = path.join(state, 'outside-transcript.jsonl');
  fs.writeFileSync(jailed, JSON.stringify(write('x', text, '2026-08-18T10:00:00Z')) + '\n' + JSON.stringify(result('x')) + '\n');
  fs.writeFileSync(path.join(state, 'sessions', 'jailed.json'), JSON.stringify({ sessionId: 'jailed', chatName: 'ck-files', cwd: work, transcriptPath: jailed }));
  fs.writeFileSync(path.join(state, 'chats.json'), JSON.stringify([
    { name: 'ck-files', cwd: work, model: 'haiku', effort: 'low', provider: 'claude' },
    { name: 'ck-local', cwd: work, model: 'qwen:7b', effort: 'medium', provider: 'ollama', mediated: true },
  ]));

  const srv = spawn('node', [path.join(DIR, 'server.js')], {
    env: { ...process.env, AGENT_DASHBOARD_PORT: String(PORT), COCKPIT_DIR: state, CK_PROJECTS_DIR: proj, CK_TMUX_BIN: '/bin/echo' },
    stdio: 'ignore',
  });
  try {
    let token = '';
    for (let i = 0; i < 40 && !token; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { token = await (await fetch(`${BASE}/api/token`)).text(); } catch (e) {}
    }
    assert.ok(token, 'server did not become ready');
    const H = { 'x-cockpit-token': token };
    const filesUrl = (name, transcript) => `${BASE}/api/chats/${name}/files?path=${encodeURIComponent(transcript)}`;
    const fileUrl = (file, extra = '') => `${BASE}/api/chats/ck-files/file?path=${encodeURIComponent(tx)}&file=${encodeURIComponent(file)}${extra}`;

    const denied = await fetch(filesUrl('ck-files', tx));
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('content-type'), /application\/json/);
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
    const deniedFile = await fetch(fileUrl(text));
    assert.equal(deniedFile.status, 403);
    assert.match(deniedFile.headers.get('content-type'), /application\/json/);
    assert.equal(deniedFile.headers.get('x-content-type-options'), 'nosniff');

    const listRes = await fetch(filesUrl('ck-files', tx), { headers: H });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get('x-content-type-options'), 'nosniff');
    const list = await listRes.json();
    assert.deepStrictEqual(list.map(file => file.path), [link, missing, large, binary, svg, text]);
    assert.equal(list.find(file => file.path === text).exists, true);
    assert.equal(list.find(file => file.path === text).name, 'notes.md');
    assert.equal(list.find(file => file.path === text).size, 7);
    assert.equal(typeof list.find(file => file.path === text).mtime, 'number');
    assert.equal(list.find(file => file.path === missing).exists, false);
    assert.equal(list.find(file => file.path === link).exists, false);

    const wrongMethod = await fetch(filesUrl('ck-files', tx), { method: 'POST', headers: H });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('x-content-type-options'), 'nosniff');
    assert.match(wrongMethod.headers.get('content-type'), /application\/json/);

    const unknown = await fetch(fileUrl(path.join(work, 'not-recorded.txt')), { headers: H });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('x-content-type-options'), 'nosniff');

    const escaped = await fetch(fileUrl(link), { headers: H });
    assert.equal(escaped.status, 404);
    assert.doesNotMatch(await escaped.text(), /SECRET/);

    const tooLarge = await fetch(fileUrl(large), { headers: H });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.headers.get('x-content-type-options'), 'nosniff');
    assert.match((await tooLarge.json()).error, /too large.*open locally/i);

    const svgRes = await fetch(fileUrl(svg), { headers: H });
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers.get('content-type'), 'application/octet-stream');
    assert.match(svgRes.headers.get('content-disposition'), /^attachment;/);
    assert.equal(svgRes.headers.get('x-content-type-options'), 'nosniff');

    const binaryRes = await fetch(fileUrl(binary), { headers: H });
    assert.equal(binaryRes.status, 200);
    assert.equal(binaryRes.headers.get('content-type'), 'application/octet-stream');
    assert.match(binaryRes.headers.get('content-disposition'), /^attachment;/);
    assert.equal(binaryRes.headers.get('x-content-type-options'), 'nosniff');

    const textRes = await fetch(fileUrl(text), { headers: H });
    assert.equal(textRes.status, 200);
    assert.match(textRes.headers.get('content-type'), /^text\/plain/);
    assert.equal(textRes.headers.get('content-disposition'), null);
    assert.equal(await textRes.text(), '# hello');
    const download = await fetch(fileUrl(text, '&download=1'), { headers: H });
    assert.match(download.headers.get('content-disposition'), /^attachment;/);

    const jailRes = await fetch(filesUrl('ck-files', jailed), { headers: H });
    assert.equal(jailRes.status, 404);
    const mediated = await fetch(filesUrl('ck-local', tx), { headers: H });
    assert.equal(mediated.status, 200);
    assert.deepStrictEqual(await mediated.json(), []);
  } finally {
    srv.kill();
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
