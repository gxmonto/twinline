'use strict';
const test = require('node:test');
const assert = require('node:assert');

const codecs = require('../src/main/rtp/codecs');
const { JitterBuffer } = require('../src/main/rtp/jitterbuffer');
const { AudioMixer } = require('../src/main/media/mixer');
const { parsePacket, buildPacket } = require('../src/main/rtp/session');

// ---- G.711 -----------------------------------------------------------------

test('G.711 known encodings', () => {
  // Reference values from ITU-T G.711: silence encodes to 0xFF (µ-law)
  // and 0xD5 (A-law).
  assert.strictEqual(codecs.linear2ulaw(0), 0xff);
  assert.strictEqual(codecs.linear2alaw(0), 0xd5);
  // Sign bit clears for negatives; -1 lands in segment 0, mantissa 1.
  assert.strictEqual(codecs.linear2ulaw(-1), 0x7e);
  assert.strictEqual(codecs.linear2alaw(-1), 0x55);
  // Full-scale values saturate at the top of segment 7.
  assert.strictEqual(codecs.linear2ulaw(32767), 0x80);
  assert.strictEqual(codecs.linear2ulaw(-32768), 0x00);
  // Decoding the µ-law and A-law zero codes returns to (near) zero.
  assert.strictEqual(codecs.ulaw2linear(0xff), 0);
  assert.strictEqual(Math.abs(codecs.alaw2linear(0xd5)) <= 8, true);
});

test('G.711 round-trip stays within quantisation error', () => {
  for (const [name, enc, dec] of [
    ['PCMU', codecs.linear2ulaw, codecs.ulaw2linear],
    ['PCMA', codecs.linear2alaw, codecs.alaw2linear],
  ]) {
    let worstRelative = 0;
    for (let s = -32768; s < 32768; s += 7) {
      const back = dec(enc(s));
      const err = Math.abs(back - s);
      // G.711 is logarithmic: error grows with amplitude but stays under
      // ~8% of the sample value, with a small absolute floor near zero.
      const tolerance = Math.max(64, Math.abs(s) * 0.08);
      assert.ok(err <= tolerance, `${name}: ${s} -> ${back} (err ${err} > ${tolerance})`);
      if (Math.abs(s) > 1000) worstRelative = Math.max(worstRelative, err / Math.abs(s));
    }
    assert.ok(worstRelative < 0.08, `${name} worst relative error ${worstRelative}`);
  }
});

test('G.711 buffer encode/decode preserves frame length', () => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i++) pcm[i] = Math.round(8000 * Math.sin(i / 8));
  const encoded = codecs.encodePCMU(pcm);
  assert.strictEqual(encoded.length, 160);
  const decoded = codecs.decodePCMU(encoded);
  assert.strictEqual(decoded.length, 160);
  for (let i = 0; i < 160; i++) {
    assert.ok(Math.abs(decoded[i] - pcm[i]) <= Math.max(64, Math.abs(pcm[i]) * 0.08));
  }
});

test('codec silence frames decode to near zero', () => {
  for (const name of ['PCMU', 'PCMA']) {
    const c = codecs.CODECS[name];
    const decoded = c.decode(c.silence(160));
    assert.strictEqual(decoded.length, 160);
    for (const s of decoded) assert.ok(Math.abs(s) <= 8, `${name} silence sample ${s}`);
  }
});

// ---- RTP packets -----------------------------------------------------------

test('RTP packet round-trip', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const buf = buildPacket({ payloadType: 0, marker: true, sequence: 65535, timestamp: 0xfffffff0, ssrc: 0xdeadbeef, payload });
  const p = parsePacket(buf);
  assert.strictEqual(p.payloadType, 0);
  assert.strictEqual(p.marker, 1);
  assert.strictEqual(p.sequence, 65535);
  assert.strictEqual(p.timestamp, 0xfffffff0);
  assert.strictEqual(p.ssrc, 0xdeadbeef);
  assert.deepStrictEqual([...p.payload], [1, 2, 3, 4]);
});

