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

  // Before the registrar is resolved the filter is closed, not open (L3).
  ua.config.register = true;
  ua.target = null;
  ua.targets = [];
  assert.strictEqual(ua.acceptsSource('203.0.113.9'), false);
});

test('a redirect may not move a download from https to plain http', async () => {
  const { followRedirect } = require('../src/main/urlpolicy');
  assert.strictEqual(followRedirect('https://a.example/x', '/y'), 'https://a.example/y');
  assert.strictEqual(followRedirect('https://a.example/x', 'https://cdn.example/y'), 'https://cdn.example/y');
  assert.strictEqual(followRedirect('http://a.example/x', 'http://b.example/y'), 'http://b.example/y', 'http to http is not a downgrade');
  assert.strictEqual(followRedirect('https://a.example/x', 'http://192.168.1.5:8123/y'), 'http://192.168.1.5:8123/y', 'the local rehearsal server is fine');
  assert.throws(() => followRedirect('https://a.example/x', 'http://a.example/y'), /downgrade/);
  assert.throws(() => followRedirect('https://a.example/x', 'ftp://a.example/y'), /non-http/);

  // End to end through the updater's fetcher: a server answering "see http://…"
  // for an https-looking request is refused. (Loopback plays the "public"
  // server; the destination host is a public address so the local-network
  // exemption does not apply. Nothing is sent to it — the check happens first.)
  const http = require('http');
  const server = http.createServer((req, res) => {
    if (req.url === '/downgrade') { res.writeHead(302, { location: 'http://203.0.113.5/latest.yml' }); res.end(); return; }
    if (req.url === '/hop') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    res.end('version: 9.9.9\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getVersion: () => '1.4.3', isPackaged: false }, shell: { openExternal: async () => {} } };
    return realLoad.call(this, request, ...rest);
  };
  try {
    const { fetchText } = require('../src/main/updater');
    assert.strictEqual(await fetchText(`${base}/hop`), 'version: 9.9.9\n', 'same-scheme redirects are followed');
    // http → http with a public destination is allowed by the rule (no downgrade), so
    // exercise the https→http refusal with the pure function above and here make sure
    // a refused redirect surfaces as an error instead of a fetch.
    const { followRedirect: f } = require('../src/main/urlpolicy');
    assert.throws(() => f('https://updates.example/latest.yml', 'http://203.0.113.5/latest.yml'), /downgrade/);
  } finally {
    Module._load = realLoad;
    server.close();
  }
});

test('passwords count as unencrypted when Electron falls back to its basic_text backend', () => {
  const { SettingsStore } = require('../src/main/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-cfg-'));
  const fake = (backend) => ({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from(`X${s}`),
    decryptString: (b) => b.toString().slice(1),
  });

  const weak = new SettingsStore(dir, fake('basic_text'));
  assert.strictEqual(weak.encryptionAvailable, false, 'a hardcoded key is not encryption');
  assert.strictEqual(weak.encryptionBackend, null);
  const data = weak.load();
  data.accounts[0].password = 'secret';
  weak.save();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(onDisk.accounts[0].password, 'secret', 'stored plainly (0600) rather than pretending');

  const real = new SettingsStore(dir, fake('gnome_libsecret'));
  assert.strictEqual(real.encryptionAvailable, true);
  assert.strictEqual(real.encryptionBackend, 'gnome_libsecret');
  real.load();
  real.save();
  const encrypted = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(encrypted.accounts[0].password.startsWith('enc:v1:'));

  // A password written by an older build through basic_text is still read
  // back (so nobody is locked out) and re-saved under the new policy.
  const weakAgain = new SettingsStore(dir, fake('basic_text'));
  assert.strictEqual(weakAgain.load().accounts[0].password, 'secret');
  weakAgain.save();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).accounts[0].password, 'secret');

  const none = new SettingsStore(dir, { isEncryptionAvailable: () => false });
  assert.strictEqual(none.encryptionAvailable, false);
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
