'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCredential, DigestStore } = require('../src/main/sip/digest');
const P = require('../src/main/sip/parser');

test('RFC 2617 §3.5 worked example (qop=auth)', () => {
  const challenge = P.parseAuthHeader(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
    'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const cred = createCredential({
    challenge,
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.strictEqual(cred.params.response, '6629fae49393a05397450978507c4ef1');
  assert.strictEqual(cred.params.qop, 'auth');
  assert.strictEqual(cred.params.nc, '00000001');
  assert.strictEqual(cred.params.opaque, '5ccc069c403ebaf9f0171e9517f40e41');
});

test('legacy RFC 2069 style challenge without qop', () => {
  const challenge = P.parseAuthHeader('Digest realm="pbx", nonce="xyz"');
  const cred = createCredential({
    challenge, username: 'alice', password: 'pw', method: 'REGISTER', uri: 'sip:pbx',
  });
  // HA1 = md5(alice:pbx:pw), HA2 = md5(REGISTER:sip:pbx), response = md5(HA1:xyz:HA2)
  const md5 = (s) => require('crypto').createHash('md5').update(s).digest('hex');
  const ha1 = md5('alice:pbx:pw');
  const ha2 = md5('REGISTER:sip:pbx');
  assert.strictEqual(cred.params.response, md5(`${ha1}:xyz:${ha2}`));
  assert.strictEqual(cred.params.qop, undefined);
  assert.strictEqual(cred.params.nc, undefined);
});

test('SHA-256 challenge selected over MD5 when both are offered', () => {
  const store = new DigestStore('alice', 'pw');
  const response = P.parse([
    'SIP/2.0 401 Unauthorized',
    'WWW-Authenticate: Digest realm="pbx", nonce="n1", algorithm=MD5',
    'WWW-Authenticate: Digest realm="pbx", nonce="n1", algorithm=SHA-256',
    '', '',
  ].join('\r\n'));
  assert.strictEqual(store.addChallenges(response), true);
  const req = { headers: {} };
  store.authorize(req, { method: 'REGISTER', uri: 'sip:pbx' });
  const cred = P.parseAuthHeader(req.headers.authorization[0]);
  assert.strictEqual(cred.params.algorithm, 'SHA-256');
  assert.strictEqual(cred.params.response.length, 64);
});

test('proxy and UA challenges produce separate credential headers', () => {
  const store = new DigestStore('alice', 'pw');
  const response = P.parse([
    'SIP/2.0 401 Unauthorized',
    'WWW-Authenticate: Digest realm="ua", nonce="n1"',
    'Proxy-Authenticate: Digest realm="proxy", nonce="n2"',
    '', '',
  ].join('\r\n'));
  store.addChallenges(response);
  const req = { headers: {} };
  store.authorize(req, { method: 'INVITE', uri: 'sip:b@x' });
  assert.strictEqual(req.headers.authorization.length, 1);
  assert.strictEqual(req.headers['proxy-authorization'].length, 1);
  assert.strictEqual(P.parseAuthHeader(req.headers.authorization[0]).params.realm, 'ua');
  assert.strictEqual(P.parseAuthHeader(req.headers['proxy-authorization'][0]).params.realm, 'proxy');
});

test('nonce count increments across reuses of a stored challenge', () => {
  const store = new DigestStore('alice', 'pw');
  store.addChallenges(P.parse('SIP/2.0 401 x\r\nWWW-Authenticate: Digest realm="r", nonce="n", qop="auth"\r\n\r\n'));
  const nc = [];
  for (let i = 0; i < 3; i++) {
    const req = { headers: {} };
    store.authorize(req, { method: 'REGISTER', uri: 'sip:pbx' });
    nc.push(P.parseAuthHeader(req.headers.authorization[0]).params.nc);
  }
  assert.deepStrictEqual(nc, ['00000001', '00000002', '00000003']);
});

test('authorize replaces stale credentials rather than appending', () => {
  const store = new DigestStore('alice', 'pw');
  store.addChallenges(P.parse('SIP/2.0 401 x\r\nWWW-Authenticate: Digest realm="r", nonce="n"\r\n\r\n'));
  const req = { headers: { authorization: ['Digest stale-junk'] } };
  store.authorize(req, { method: 'REGISTER', uri: 'sip:pbx' });
  assert.strictEqual(req.headers.authorization.length, 1);
  assert.ok(!req.headers.authorization[0].includes('stale-junk'));
});

test('changing credentials drops cached challenges', () => {
  const store = new DigestStore('alice', 'pw');
  store.addChallenges(P.parse('SIP/2.0 401 x\r\nWWW-Authenticate: Digest realm="r", nonce="n"\r\n\r\n'));
  assert.strictEqual(store.hasChallenges, true);
  store.setCredentials('alice', 'newpw');
  assert.strictEqual(store.hasChallenges, false);
});

test('a fresh nonce for the same realm resets the nonce count', () => {
  const store = new DigestStore('alice', 'pw');
  store.addChallenges(P.parse('SIP/2.0 401 x\r\nWWW-Authenticate: Digest realm="r", nonce="n1", qop="auth"\r\n\r\n'));
  const a = { headers: {} };
  store.authorize(a, { method: 'REGISTER', uri: 'sip:pbx' });
  store.addChallenges(P.parse('SIP/2.0 401 x\r\nWWW-Authenticate: Digest realm="r", nonce="n2", qop="auth"\r\n\r\n'));
  const b = { headers: {} };
  store.authorize(b, { method: 'REGISTER', uri: 'sip:pbx' });
  const cred = P.parseAuthHeader(b.headers.authorization[0]);
  assert.strictEqual(cred.params.nonce, 'n2');
  assert.strictEqual(cred.params.nc, '00000001');
});

test('credential serialises with the parameters a proxy expects', () => {
  const store = new DigestStore('1001', 's3cret');
  store.addChallenges(P.parse('SIP/2.0 407 x\r\nProxy-Authenticate: Digest realm="voip.example", nonce="abc", qop="auth"\r\n\r\n'));
  const req = { headers: {} };
  store.authorize(req, { method: 'INVITE', uri: 'sip:+15551234567@voip.example' });
  const raw = req.headers['proxy-authorization'][0];
  assert.ok(raw.startsWith('Digest '));
  assert.ok(raw.includes('username="1001"'));
  assert.ok(raw.includes('uri="sip:+15551234567@voip.example"'));
  assert.ok(/[, ]qop=auth[,\s]/.test(raw + ' '), `qop must be unquoted in a credential: ${raw}`);
  assert.ok(raw.includes('cnonce="'));
});
