'use strict';
/**
 * End-to-end tests: two complete user agents signalling to each other over
 * loopback UDP, exchanging real RTP, and exercising hold and conference.
 *
 * No SIP server is involved — each UA points its "domain" at the other's
 * port and registration is off, so these run anywhere.
 */

const test = require('node:test');
const assert = require('node:assert');

const { AudioEngine } = require('../src/main/media/engine');
const { UserAgent } = require('../src/main/sip/useragent');
const { CallManager } = require('../src/main/callmanager');

const BASE_PORT = 45060 + (process.pid % 200) * 4;

function waitFor(predicate, { timeout = 5000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      let value;
      try { value = predicate(); } catch (err) { reject(err); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeout) { reject(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function accountConfig(id, localPort, peerPort, overrides = {}) {
  return {
    id,
    label: id,
    enabled: true,
    displayName: id,
    username: id,
    authUsername: id,
    password: '',
    domain: `127.0.0.1:${peerPort}`,
    outboundProxy: '',
    transport: 'UDP',
    localPort,
    register: false,
    keepAliveSeconds: 0,
    codecs: ['PCMU', 'PCMA'],
    dtmfMode: 'rfc2833',
    holdDirection: 'sendonly',
    publicAddress: '',
    ...overrides,
  };
}

/** Build a pair of UAs that can call each other, on a shared audio engine. */
async function makePair(portOffset, overridesA = {}, overridesB = {}) {
  const portA = BASE_PORT + portOffset;
  const portB = BASE_PORT + portOffset + 1;
  const audio = new AudioEngine({ portRange: [17000 + portOffset * 20, 17000 + portOffset * 20 + 18] });

  const alice = new UserAgent(accountConfig('alice', portA, portB, overridesA), audio);
  const bob = new UserAgent(accountConfig('bob', portB, portA, overridesB), audio);
  await alice.start();
  await bob.start();

  const incoming = [];
  bob.on('call', (call) => incoming.push(call));
  alice.on('call', (call) => incoming.push(call));

  return {
    audio,
    alice,
    bob,
    incoming,
    async teardown() {
      await alice.stop({ unregister: false }).catch(() => {});
      await bob.stop({ unregister: false }).catch(() => {});
      audio.closeAll();
    },
  };
}

/** Place a call from `from` to `to` and answer it. Returns both legs. */
async function connectedPair(env, { from = env.alice, dial = 'bob' } = {}) {
  const before = env.incoming.length;
  const outgoing = await from.dial(dial);
  const inbound = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== outgoing && c.state === 'incoming'),
    { label: 'incoming call' },
  );
  await inbound.accept();
  await waitFor(() => outgoing.state === 'connected' && inbound.state === 'connected',
    { label: 'both legs connected' });
  return { outgoing, inbound };
}

test('a call completes: INVITE, 180, 200, ACK', async (t) => {
  const env = await makePair(0);
  t.after(() => env.teardown());

  const states = [];
  const before = env.incoming.length;
  const outgoing = await env.alice.dial('bob');
  outgoing.on('state', (s) => states.push(s));

  const inbound = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== outgoing && c.state === 'incoming'),
    { label: 'incoming call' });

  assert.strictEqual(inbound.direction, 'in');
  assert.strictEqual(inbound.remoteNumber, 'alice');
  assert.strictEqual(inbound.remoteDisplayName, 'alice');
  await waitFor(() => outgoing.state === 'ringing', { label: '180 Ringing' });

  await inbound.accept();
  await waitFor(() => outgoing.state === 'connected' && inbound.state === 'connected',
    { label: 'connected' });

  // The dialog is fully formed on both sides.
  assert.strictEqual(outgoing.callId, inbound.callId);
  assert.strictEqual(outgoing.localTag, inbound.remoteTag);
  assert.strictEqual(outgoing.remoteTag, inbound.localTag);
  assert.ok(outgoing.answeredAt && inbound.answeredAt);

  // The ACK reached the answering side, so it stopped retransmitting the 200.
  await waitFor(() => inbound.ackReceived === true, { label: 'ACK received' });
  assert.deepStrictEqual(states, ['ringing', 'connected']);
});

