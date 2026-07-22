const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MAX_UPLOAD_BYTES, sanitizeUploadFilename, saveUpload } = require('../chats.js');

test('sanitizeUploadFilename strips directories and replaces unsafe characters', () => {
  assert.equal(sanitizeUploadFilename('../../secret image.png'), 'secret_image.png');
  assert.equal(sanitizeUploadFilename('..\\..\\windows?.jpg'), 'windows_.jpg');
  assert.equal(sanitizeUploadFilename(''), 'paste.png');
});

test('saveUpload jails files beneath the chat and enforces the decoded limit', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-upload-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));

  const saved = saveUpload(state, 'ck-safe-chat', '../../note image.txt', Buffer.from('hello').toString('base64'), 1234);
  assert.equal(saved, path.join(state, 'uploads', 'ck-safe-chat', '1234-note_image.txt'));
  assert.equal(fs.readFileSync(saved, 'utf8'), 'hello');
  assert.throws(
    () => saveUpload(state, 'ck-safe-chat', 'large.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64')),
    /15 MB/,
  );
});
