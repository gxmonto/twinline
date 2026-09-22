'use strict';
/**
 * RTP audio session (RFC 3550) with symmetric-RTP latching, an adaptive
 * jitter buffer and RFC 4733 DTMF.
 *
 * One RtpSession belongs to one call leg. The session does not run its own
 * clock: the audio engine pulls and pushes a frame every 20 ms, which keeps
 * every leg of a conference sample-aligned.
 */

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { JitterBuffer } = require('./jitterbuffer');
const { CODECS } = require('./codecs');

const RTP_VERSION = 2;
const PT_COMFORT_NOISE = 13;

let nextPortHint = 0;

/** Parse an RTP packet. Returns null if it is not plausible RTP. */
function parsePacket(buf) {
  if (buf.length < 12) return null;
  const b0 = buf[0];
  if ((b0 >> 6) !== RTP_VERSION) return null;

  const padding = (b0 >> 5) & 1;
  const extension = (b0 >> 4) & 1;
  const csrcCount = b0 & 0x0f;

  const b1 = buf[1];
  const marker = (b1 >> 7) & 1;
  const payloadType = b1 & 0x7f;

  let offset = 12 + csrcCount * 4;
  if (buf.length < offset) return null;

  if (extension) {
    if (buf.length < offset + 4) return null;
    const words = buf.readUInt16BE(offset + 2);
    offset += 4 + words * 4;
    if (buf.length < offset) return null;
  }

  let end = buf.length;
  if (padding) {
    const padLen = buf[buf.length - 1];
    if (padLen > 0 && padLen <= end - offset) end -= padLen;
  }

  return {
    marker,
    payloadType,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(offset, end),
  };
}