test('codecs are negotiated and RTP flows both ways', async (t) => {
  const env = await makePair(4);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  assert.strictEqual(outgoing.negotiated.codec.name, 'PCMU');
  assert.strictEqual(inbound.negotiated.codec.name, 'PCMU');

  await sleep(400);

  assert.ok(outgoing.rtp.stats.packetsSent > 5, `sent ${outgoing.rtp.stats.packetsSent}`);
  assert.ok(outgoing.rtp.stats.packetsReceived > 5, `received ${outgoing.rtp.stats.packetsReceived}`);
  assert.ok(inbound.rtp.stats.packetsReceived > 5, `peer received ${inbound.rtp.stats.packetsReceived}`);
  assert.strictEqual(outgoing.rtp.stats.unknownPt, 0, 'no unrecognised payload types');
  // Symmetric RTP latched onto the real source address.
  assert.ok(outgoing.rtp.latched);
});

test('A-law is chosen when both sides prefer it', async (t) => {
  const env = await makePair(8, { codecs: ['PCMA', 'PCMU'] }, { codecs: ['PCMA', 'PCMU'] });
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  assert.strictEqual(outgoing.negotiated.codec.name, 'PCMA');
  assert.strictEqual(inbound.negotiated.codec.name, 'PCMA');
  assert.strictEqual(outgoing.rtp.sendPayloadType, 8);
});

test('hold and resume: the peer sees it, and recvonly is not misread as their hold', async (t) => {
  const env = await makePair(12);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);

  await outgoing.hold();
  await waitFor(() => inbound.remoteHold === true, { label: 'peer notices the hold' });

  assert.strictEqual(outgoing.localHold, true);
  // The peer answered `a=recvonly`; that is compliance, not them holding us.
  assert.strictEqual(outgoing.remoteHold, false, 'recvonly answer must not look like a remote hold');
  assert.strictEqual(inbound.localHold, false);

  // We advertised sendonly, so our stream keeps flowing (silence, and it
  // holds the NAT binding open); the mixer is what stops feeding it the mic.
  assert.strictEqual(outgoing.rtp.sending, true);
  assert.strictEqual(env.audio.mixer.getLegMode(outgoing.id), 'idle');
  assert.strictEqual(outgoing.rtp.receiving, false, 'we stop listening to a call we put on hold');
  // The held party was told sendonly, so it stops transmitting to us.
  assert.strictEqual(inbound.rtp.sending, false);

  await outgoing.unhold();
  await waitFor(() => inbound.remoteHold === false, { label: 'peer notices the resume' });
  assert.strictEqual(outgoing.localHold, false);
  assert.strictEqual(outgoing.remoteHold, false);
  assert.strictEqual(outgoing.rtp.sending, true);
  assert.strictEqual(outgoing.rtp.receiving, true);
  assert.strictEqual(inbound.rtp.sending, true);
  assert.strictEqual(env.audio.mixer.getLegMode(outgoing.id), 'active');
});

test('both sides holding each other resolves to inactive', async (t) => {
  const env = await makePair(16);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  await outgoing.hold();
  await waitFor(() => inbound.remoteHold === true, { label: 'first hold' });

  await inbound.hold();
  await waitFor(() => outgoing.remoteHold === true, { label: 'second hold seen as inactive' });
  assert.strictEqual(outgoing.localHold, true);
  assert.strictEqual(inbound.localHold, true);
});

test('BYE tears down both sides', async (t) => {
  const env = await makePair(20);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  const portBefore = outgoing.rtp.localPort;
  assert.ok(portBefore > 0);

  await outgoing.hangup();
  await waitFor(() => inbound.state === 'terminated', { label: 'peer sees the BYE' });

  assert.strictEqual(outgoing.state, 'terminated');
  assert.strictEqual(inbound.endReason, 'remote');
  assert.strictEqual(outgoing.endReason, 'local');
  // Media sockets are released.
  assert.strictEqual(env.audio.getLeg(outgoing.id), null);
  assert.strictEqual(env.audio.getLeg(inbound.id), null);
});

