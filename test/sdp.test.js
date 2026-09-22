'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SDP = require('../src/main/sip/sdp');
const { preferenceList } = require('../src/main/rtp/codecs');

const OFFER = [
  'v=0',
  'o=- 3842 1 IN IP4 203.0.113.9',
  's=call',
  'c=IN IP4 203.0.113.9',
  't=0 0',
  'm=audio 40012 RTP/AVP 8 0 101',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=fmtp:101 0-16',
  'a=ptime:20',
  'a=sendrecv',
  '',
].join('\r\n');

test('parses an offer', () => {
  const sdp = SDP.parse(OFFER);
  const media = SDP.audioMedia(sdp);
  assert.strictEqual(media.port, 40012);
  assert.deepStrictEqual(media.formats, ['8', '0', '101']);
  assert.strictEqual(media.rtpmap[8].name, 'PCMA');
  assert.strictEqual(media.direction, 'sendrecv');
  assert.strictEqual(media.ptime, 20);
  assert.strictEqual(SDP.mediaAddress(sdp, media), '203.0.113.9');
});

test('media-level c= overrides the session-level one', () => {
  const sdp = SDP.parse(OFFER.replace('m=audio 40012', 'c=IN IP4 198.51.100.4\r\nm=audio 40012'));
  // The media-level line here precedes m=, so it belongs to the session; the
  // real check is that an explicit media-level c= wins.
  const withMediaC = SDP.parse([
    'v=0', 'c=IN IP4 203.0.113.9', 't=0 0',
    'm=audio 5000 RTP/AVP 0', 'c=IN IP4 198.51.100.4', 'a=rtpmap:0 PCMU/8000', '',
  ].join('\r\n'));
  assert.strictEqual(SDP.mediaAddress(withMediaC, SDP.audioMedia(withMediaC)), '198.51.100.4');
  assert.ok(sdp.connection);
});

test('negotiation honours our preference order, not theirs', () => {
  const media = SDP.audioMedia(SDP.parse(OFFER));
  const uFirst = SDP.negotiate(media, preferenceList(['PCMU', 'PCMA']));
  assert.strictEqual(uFirst.codec.name, 'PCMU');
  assert.strictEqual(uFirst.pt, 0);

  const aFirst = SDP.negotiate(media, preferenceList(['PCMA', 'PCMU']));
  assert.strictEqual(aFirst.codec.name, 'PCMA');
  assert.strictEqual(aFirst.pt, 8);
});

test('negotiation falls back to static payload types with no rtpmap', () => {
  const media = SDP.audioMedia(SDP.parse('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 5004 RTP/AVP 0\r\n'));
  const chosen = SDP.negotiate(media, preferenceList(['PCMU']));
  assert.strictEqual(chosen.codec.name, 'PCMU');
  assert.strictEqual(chosen.pt, 0);
});

test('negotiation returns null when nothing is shared', () => {
  const media = SDP.audioMedia(SDP.parse(
    'v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 5004 RTP/AVP 97\r\na=rtpmap:97 opus/48000/2\r\n'));
  assert.strictEqual(SDP.negotiate(media, preferenceList(['PCMU', 'PCMA'])), null);
});

test('finds the telephone-event payload type', () => {
  const media = SDP.audioMedia(SDP.parse(OFFER));
  assert.deepStrictEqual(SDP.findTelephoneEvent(media), { pt: 101, rate: 8000 });
});

test('hold directions are read correctly', () => {
  for (const [direction, expected] of [
    ['sendonly', { remoteSends: true, remoteReceives: false }],
    ['recvonly', { remoteSends: false, remoteReceives: true }],
    ['inactive', { remoteSends: false, remoteReceives: false }],
    ['sendrecv', { remoteSends: true, remoteReceives: true }],
  ]) {
    assert.deepStrictEqual(SDP.directionFlags(direction), expected, direction);
  }
});

test('builds an offer that parses back to the same thing', () => {
  const body = SDP.build({
    address: '192.0.2.10',
    port: 16400,
    codecs: [{ pt: 0, name: 'PCMU', rate: 8000, channels: 1 }],
    direction: 'sendonly',
    telephoneEvent: { pt: 101, rate: 8000 },
  });
  const media = SDP.audioMedia(SDP.parse(body));
  assert.strictEqual(media.port, 16400);
  assert.strictEqual(media.direction, 'sendonly');
  assert.deepStrictEqual(media.formats, ['0', '101']);
  assert.strictEqual(media.rtpmap[101].name, 'telephone-event');
  assert.ok(body.includes('c=IN IP4 192.0.2.10'));
});

test('builds IPv6 SDP with the right address type', () => {
  const body = SDP.build({
    address: '2001:db8::5', port: 16400,
    codecs: [{ pt: 0, name: 'PCMU', rate: 8000, channels: 1 }],
  });
  assert.ok(body.includes('c=IN IP6 2001:db8::5'));
  assert.ok(body.includes('o=- '));
});

test('port 0 signals the stream is off', () => {
  const media = SDP.audioMedia(SDP.parse('v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 0 RTP/AVP 0\r\n'));
  assert.strictEqual(media.port, 0);
});