function buildPacket({ payloadType, marker, sequence, timestamp, ssrc, payload }) {
  const header = Buffer.allocUnsafe(12);
  header[0] = RTP_VERSION << 6;
  header[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

class RtpSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.localAddress]
   * @param {number} [opts.frameSamples] samples per 20 ms frame
   * @param {[number, number]} [opts.portRange]
   */
  constructor({
    localAddress = '0.0.0.0',
    frameSamples = 160,
    portRange = [16384, 32766],
    symmetric = true,
  } = {}) {
    super();
    this.localAddress = localAddress;
    this.frameSamples = frameSamples;
    this.portRange = portRange;
    this.symmetric = symmetric;

    this.socket = null;
    this.localPort = null;
    this.remote = null;              // { address, port }
    this.latched = false;

    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sequence = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = crypto.randomBytes(4).readUInt32BE(0);

    this.sendCodec = CODECS.PCMU;
    this.sendPayloadType = 0;
    this.receiveCodecs = { 0: CODECS.PCMU, 8: CODECS.PCMA };
    this.telephoneEventPt = null;
    this.remoteTelephoneEventPt = null;

    this.sending = true;             // false while held (a=recvonly/inactive)
    this.receiving = true;
    this.muted = false;
    this.needMarker = true;

    this.jitter = new JitterBuffer({ frameSamples });
    this.stats = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, unknownPt: 0 };

    this._dtmf = null;
    this._silence = this.sendCodec.silence(frameSamples);
  }

  /** Bind an even UDP port (RTP convention) from the configured range. */
  async open() {
    const [lo, hi] = this.portRange;
    const span = Math.floor((hi - lo) / 2);
    if (nextPortHint === 0) nextPortHint = Math.floor(Math.random() * span);

    for (let attempt = 0; attempt < 60; attempt++) {
      const port = lo + ((nextPortHint + attempt) % span) * 2;
      try {
        this.socket = await bindSocket(this.localAddress, port);
        this.localPort = port;
        nextPortHint = (nextPortHint + attempt + 1) % span;
        break;
      } catch {
        // port in use, try the next even one
      }
    }
    if (!this.socket) throw new Error('no free RTP port available');

    this.socket.on('message', (buf, rinfo) => this._onPacket(buf, rinfo));
    this.socket.on('error', (err) => this.emit('error', err));
    return this;
  }

  /** Configure the negotiated media parameters. */
  configure({ remoteAddress, remotePort, sendCodec, sendPayloadType, telephoneEventPt, remoteTelephoneEventPt, receiveMap }) {
    if (remoteAddress && remotePort && !isUnspecified(remoteAddress)) {
      const changed = !this.remote || this.remote.address !== remoteAddress || this.remote.port !== remotePort;
      this.remote = { address: remoteAddress, port: remotePort };
      if (changed) this.latched = false;
    }
    if (sendCodec) {
      this.sendCodec = sendCodec;
      this._silence = sendCodec.silence(this.frameSamples);
    }
    if (sendPayloadType != null) this.sendPayloadType = sendPayloadType;
    if (telephoneEventPt !== undefined) this.telephoneEventPt = telephoneEventPt;
    if (remoteTelephoneEventPt !== undefined) this.remoteTelephoneEventPt = remoteTelephoneEventPt;
    if (receiveMap) this.receiveCodecs = receiveMap;
    return this;
  }

  /** Set media flow direction, as derived from the negotiated SDP. */
  setDirection({ sending, receiving }) {
    if (sending !== undefined && sending !== this.sending) {
      this.sending = sending;
      this.needMarker = true;
    }
    if (receiving !== undefined && receiving !== this.receiving) {
      this.receiving = receiving;
      if (!receiving) this.jitter.reset();
    }
  }

  setMuted(muted) {
    if (this.muted !== muted) {
      this.muted = muted;
      this.needMarker = true;
    }
  }

  _onPacket(buf, rinfo) {
    const packet = parsePacket(buf);
    if (!packet) return;

    // Symmetric RTP: media often arrives from a different port than the one
    // signalled, especially behind NAT. Latch onto the real source.
    if (this.symmetric && !this.latched) {
      this.remote = { address: rinfo.address, port: rinfo.port };
      this.latched = true;
      this.emit('latched', this.remote);
    }

    this.stats.packetsReceived++;
    this.stats.bytesReceived += buf.length;

    if (packet.payloadType === PT_COMFORT_NOISE) return;

    if (this.remoteTelephoneEventPt != null && packet.payloadType === this.remoteTelephoneEventPt) {
      this._onInboundDtmf(packet);
      return;
    }

    if (!this.receiving) return;

    const codec = this.receiveCodecs[packet.payloadType];
    if (!codec) { this.stats.unknownPt++; return; }

    const pcm = codec.decode(packet.payload);
    if (pcm.length === this.frameSamples) {
      this.jitter.push(packet.sequence, pcm);
    } else {
      // Peer uses a different packetisation; split or pad to our frame size.
      for (let off = 0, n = 0; off < pcm.length; off += this.frameSamples, n++) {
        const slice = pcm.subarray(off, Math.min(off + this.frameSamples, pcm.length));
        const frame = slice.length === this.frameSamples ? slice : padFrame(slice, this.frameSamples);
        this.jitter.push((packet.sequence + n) & 0xffff, frame);
      }
    }
  }

  _onInboundDtmf(packet) {
    if (packet.payload.length < 4) return;
    const event = packet.payload[0];
    const end = (packet.payload[1] & 0x80) !== 0;
    if (!end) return;                                   // report once, at the end
    if (this._lastInboundDtmfTs === packet.timestamp) return;
    this._lastInboundDtmfTs = packet.timestamp;
    this.emit('dtmf', eventToDigit(event));
  }

  /**
   * Pull one frame of decoded remote audio for the mixer.
   * @returns {Int16Array|null} null when there is nothing to play yet
   */
  pullFrame() {
    if (!this.receiving) return null;
    return this.jitter.pull();
  }

  /**
   * Send one frame of audio to the peer. Called every 20 ms by the engine.
   * Silence is still transmitted, which keeps NAT bindings and far-end voice
   * activity detection happy.
   */
  sendFrame(pcm) {
    if (!this.socket || !this.remote || isUnspecified(this.remote.address)) return;

    // A DTMF tone in progress replaces the audio payload for its duration.
    if (this._dtmf) { this._sendDtmfFrame(); return; }

    if (!this.sending) { this.timestamp = (this.timestamp + this.frameSamples) >>> 0; return; }

    const payload = this.muted || !pcm
      ? this._silence
      : this.sendCodec.encode(pcm);

    this._emit(this.sendPayloadType, payload, this.needMarker);
    this.needMarker = false;
    this.timestamp = (this.timestamp + this.frameSamples) >>> 0;
  }

  _emit(payloadType, payload, marker, advanceSeq = true) {
    const packet = buildPacket({
      payloadType,
      marker: !!marker,
      sequence: this.sequence,
      timestamp: this.timestamp,
      ssrc: this.ssrc,
      payload,
    });
    if (advanceSeq) this.sequence = (this.sequence + 1) & 0xffff;
    this.socket.send(packet, this.remote.port, this.remote.address, (err) => {
      if (err) this._reportSendError(err);
    });
    this.stats.packetsSent++;
    this.stats.bytesSent += packet.length;
  }

  /**
   * Send failures repeat 50 times a second while the condition lasts. Report
   * each distinct error once and count the rest.
   */
  _reportSendError(err) {
    this.stats.sendErrors = (this.stats.sendErrors || 0) + 1;
    const code = err.code || err.message;
    if (this._reportedSendErrors?.has(code)) return;
    (this._reportedSendErrors ??= new Set()).add(code);
    this.emit('error', err);
  }

  /**
   * Queue an RFC 4733 DTMF tone. Returns false when the peer did not
   * negotiate telephone-event, so the caller can fall back to SIP INFO.
   */
  sendDtmf(digit, durationMs = 160) {
    if (this.telephoneEventPt == null) return false;
    const event = digitToEvent(digit);
    if (event == null) return false;

    const frames = Math.max(3, Math.round(durationMs / 20));
    this._dtmf = {
      event,
      frames,
      sent: 0,
      endsSent: 0,
      startTimestamp: this.timestamp,
      duration: 0,
    };
    return true;
  }

  _sendDtmfFrame() {
    const d = this._dtmf;
    d.duration += this.frameSamples;

    const payload = Buffer.allocUnsafe(4);
    payload[0] = d.event;
    const ending = d.sent >= d.frames;
    payload[1] = (ending ? 0x80 : 0x00) | 10;      // end bit + volume 10 dBm0
    payload.writeUInt16BE(Math.min(d.duration, 0xffff), 2);

    // Every packet of a tone carries the tone's start timestamp; only the
    // sequence number advances. The three end packets repeat unchanged.
    const saved = this.timestamp;
    this.timestamp = d.startTimestamp;
    this._emit(this.telephoneEventPt, payload, d.sent === 0);
    this.timestamp = saved;

    if (ending) {
      d.endsSent++;
      if (d.endsSent >= 3) {
        // Resume audio after the tone, keeping the RTP clock continuous.
        this.timestamp = (d.startTimestamp + d.duration) >>> 0;
        this._dtmf = null;
        this.needMarker = true;
        return;
      }
    } else {
      d.sent++;
    }
    this.timestamp = (this.timestamp + this.frameSamples) >>> 0;
  }

  get dtmfActive() {
    return this._dtmf !== null;
  }

  close() {
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.jitter.reset();
    this.removeAllListeners();
  }
}