test('declining an incoming call reports busy to the caller', async (t) => {
  const env = await makePair(24);
  t.after(() => env.teardown());

  const before = env.incoming.length;
  const outgoing = await env.alice.dial('bob');
  const inbound = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== outgoing && c.state === 'incoming'),
    { label: 'incoming call' });

  inbound.reject(486);
  await waitFor(() => outgoing.state === 'terminated', { label: 'caller sees 486' });
  assert.strictEqual(outgoing.endStatus, 486);
  assert.strictEqual(outgoing.endReason, 'busy');
});

test('a ringing call can be redirected elsewhere with 302 without answering', async (t) => {
  const env = await makePair(72);
  t.after(() => env.teardown());

  const before = env.incoming.length;
  const outgoing = await env.alice.dial('bob');
  const inbound = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== outgoing && c.state === 'incoming'),
    { label: 'incoming call' });

  inbound.deflect('9001');
  assert.strictEqual(inbound.state, 'terminated');
  assert.strictEqual(inbound.endReason, 'redirected');
  await waitFor(() => outgoing.state === 'terminated', { label: 'caller sees the 302' });
  assert.strictEqual(outgoing.endStatus, 302, 'the caller received Moved Temporarily');
  // Only a ringing incoming call can be redirected.
  assert.throws(() => outgoing.deflect('9001'), /ringing incoming/);
});

test('a conference focus (;isfocus) and a "Conference" identity are recognised', async (t) => {
  const env = await makePair(76);
  t.after(() => env.teardown());
  const P = require('../src/main/sip/parser');

  const { outgoing, inbound } = await connectedPair(env);
  assert.strictEqual(outgoing.hostedConference, false);

  // A re-INVITE from the peer whose Contact says it is a conference focus.
  const reinvite = P.parse([
    'INVITE sip:x SIP/2.0', 'Via: SIP/2.0/UDP h;branch=z9hG4bKf', `Call-ID: ${outgoing.callId}`,
    'CSeq: 99 INVITE', 'From: "Conference 8000" <sip:bob@127.0.0.1>;tag=x', 'To: <sip:alice@127.0.0.1>;tag=y',
    'Contact: <sip:conf@127.0.0.1>;isfocus', 'Content-Length: 0', '', '',
  ].join('\r\n'));
  outgoing._absorbDialogState(reinvite, false);
  assert.strictEqual(outgoing.hostedConference, true);
  assert.strictEqual(outgoing.remoteDisplayName, 'Conference 8000');
  assert.strictEqual(outgoing.toJSON().hostedConference, true);
  assert.strictEqual(inbound.hostedConference, false, 'the other leg is unaffected');
});

test('the callee hanging up first also tears down cleanly', async (t) => {
  const env = await makePair(28);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  await inbound.hangup();
  await waitFor(() => outgoing.state === 'terminated', { label: 'caller sees the BYE' });
  assert.strictEqual(outgoing.endReason, 'remote');
});

test('RFC 4733 DTMF reaches the far end', async (t) => {
  const env = await makePair(32);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  assert.notStrictEqual(outgoing.rtp.telephoneEventPt, null, 'telephone-event was negotiated');

  const received = [];
  inbound.rtp.on('dtmf', (digit) => received.push(digit));

  outgoing.sendDtmf('5');
  await waitFor(() => received.length >= 1, { label: 'DTMF 5' });
  assert.strictEqual(received[0], '5');

  // The audio clock keeps running after the tone.
  const after = outgoing.rtp.stats.packetsSent;
  await sleep(120);
  assert.ok(outgoing.rtp.stats.packetsSent > after, 'audio resumes after the tone');
});

