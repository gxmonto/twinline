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

test('the SIP trace masks digest responses and nonces but keeps the username', () => {
  const msg = [
    'REGISTER sip:pbx.example SIP/2.0',
    'Via: SIP/2.0/UDP 10.0.0.2:5060;branch=z9hG4bK1',
    'Authorization: Digest username="1001", realm="pbx.example", nonce="abc123", uri="sip:pbx.example", response="deadbeefcafe", algorithm=MD5, cnonce="xyz", qop=auth, nc=00000001',
    'proxy-authorization: Digest username="1001",nonce=plainnonce,response=0011',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  const out = log.redactSip(msg);
  assert.ok(out.includes('username="1001"'));
  assert.ok(out.includes('realm="pbx.example"'));
  assert.ok(out.includes('nonce="[redacted]"'));
  assert.ok(out.includes('response="[redacted]"'));
  assert.ok(out.includes('cnonce="[redacted]"'));
  assert.ok(out.includes('nonce=[redacted]') && out.includes('response=[redacted]'), 'unquoted values too');
  assert.ok(!out.includes('deadbeefcafe') && !out.includes('abc123') && !out.includes('plainnonce'));
  assert.ok(out.includes('Via: SIP/2.0/UDP 10.0.0.2:5060;branch=z9hG4bK1'), 'other headers are untouched');

  const challenge = 'SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm="pbx.example", nonce="server-nonce", algorithm=MD5\r\n\r\n';
  assert.ok(!log.redactSip(challenge).includes('server-nonce'));

  // And it is applied on the way into the file. (The rotation test above
  // left a tiny size cap behind; lift it so this long line is not rotated away.)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-log-'));
  log.init(dir, { maxBytes: 1e6 });
  log.setTraceSip(true);
  log.child('t').sip('->', msg, { address: '1.2.3.4', port: 5060 });
  log.setTraceSip(false);
  const text = fs.readFileSync(path.join(dir, 'twinline.log'), 'utf8');
  assert.ok(text.includes('username="1001"') && !text.includes('deadbeefcafe'));
});

test('errors serialise with their code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-log-'));
  log.init(dir);
  const err = new Error('send EADDRNOTAVAIL');
  err.code = 'EADDRNOTAVAIL';
  log.error('t', 'boom', err);
  assert.ok(fs.readFileSync(path.join(dir, 'twinline.log'), 'utf8').includes('"code":"EADDRNOTAVAIL"'));
});