/** 0.0.0.0 / :: are "no address": never a valid RTP destination. */
function isUnspecified(address) {
  return !address || address === '0.0.0.0' || address === '::' || address === '0:0:0:0:0:0:0:0';
}

function bindSocket(address, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: address.includes(':') ? 'udp6' : 'udp4', reuseAddr: false });
    const onError = (err) => { try { socket.close(); } catch { /* noop */ } reject(err); };
    socket.once('error', onError);
    socket.bind(port, address === '0.0.0.0' ? undefined : address, () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

function padFrame(slice, size) {
  const out = new Int16Array(size);
  out.set(slice.subarray(0, Math.min(slice.length, size)));
  return out;
}

const DTMF_EVENTS = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11, 'A': 12, 'B': 13, 'C': 14, 'D': 15 };
const EVENT_DIGITS = Object.fromEntries(Object.entries(DTMF_EVENTS).map(([k, v]) => [v, k]));

function digitToEvent(digit) {
  const key = String(digit).toUpperCase();
  return key in DTMF_EVENTS ? DTMF_EVENTS[key] : null;
}

function eventToDigit(event) {
  return EVENT_DIGITS[event] ?? null;
}

module.exports = { RtpSession, parsePacket, buildPacket, digitToEvent, eventToDigit, isUnspecified };