test('two simultaneous calls: answering the second holds the first', async (t) => {
  const env = await makePair(36);
  t.after(() => env.teardown());

  const manager = new CallManager({ audio: env.audio, maxCalls: 4 });
  manager.accounts.set('alice', env.alice);
  env.alice.on('call', (call) => manager._trackCall(call));

  // Call 1: alice -> bob
  const first = await connectedPair(env);
  manager._trackCall(first.outgoing);
  env.audio.setLegMode(first.outgoing.id, 'active');

  // Call 2: bob -> alice, answered through the manager.
  const before = env.incoming.length;
  const bobOutgoing = await env.bob.dial('alice');
  const aliceInbound = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'second incoming call' });

  await manager.answer(aliceInbound.id);
  await waitFor(() => first.outgoing.localHold === true, { label: 'first call auto-held' });

  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'idle');
  assert.strictEqual(env.audio.mixer.getLegMode(aliceInbound.id), 'active');
  assert.strictEqual(aliceInbound.state, 'connected');

  // Swapping back holds the second and resumes the first.
  await manager.setActive(first.outgoing.id);
  await waitFor(() => first.outgoing.localHold === false, { label: 'first call resumed' });
  assert.strictEqual(aliceInbound.localHold, true);
  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'active');
});

test('conference: bridge two calls, then drop only the third party', async (t) => {
  const env = await makePair(40);
  t.after(() => env.teardown());

  const manager = new CallManager({ audio: env.audio, maxCalls: 4 });
  manager.accounts.set('alice', env.alice);

  const first = await connectedPair(env);
  manager._trackCall(first.outgoing);
  env.audio.setLegMode(first.outgoing.id, 'active');

  const before = env.incoming.length;
  const bobOutgoing = await env.bob.dial('alice');
  const second = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'second incoming call' });
  manager._trackCall(second);
  await manager.answer(second.id);

  // Bridge them.
  await manager.conference([first.outgoing.id, second.id]);
  assert.deepStrictEqual(
    manager.audio.conferenceMembers().sort(),
    [first.outgoing.id, second.id].sort());
  assert.strictEqual(first.outgoing.localHold, false, 'conference members are taken off hold');
  assert.strictEqual(second.localHold, false);

  await sleep(200);
  assert.ok(first.outgoing.rtp.stats.packetsSent > 5);
  assert.ok(second.rtp.stats.packetsSent > 5);

  // Drop one party only.
  await manager.hangupConferenceParty(second.id);
  await waitFor(() => second.state === 'terminated', { label: 'third party dropped' });

  assert.strictEqual(first.outgoing.state, 'connected', 'the other call survives');
  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'active',
    'the survivor becomes an ordinary active call');
  assert.deepStrictEqual(manager.audio.conferenceMembers(), []);
  assert.strictEqual(bobOutgoing.state, 'terminated', 'the dropped peer was really hung up on');

  // And the surviving call still carries audio.
  const sentBefore = first.outgoing.rtp.stats.packetsSent;
  await sleep(150);
  assert.ok(first.outgoing.rtp.stats.packetsSent > sentBefore);
});

test('conference: holding one member keeps the conference; Resume rejoins them', async (t) => {
  const env = await makePair(52);
  t.after(() => env.teardown());

  const manager = new CallManager({ audio: env.audio, maxCalls: 4 });
  manager.accounts.set('alice', env.alice);

  const first = await connectedPair(env);
  manager._trackCall(first.outgoing);

  const before = env.incoming.length;
  const bobOutgoing = await env.bob.dial('alice');
  const second = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'second incoming call' });
  manager._trackCall(second);
  await manager.answer(second.id);
  await manager.conference([first.outgoing.id, second.id]);
  assert.strictEqual(manager.conferenceRunning, true);

  // Hold one member from inside the conference.
  await manager.holdConferenceParty(second.id);
  await waitFor(() => second.localHold === true, { label: 'member held' });

  assert.strictEqual(manager.conferenceRunning, true, 'the conference survives a member being held');
  assert.deepStrictEqual([...manager.conferenceIds].sort(), [first.outgoing.id, second.id].sort());
  assert.strictEqual(second.conferenceMember, true, 'the held party is still a member');
  assert.strictEqual(env.audio.mixer.getLegMode(second.id), 'idle');
  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'conference',
    'the remaining member keeps talking');
  assert.strictEqual(first.outgoing.localHold, false);

  // Resume puts them straight back into the bridge — no "Conference" click.
  await manager.resumeConferenceParty(second.id);
  await waitFor(() => second.localHold === false, { label: 'member resumed' });
  assert.strictEqual(env.audio.mixer.getLegMode(second.id), 'conference');
  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'conference');
  assert.deepStrictEqual(env.audio.conferenceMembers().sort(), [first.outgoing.id, second.id].sort());

  // The generic Resume path behaves the same for a member.
  await manager.hold(second.id);
  await waitFor(() => second.localHold === true, { label: 'held again' });
  await manager.unhold(second.id);
  await waitFor(() => second.localHold === false, { label: 'resumed again' });
  assert.strictEqual(env.audio.mixer.getLegMode(second.id), 'conference');
  assert.strictEqual(first.outgoing.localHold, false, 'resuming a member never holds the others');
});