test('RTP parser skips CSRCs and honours padding', () => {
  const payload = Buffer.from([9, 9, 0, 0, 2]);       // last byte: 2 bytes padding
  const header = Buffer.alloc(16);
  header[0] = (2 << 6) | 0x20 | 1;                     // version 2, padding, 1 CSRC
  header[1] = 8;
  header.writeUInt16BE(7, 2);
  const buf = Buffer.concat([header, payload]);
  const p = parsePacket(buf);
  assert.strictEqual(p.payloadType, 8);
  assert.strictEqual(p.sequence, 7);
  assert.deepStrictEqual([...p.payload], [9, 9, 0]);
});

test('RTP parser rejects non-RTP data', () => {
  assert.strictEqual(parsePacket(Buffer.alloc(4)), null);
  assert.strictEqual(parsePacket(Buffer.from('not rtp at all!!')), null);
});

// ---- jitter buffer ---------------------------------------------------------

function frame(value, n = 160) {
  const f = new Int16Array(n);
  f.fill(value);
  return f;
}

test('jitter buffer prebuffers then plays in order', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 3 });
  assert.strictEqual(jb.pull(), null, 'nothing before prebuffer fills');
  jb.push(100, frame(1));
  jb.push(101, frame(2));
  assert.strictEqual(jb.pull(), null);
  jb.push(102, frame(3));
  assert.strictEqual(jb.pull()[0], 1);
  assert.strictEqual(jb.pull()[0], 2);
  assert.strictEqual(jb.pull()[0], 3);
});

test('jitter buffer reorders out-of-order arrivals', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 3 });
  jb.push(10, frame(1));
  jb.push(12, frame(3));
  jb.push(11, frame(2));
  assert.deepStrictEqual([jb.pull()[0], jb.pull()[0], jb.pull()[0]], [1, 2, 3]);
});

test('jitter buffer conceals a lost frame instead of stalling', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 2 });
  jb.push(1, frame(1000));
  jb.push(2, frame(1000));
  jb.push(4, frame(4000));              // seq 3 never arrives
  assert.strictEqual(jb.pull()[0], 1000);
  assert.strictEqual(jb.pull()[0], 1000);
  const concealed = jb.pull();
  assert.ok(concealed, 'a frame is always produced');
  assert.strictEqual(concealed.length, 160);
  assert.ok(Math.abs(concealed[0]) < 1000, 'concealment is attenuated');
  assert.strictEqual(jb.pull()[0], 4000);
  assert.ok(jb.stats.lost >= 1);
});

test('jitter buffer drops frames that arrive after their slot played', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 2 });
  jb.push(1, frame(1));
  jb.push(2, frame(2));
  jb.pull(); jb.pull();
  assert.strictEqual(jb.push(1, frame(9)), false);
  assert.strictEqual(jb.stats.late, 1);
});

test('jitter buffer counts duplicates once', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 2 });
  jb.push(5, frame(1));
  assert.strictEqual(jb.push(5, frame(1)), false);
  assert.strictEqual(jb.stats.duplicated, 1);
});

test('jitter buffer survives sequence number wraparound', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 2 });
  jb.push(65534, frame(1));
  jb.push(65535, frame(2));
  jb.push(0, frame(3));
  jb.push(1, frame(4));
  assert.deepStrictEqual([jb.pull()[0], jb.pull()[0], jb.pull()[0], jb.pull()[0]], [1, 2, 3, 4]);
  assert.strictEqual(jb.stats.lost, 0);
});

test('jitter buffer bounds its depth under a burst', () => {
  const jb = new JitterBuffer({ frameSamples: 160, targetFrames: 3, maxFrames: 8 });
  for (let i = 0; i < 40; i++) jb.push(i, frame(i));
  assert.ok(jb.depth <= 8, `depth ${jb.depth}`);
  assert.ok(jb.stats.overflow > 0);
});

// ---- mixer -----------------------------------------------------------------

/** Minimal RtpSession stand-in that records what was sent to it. */
function fakeSession(inboundValue) {
  return {
    inboundValue,
    sent: [],
    pullFrame() { return this.inboundValue === null ? null : frame(this.inboundValue); },
    sendFrame(pcm) { this.sent.push(pcm === null ? null : pcm[0]); },
    lastSent() { return this.sent[this.sent.length - 1]; },
  };
}

test('mixer: a single active leg hears the microphone only', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(500);
  mixer.addLeg('a', a, 'active');
  const speaker = mixer.tick(frame(100));
  assert.strictEqual(a.lastSent(), 100, 'leg receives mic audio');
  assert.strictEqual(speaker[0], 500, 'speaker hears the leg');
});

