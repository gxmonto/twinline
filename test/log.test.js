'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../src/main/log');

test('logger buffers before init, writes after, and rotates by size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-log-'));
  const l = log.child('test');

  l.info('before init', { n: 1 });
  log.init(dir, { maxBytes: 600, keep: 3 });
  const file = path.join(dir, 'twinline.log');
  assert.ok(fs.readFileSync(file, 'utf8').includes('before init'), 'buffered line was flushed');

  for (let i = 0; i < 40; i++) l.warn(`line ${i} ${'x'.repeat(40)}`);
  const files = fs.readdirSync(dir).sort();
  assert.ok(files.includes('twinline.log'));
  assert.ok(files.includes('twinline.log.1'), `rotated: ${files}`);
  assert.ok(files.length <= 3, `at most keep=3 files: ${files}`);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 700, `${f} respects the cap`);
});

test('debug and SIP trace are off unless tracing is enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-log-'));
  log.init(dir);
  const l = log.child('trace');
  const file = path.join(dir, 'twinline.log');

  l.debug('hidden');
  l.sip('->', 'INVITE sip:x SIP/2.0\r\nVia: y\r\n\r\n', { address: '1.2.3.4', port: 5060 });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hidden'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('INVITE sip:x'));

  log.setTraceSip(true);
  l.debug('shown');
  l.sip('<-', 'SIP/2.0 200 OK\r\n\r\n', { address: '1.2.3.4', port: 5060 });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('shown'));
  assert.ok(text.includes('<- 1.2.3.4:5060\nSIP/2.0 200 OK'));
  log.setTraceSip(false);
});

test('errors serialise with their code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-log-'));
  log.init(dir);
  const err = new Error('send EADDRNOTAVAIL');
  err.code = 'EADDRNOTAVAIL';
  log.error('t', 'boom', err);
  assert.ok(fs.readFileSync(path.join(dir, 'twinline.log'), 'utf8').includes('"code":"EADDRNOTAVAIL"'));
});