test('conference: answering another call holds the conference as a unit, and Resume brings it all back', async (t) => {
  const env = await makePair(56);
  t.after(() => env.teardown());

  const manager = new CallManager({ audio: env.audio, maxCalls: 4 });
  manager.accounts.set('alice', env.alice);

  const first = await connectedPair(env);
  manager._trackCall(first.outgoing);

  let before = env.incoming.length;
  let bobOutgoing = await env.bob.dial('alice');
  const second = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'second incoming call' });
  manager._trackCall(second);
  await manager.answer(second.id);
  await manager.conference([first.outgoing.id, second.id]);

  // A third call comes in and is answered.
  before = env.incoming.length;
  bobOutgoing = await env.bob.dial('alice');
  const third = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'third incoming call' });
  manager._trackCall(third);
  await manager.answer(third.id);
  await waitFor(() => first.outgoing.localHold && second.localHold, { label: 'conference held' });

  assert.strictEqual(manager.conferenceRunning, true, 'membership is kept while held');
  assert.strictEqual(env.audio.mixer.getLegMode(third.id), 'active');

  // Resuming any member swaps back to the whole conference.
  await manager.unhold(first.outgoing.id);
  await waitFor(() => !first.outgoing.localHold && !second.localHold && third.localHold,
    { label: 'conference resumed, third held' });
  assert.deepStrictEqual(env.audio.conferenceMembers().sort(), [first.outgoing.id, second.id].sort());
  assert.strictEqual(env.audio.mixer.getLegMode(third.id), 'idle');
});

test('conference: removing a party holds them instead of hanging up', async (t) => {
  const env = await makePair(44);
  t.after(() => env.teardown());

  const manager = new CallManager({ audio: env.audio, maxCalls: 4 });
  manager.accounts.set('alice', env.alice);

  const first = await connectedPair(env);
  manager._trackCall(first.outgoing);
  env.audio.setLegMode(first.outgoing.id, 'active');

  const before = env.incoming.length;
  const bobOutgoing = await env.bob.dial('alice');
  const second = await waitFor(
    () => env.incoming.slice(before).find((c) => c !== bobOutgoing && c.state === 'incoming'),
    { label: 'second incoming call' });
  manager._trackCall(second);
  await manager.answer(second.id);
  await manager.conference([first.outgoing.id, second.id]);

  await manager.removeFromConference(second.id);
  await waitFor(() => second.localHold === true, { label: 'removed party is held' });

  assert.strictEqual(second.state, 'connected', 'still on the line');
  assert.strictEqual(env.audio.mixer.getLegMode(second.id), 'idle');
  assert.strictEqual(env.audio.mixer.getLegMode(first.outgoing.id), 'active');
  assert.deepStrictEqual(manager.audio.conferenceMembers(), []);
});

