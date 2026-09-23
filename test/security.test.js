'use strict';
/**
 * Hardening checks: header injection, RTP source filtering, SIP source
 * filtering, update-server policy, settings merge safety, CSV export safety,
 * model integrity.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/main/sip/parser');
const { RtpSession, buildPacket } = require('../src/main/rtp/session');
const { mergeDefaults, DEFAULT_SETTINGS } = require('../src/main/config');
const { ContactStore, parseCSV } = require('../src/main/contacts');
const { verifyFile } = require('../src/main/transcribe/models');

test('CR/LF in a header value cannot inject headers into a SIP message', () => {
  const msg = {
    method: 'INVITE', uri: 'sip:bob@x', headers: {
      via: ['SIP/2.0/UDP h;branch=z9'],
      from: ['"Evil\r\nContact: <sip:attacker@evil>" <sip:a@x>;tag=1'],
      to: ['<sip:b@x>'], 'call-id': ['c'], cseq: ['1 INVITE'],
    }, body: '',
  };
  const wire = P.stringify(msg);
  const parsed = P.parse(wire);
  assert.strictEqual(P.getHeader(parsed, 'contact'), undefined, 'no injected Contact header');
  assert.ok(P.getHeader(parsed, 'from').includes('Evil Contact:'), 'line break folded into a space');
});

test('whitespace in a dialled URI cannot break the request line', () => {
  const wire = P.stringify({ method: 'INVITE', uri: 'sip:bob@x SIP/2.0\r\nX: y', headers: { 'call-id': ['c'] }, body: '' });
  assert.ok(wire.startsWith('INVITE sip:bob@xSIP/2.0X:y SIP/2.0\r\n'));
  assert.strictEqual(P.parse(wire).headers.x, undefined);
});

async function rtpSession(opts) {
  const s = new RtpSession({ portRange: [18400, 18440], ...opts });
  await s.open();
  return s;
}

function packet(seq) {
  return buildPacket({ payloadType: 0, marker: false, sequence: seq, timestamp: seq * 160, ssrc: 1, payload: Buffer.alloc(160, 0xff) });
}

test('RTP from an address other than the SDP one is dropped', async () => {
  const s = await rtpSession({ strictSource: true });
  try {
    s.configure({ remoteAddress: '203.0.113.9', remotePort: 40000 });
    const rejected = [];
    s.on('unexpectedSource', (r) => rejected.push(r));

    s._onPacket(packet(1), { address: '198.51.100.7', port: 40000 });   // attacker
    assert.strictEqual(s.stats.packetsReceived, 0);
    assert.strictEqual(s.latched, false, 'the attacker did not capture the latch');
    assert.deepStrictEqual(s.remote, { address: '203.0.113.9', port: 40000 });
    assert.strictEqual(rejected.length, 1);

    s._onPacket(packet(2), { address: '203.0.113.9', port: 40002 });    // real peer, NAT-shifted port
    assert.strictEqual(s.stats.packetsReceived, 1);
    assert.deepStrictEqual(s.remote, { address: '203.0.113.9', port: 40002 }, 'port follows the real source');

    s._onPacket(packet(3), { address: '198.51.100.7', port: 40002 });   // attacker again, right port
    assert.strictEqual(s.stats.packetsReceived, 1);
    assert.strictEqual(s.stats.unexpectedSource, 2);
  } finally { s.close(); }
});

test('with strict source off, the first sender latches but a second host still cannot take over', async () => {
  const s = await rtpSession({ strictSource: false });
  try {
    s.configure({ remoteAddress: '203.0.113.9', remotePort: 40000 });
    s._onPacket(packet(1), { address: '203.0.113.50', port: 5000 });    // relay on another address
    assert.strictEqual(s.stats.packetsReceived, 1);
    assert.deepStrictEqual(s.remote, { address: '203.0.113.50', port: 5000 });
    s._onPacket(packet(2), { address: '198.51.100.7', port: 5000 });    // someone else mid-call
    assert.strictEqual(s.stats.packetsReceived, 1);
    assert.deepStrictEqual(s.remote, { address: '203.0.113.50', port: 5000 });
  } finally { s.close(); }
});

test('a UA with a registrar ignores SIP from other hosts', () => {
  const { UserAgent } = require('../src/main/sip/useragent');
  const ua = new UserAgent({ id: 'x', username: 'u', domain: 'pbx.example', register: true, acceptFromServerOnly: true }, { mixer: {} });
  ua.targets = [{ address: '203.0.113.9', port: 5060 }, { address: '203.0.113.10', port: 5060 }];
  ua.target = ua.targets[0];
  assert.strictEqual(ua.acceptsSource('203.0.113.9'), true);
  assert.strictEqual(ua.acceptsSource('203.0.113.10'), true);
  assert.strictEqual(ua.acceptsSource('198.51.100.7'), false, 'a scanner is ignored');

  ua.config.acceptFromServerOnly = false;
  assert.strictEqual(ua.acceptsSource('198.51.100.7'), true);
  ua.config.acceptFromServerOnly = true;
  ua.config.register = false;                 // direct trunking: no registrar to compare against
  assert.strictEqual(ua.acceptsSource('198.51.100.7'), true);
});

test('update server must be https unless it is on the local network', () => {
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getVersion: () => '1.4.0', isPackaged: false }, shell: { openExternal: async () => {} } };
    return realLoad.call(this, request, ...rest);
  };
  try {
    const { feedFromUrl, isLocalNetwork } = require('../src/main/updater');
    assert.throws(() => feedFromUrl('http://updates.example.com/twinline'), /https/);
    assert.throws(() => feedFromUrl('ftp://example.com/x'), /http/);
    assert.throws(() => feedFromUrl('not a url'), /full URL/);
    assert.deepStrictEqual(feedFromUrl('http://127.0.0.1:8123/'), { provider: 'generic', url: 'http://127.0.0.1:8123' });
    assert.deepStrictEqual(feedFromUrl('http://192.168.1.20:8123/'), { provider: 'generic', url: 'http://192.168.1.20:8123' });
    assert.strictEqual(feedFromUrl('https://github.com/gxmonto/twinline').provider, 'github');
    assert.strictEqual(isLocalNetwork('10.1.2.3'), true);
    assert.strictEqual(isLocalNetwork('172.31.0.1'), true);
    assert.strictEqual(isLocalNetwork('172.32.0.1'), false);
    assert.strictEqual(isLocalNetwork('8.8.8.8'), false);
  } finally {
    Module._load = realLoad;
  }
});

test('settings merge never touches Object.prototype', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"behaviour":{"maxCalls":3}}');
  const merged = mergeDefaults(hostile, DEFAULT_SETTINGS);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(merged.behaviour.maxCalls, 3);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(merged, '__proto__'), false);
});

test('CSV export defuses spreadsheet formulas and still round-trips', () => {
  const store = new ContactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-csv-')));
  store.add({ name: '=HYPERLINK("http://evil","click")', number: '+15550100' });
  store.add({ name: '@SUM(1)', number: '-1234', company: "-2+3+cmd|' /C calc'!A0" });
  store.add({ name: '+cmd|x', number: '+44 20 7946 0958' });
  const csv = store.toCSV();
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'formula is not the first character of a cell');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""click"")"`));
  assert.ok(csv.includes(`"'@SUM(1)"`));
  assert.ok(csv.includes(`"'-2+3+cmd|' /C calc'!A0"`), 'a minus followed by a formula is defused');
  assert.ok(csv.includes(`"'+cmd|x"`), 'a plus followed by a command is defused');
  assert.ok(csv.includes(',-1234,'), 'a plain negative number is left alone');
  assert.ok(csv.includes(',+44 20 7946 0958,'), 'a phone number keeps its plus');
  const back = parseCSV(csv);
  assert.strictEqual(back.length, 3);
  assert.ok(back.some((c) => c.number === '+44 20 7946 0958'), 'phone numbers round-trip exactly');
  assert.ok(back.some((c) => c.name.startsWith("'=")), 'the apostrophe stays visible on import, by design');
});

test('a downloaded model file with the wrong hash or size is discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-verify-'));
  const file = path.join(dir, 'model.onnx');
  fs.writeFileSync(file, 'hello');
  const goodHash = require('crypto').createHash('sha256').update('hello').digest('hex');

  verifyFile(file, { name: 'model.onnx', size: 5, sha256: goodHash }, goodHash);
  assert.ok(fs.existsSync(file), 'a matching file is kept');

  assert.throws(() => verifyFile(file, { name: 'model.onnx', size: 5, sha256: goodHash }, 'deadbeef'), /SHA-256/);
  assert.ok(!fs.existsSync(file), 'a mismatching file is removed');

  fs.writeFileSync(file, 'hello');
  assert.throws(() => verifyFile(file, { name: 'model.onnx', size: 999 }, goodHash), /size/);
  assert.ok(!fs.existsSync(file));
});