test('mixer: conference is mix-minus — nobody hears themselves', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(500);
  const b = fakeSession(700);
  mixer.addLeg('a', a, 'conference');
  mixer.addLeg('b', b, 'conference');

  const speaker = mixer.tick(frame(100));

  assert.strictEqual(a.lastSent(), 100 + 700, 'A hears mic + B, not itself');
  assert.strictEqual(b.lastSent(), 100 + 500, 'B hears mic + A, not itself');
  assert.strictEqual(speaker[0], 500 + 700, 'local user hears both parties');
});

test('mixer: dropping the third party leaves the other call intact', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(500);
  const b = fakeSession(700);
  mixer.addLeg('a', a, 'conference');
  mixer.addLeg('b', b, 'conference');
  mixer.tick(frame(100));

  // Hang up on B only.
  mixer.removeLeg('b');
  mixer.setLegMode('a', 'active');
  const speaker = mixer.tick(frame(100));

  assert.strictEqual(a.lastSent(), 100, 'A now hears only the mic');
  assert.strictEqual(speaker[0], 500, 'local user still hears A');
  assert.deepStrictEqual(mixer.conferenceMembers(), []);
});

test('mixer: an idle (held) leg is silent in both directions', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(500);
  const b = fakeSession(700);
  mixer.addLeg('a', a, 'active');
  mixer.addLeg('b', b, 'idle');

  const speaker = mixer.tick(frame(100));

  assert.strictEqual(speaker[0], 500, 'held leg is not in the speaker mix');
  assert.strictEqual(b.lastSent(), null, 'held leg is sent silence');
  assert.strictEqual(a.lastSent(), 100);
});

test('mixer: muting the microphone removes it from every leg but keeps inbound audio', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(500);
  const b = fakeSession(700);
  mixer.addLeg('a', a, 'conference');
  mixer.addLeg('b', b, 'conference');
  mixer.setMicMuted(true);

  const speaker = mixer.tick(frame(100));

  assert.strictEqual(a.lastSent(), 700, 'A still hears B while we are muted');
  assert.strictEqual(b.lastSent(), 500);
  assert.strictEqual(speaker[0], 1200);
});

test('mixer: three conference members each get the other two', () => {
  const mixer = new AudioMixer();
  const legs = { a: fakeSession(100), b: fakeSession(200), c: fakeSession(400) };
  for (const [id, s] of Object.entries(legs)) mixer.addLeg(id, s, 'conference');

  const speaker = mixer.tick(frame(10));

  assert.strictEqual(legs.a.lastSent(), 10 + 200 + 400);
  assert.strictEqual(legs.b.lastSent(), 10 + 100 + 400);
  assert.strictEqual(legs.c.lastSent(), 10 + 100 + 200);
  assert.strictEqual(speaker[0], 700);
});

test('mixer: an active leg outside the conference stays private', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(100);
  const b = fakeSession(200);
  const c = fakeSession(400);
  mixer.addLeg('a', a, 'conference');
  mixer.addLeg('b', b, 'conference');
  mixer.addLeg('c', c, 'active');       // separate call, not bridged

  mixer.tick(frame(10));

  assert.strictEqual(a.lastSent(), 10 + 200, 'conference members do not hear C');
  assert.strictEqual(c.lastSent(), 10, 'C hears only the mic');
  assert.deepStrictEqual(mixer.conferenceMembers().sort(), ['a', 'b']);
});

test('mixer clamps instead of wrapping on loud sums', () => {
  const mixer = new AudioMixer();
  mixer.addLeg('a', fakeSession(30000), 'conference');
  mixer.addLeg('b', fakeSession(30000), 'conference');
  const speaker = mixer.tick(frame(0));
  assert.strictEqual(speaker[0], 32767, 'clipped, not wrapped to a negative value');
});

test('mixer tolerates a leg with no audio yet', () => {
  const mixer = new AudioMixer();
  const a = fakeSession(null);          // jitter buffer still prebuffering
  const b = fakeSession(300);
  mixer.addLeg('a', a, 'conference');
  mixer.addLeg('b', b, 'conference');
  const speaker = mixer.tick(frame(50));
  assert.strictEqual(speaker[0], 300);
  assert.strictEqual(a.lastSent(), 50 + 300);
  assert.strictEqual(b.lastSent(), 50);
});
