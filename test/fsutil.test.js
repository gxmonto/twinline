'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../src/main/fsutil');

/** A real fs whose rename fails `times` times with `code` — a scanner holding the .tmp. */
function flakyFs(times, code = 'EPERM') {
  let left = times;
  return { ...fs, renames: 0, renameSync(a, b) { this.renames++; if (left-- > 0) { const e = new Error(`${code}: operation not permitted, rename`); e.code = code; throw e; } return fs.renameSync(a, b); } };
}

test('a write lands normally when the rename works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-fs-'));
  const file = path.join(dir, 'settings.json');
  assert.strictEqual(writeFileAtomic(file, '{"a":1}'), 'renamed');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('a rename blocked for a moment (antivirus) is retried and still lands atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-fs-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const f = flakyFs(3);
  assert.strictEqual(writeFileAtomic(file, 'new', { fs: f, delayMs: 1 }), 'renamed');
  assert.strictEqual(f.renames, 4);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});

test('a rename that never succeeds falls back to writing in place rather than losing the save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-fs-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const f = flakyFs(99, 'EBUSY');
  assert.strictEqual(writeFileAtomic(file, 'new', { fs: f, retries: 2, delayMs: 1 }), 'in-place');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'the temp file is cleaned up');
});

test('an unexpected error is not retried and is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-fs-'));
  const file = path.join(dir, 'x', 'settings.json');
  const f = { ...fs, writeFileSync() { const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e; } };
  assert.throws(() => writeFileAtomic(file, 'data', { fs: f }), /ENOSPC/);
});
