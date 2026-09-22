'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/main/sip/parser');

const REGISTER = [
  'REGISTER sip:pbx.example.com SIP/2.0',
  'Via: SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK776asdhds;rport',
  'Max-Forwards: 70',
  'From: "Alice Smith" <sip:alice@pbx.example.com>;tag=1928301774',
  'To: <sip:alice@pbx.example.com>',
  'Call-ID: a84b4c76e66710@10.0.0.5',
  'CSeq: 314159 REGISTER',
  'Contact: <sip:alice@10.0.0.5:5060;transport=udp>;expires=300',
  'Expires: 300',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

test('parses a request line and headers', () => {
  const m = P.parse(REGISTER);
  assert.strictEqual(m.method, 'REGISTER');
  assert.strictEqual(m.uri, 'sip:pbx.example.com');
  assert.strictEqual(m.version, 'SIP/2.0');
  assert.strictEqual(P.getHeader(m, 'call-id'), 'a84b4c76e66710@10.0.0.5');
  assert.strictEqual(P.getHeader(m, 'Max-Forwards'), '70');
  assert.strictEqual(m.body, '');
});

test('parses a status line', () => {
  const m = P.parse('SIP/2.0 401 Unauthorized\r\nCall-ID: x\r\n\r\n');
  assert.strictEqual(m.status, 401);
  assert.strictEqual(m.reason, 'Unauthorized');
  assert.strictEqual(m.method, undefined);
});

test('expands compact header forms', () => {
  const m = P.parse('MESSAGE sip:b@x SIP/2.0\r\nv: SIP/2.0/UDP h;branch=z9\r\ni: abc\r\nf: <sip:a@x>;tag=1\r\nt: <sip:b@x>\r\nl: 0\r\n\r\n');
  assert.strictEqual(P.getHeader(m, 'call-id'), 'abc');
  assert.strictEqual(P.getHeaders(m, 'via').length, 1);
  assert.ok(P.getHeader(m, 'from').includes('sip:a@x'));
});

test('splits comma-separated list headers but not quoted commas', () => {
  const m = P.parse([
    'INVITE sip:b@x SIP/2.0',
    'Via: SIP/2.0/UDP a.example;branch=z9hG4bK1, SIP/2.0/UDP b.example;branch=z9hG4bK2',
    'Subject: hello, world',
    'From: "Doe, John" <sip:john@x>;tag=7',
    '', '',
  ].join('\r\n'));
  assert.strictEqual(P.getHeaders(m, 'via').length, 2);
  assert.strictEqual(P.getHeader(m, 'subject'), 'hello, world');
  assert.strictEqual(P.parseNameAddr(P.getHeader(m, 'from')).name, 'Doe, John');
});

test('unfolds continuation lines', () => {
  const m = P.parse('OPTIONS sip:x SIP/2.0\r\nSubject: I know you\r\n  are there\r\n\r\n');
  assert.strictEqual(P.getHeader(m, 'subject'), 'I know you are there');
});

test('parses a Via', () => {
  const v = P.parseVia('SIP/2.0/TLS 192.0.2.1:5061;branch=z9hG4bKabc;received=198.51.100.7;rport=1234');
  assert.strictEqual(v.transport, 'TLS');
  assert.strictEqual(v.host, '192.0.2.1');
  assert.strictEqual(v.port, 5061);
  assert.strictEqual(v.params.branch, 'z9hG4bKabc');
  assert.strictEqual(v.params.received, '198.51.100.7');
  assert.strictEqual(v.params.rport, '1234');
});

test('round-trips a Via', () => {
  const s = 'SIP/2.0/UDP 10.0.0.5:5060;branch=z9hG4bK1;rport';
  assert.strictEqual(P.stringifyVia(P.parseVia(s)), s);
});

test('parses URIs including IPv6 and parameters', () => {
  const u = P.parseUri('sips:alice:secret@[2001:db8::1]:5061;transport=tls;user=phone?subject=hi');
  assert.strictEqual(u.scheme, 'sips');
  assert.strictEqual(u.user, 'alice');
  assert.strictEqual(u.password, 'secret');
  assert.strictEqual(u.host, '[2001:db8::1]');
  assert.strictEqual(u.port, 5061);
  assert.strictEqual(u.params.transport, 'tls');
  assert.strictEqual(u.headers.subject, 'hi');
});

test('parses a bare host URI with no port', () => {
  const u = P.parseUri('sip:pbx.example.com');
  assert.strictEqual(u.host, 'pbx.example.com');
  assert.strictEqual(u.port, null);
  assert.strictEqual(u.user, null);
});

test('name-addr: header params stay out of the URI', () => {
  const na = P.parseNameAddr('<sip:bob@example.com;transport=tcp>;tag=9fxced76sl');
  assert.strictEqual(na.uri.params.transport, 'tcp');
  assert.strictEqual(na.params.tag, '9fxced76sl');
  assert.strictEqual(na.uri.params.tag, undefined);
});

test('name-addr: addr-spec form splits params at the first semicolon', () => {
  const na = P.parseNameAddr('sip:bob@example.com;tag=abc');
  assert.strictEqual(na.params.tag, 'abc');
  assert.strictEqual(na.uri.host, 'example.com');
  assert.strictEqual(na.uri.params.tag, undefined);
});

test('name-addr round-trip keeps display name quoting', () => {
  const na = P.parseNameAddr('"Smith, J. \\"Jay\\"" <sip:j@x>;tag=1');
  assert.strictEqual(na.name, 'Smith, J. "Jay"');
  const again = P.parseNameAddr(P.stringifyNameAddr(na));
  assert.strictEqual(again.name, 'Smith, J. "Jay"');
  assert.strictEqual(again.params.tag, '1');
});

test('parses CSeq', () => {
  assert.deepStrictEqual(P.parseCSeq('314159 REGISTER'), { seq: 314159, method: 'REGISTER' });
});

test('stringify recomputes Content-Length and orders headers', () => {
  const m = P.parse(REGISTER);
  m.body = 'v=0\r\n';
  const out = P.stringify(m);
  assert.ok(out.startsWith('REGISTER sip:pbx.example.com SIP/2.0\r\nVia: '));
  assert.ok(out.includes('Content-Length: 5\r\n'));
  assert.ok(out.endsWith('\r\n\r\nv=0\r\n'));
  // Via must precede From, From precede Call-ID.
  assert.ok(out.indexOf('\r\nVia:') < out.indexOf('\r\nFrom:'));
  assert.ok(out.indexOf('\r\nFrom:') < out.indexOf('\r\nCall-ID:'));
});

test('stringify emits canonical header casing', () => {
  const m = P.parse(REGISTER);
  const out = P.stringify(m);
  assert.ok(out.includes('Call-ID: '));
  assert.ok(out.includes('CSeq: '));
  assert.ok(out.includes('Max-Forwards: '));
});

test('parse/stringify round-trips a message with a body', () => {
  const body = 'v=0\r\no=- 1 1 IN IP4 10.0.0.5\r\n';
  const raw = `INVITE sip:b@x SIP/2.0\r\nVia: SIP/2.0/UDP h;branch=z9\r\nCall-ID: c\r\nCSeq: 1 INVITE\r\nContent-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
  const m = P.parse(raw);
  assert.strictEqual(m.body, body);
  assert.strictEqual(P.parse(P.stringify(m)).body, body);
});

test('parses an auth challenge with quoted commas', () => {
  const a = P.parseAuthHeader('Digest realm="sip.example, inc", nonce="abc,def", qop="auth,auth-int", stale=FALSE, algorithm=MD5');
  assert.strictEqual(a.scheme, 'Digest');
  assert.strictEqual(a.params.realm, 'sip.example, inc');
  assert.strictEqual(a.params.nonce, 'abc,def');
  assert.strictEqual(a.params.qop, 'auth,auth-int');
  assert.strictEqual(a.params.stale, 'FALSE');
  assert.strictEqual(a.params.algorithm, 'MD5');
});

test('reason phrases are filled in on stringify', () => {
  assert.ok(P.stringify({ status: 486, headers: {} }).startsWith('SIP/2.0 486 Busy Here'));
});