test('c=0.0.0.0 from the peer is treated as hold, never as a destination', async (t) => {
  const env = await makePair(60);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  const realRemote = { ...inbound.rtp.remote };
  assert.notStrictEqual(realRemote.address, '0.0.0.0');

  const errors = [];
  inbound.rtp.on('error', (err) => errors.push(err));

  // Old-style hold, as Vital/Asterisk-class PBXs still send it.
  const legacyHold = [
    'v=0', 'o=- 1 2 IN IP4 0.0.0.0', 's=-', 'c=IN IP4 0.0.0.0', 't=0 0',
    'm=audio 27780 RTP/AVP 0 101', 'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', '',
  ].join('\r\n');
  assert.strictEqual(inbound._applyRemoteSdp(legacyHold), true);

  assert.strictEqual(inbound.remoteHold, true, 'zero address reads as the peer holding us');
  assert.strictEqual(inbound.rtp.sending, false, 'we stop sending to a peer that will not receive');
  assert.deepStrictEqual(inbound.rtp.remote, realRemote, 'the last real address is kept');

  await sleep(150);
  assert.strictEqual(errors.length, 0, `no send errors: ${errors.map((e) => e.code).join(',')}`);
  assert.strictEqual(inbound.rtp.stats.sendErrors || 0, 0);

  // Resume with a real address restores media.
  const resume = legacyHold.replace('c=IN IP4 0.0.0.0', `c=IN IP4 ${realRemote.address}`)
    .replace('m=audio 27780', `m=audio ${realRemote.port}`);
  inbound._applyRemoteSdp(resume);
  assert.strictEqual(inbound.remoteHold, false);
  assert.strictEqual(inbound.rtp.sending, true);
  assert.strictEqual(outgoing.state, 'connected');
});

test('RTP session refuses an unspecified destination outright', async () => {
  const { RtpSession, isUnspecified } = require('../src/main/rtp/session');
  assert.strictEqual(isUnspecified('0.0.0.0'), true);
  assert.strictEqual(isUnspecified('::'), true);
  assert.strictEqual(isUnspecified('192.0.2.1'), false);

  const session = new RtpSession({ portRange: [18300, 18310] });
  await session.open();
  const errors = [];
  session.on('error', (e) => errors.push(e));
  try {
    session.configure({ remoteAddress: '0.0.0.0', remotePort: 27780 });
    assert.strictEqual(session.remote, null, 'zero address is not stored');
    session.sendFrame(new Int16Array(160));
    await sleep(30);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(session.stats.packetsSent, 0);
  } finally {
    session.close();
  }
});

test('media sockets bind to the wildcard address so an IP change cannot kill them', async (t) => {
  const env = await makePair(64);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  for (const call of [outgoing, inbound]) {
    const bound = call.rtp.socket.address();
    assert.ok(['0.0.0.0', '::'].includes(bound.address), `RTP bound to ${bound.address}, expected wildcard`);
  }
  // The advertised SDP address is still a real one.
  assert.notStrictEqual(env.alice.mediaAdvertisedAddress, '0.0.0.0');
});

test('a network refresh mid-call re-resolves without disturbing the call', async (t) => {
  const env = await makePair(68);
  t.after(() => env.teardown());

  const { outgoing, inbound } = await connectedPair(env);
  const sentBefore = outgoing.rtp.stats.packetsSent;

  await env.alice.refreshNetwork('test');
  await sleep(150);

  assert.strictEqual(outgoing.state, 'connected');
  assert.strictEqual(inbound.state, 'connected');
  assert.ok(outgoing.rtp.stats.packetsSent > sentBefore, 'media keeps flowing through the refresh');
  assert.ok(env.alice.target, 'server address re-resolved');
  // registration is off for these accounts, so state is simply unchanged
  assert.strictEqual(env.alice.registration.state, 'registered');
});

test('an OPTIONS ping is answered', async (t) => {
  const env = await makePair(48);
  t.after(() => env.teardown());

  const P = require('../src/main/sip/parser');
  const { newBranch } = require('../src/main/sip/transaction');
  const request = {
    method: 'OPTIONS',
    uri: `sip:bob@127.0.0.1:${env.bob.localPort}`,
    version: 'SIP/2.0',
    headers: {
      via: [P.stringifyVia({
        transport: 'UDP', host: '127.0.0.1', port: env.alice.localPort,
        params: { branch: newBranch(), rport: null },
      })],
      'max-forwards': ['70'],
      from: ['<sip:alice@127.0.0.1>;tag=probe'],
      to: [`<sip:bob@127.0.0.1>`],
      'call-id': ['options-probe-1'],
      cseq: ['1 OPTIONS'],
    },
    body: '',
  };

  const response = await env.alice.sendRequestWithAuth(request, {
    address: '127.0.0.1', port: env.bob.localPort,
  });
  assert.strictEqual(response.status, 200);
  assert.ok(P.getHeader(response, 'allow').includes('INVITE'));
});
