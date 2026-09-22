'use strict';
/**
 * Audio engine: owns the mixer, every call leg's RTP session, and the 20 ms
 * clock that drives them.
 *
 * The clock lives here rather than being driven by microphone callbacks so
 * that RTP keeps flowing even when the renderer is slow, the microphone is
 * unavailable, or the window is hidden and the browser throttles timers.
 * Microphone frames arrive over IPC into a short queue; speaker frames are
 * pushed back the same way into the renderer's playback ring buffer.
 */

const { EventEmitter } = require('events');
const { AudioMixer } = require('./mixer');
const { RtpSession } = require('../rtp/session');

const FRAME_MS = 20;
const FRAME_SAMPLES = 160;
const MAX_MIC_QUEUE = 5;               // 100 ms; beyond this we are drifting

class AudioEngine extends EventEmitter {
  constructor({ frameSamples = FRAME_SAMPLES, portRange = [16384, 32766] } = {}) {
    super();
    this.frameSamples = frameSamples;
    this.portRange = portRange;
    this.mixer = new AudioMixer({ frameSamples });
    /** @type {Map<string, RtpSession>} */
    this.sessions = new Map();

    this.micQueue = [];
    this.running = false;
    this._timer = null;
    this._nextTick = 0;
    this._levelCounter = 0;
    this.stats = { ticks: 0, micUnderruns: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._nextTick = Date.now() + FRAME_MS;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule() {
    if (!this.running) return;
    const delay = Math.max(0, this._nextTick - Date.now());
    this._timer = setTimeout(() => {
      this._nextTick += FRAME_MS;
      // If we fell badly behind (machine suspended, GC pause), resynchronise
      // rather than running a burst of catch-up ticks.
      if (Date.now() - this._nextTick > 200) this._nextTick = Date.now() + FRAME_MS;
      try { this._tick(); } catch (err) { this.emit('error', err); }
      this._schedule();
    }, delay);
  }

  _tick() {
    const mic = this.micQueue.length ? this.micQueue.shift() : null;
    if (!mic && this.mixer.legs.size) this.stats.micUnderruns++;
    this.stats.ticks++;

    const speaker = this.mixer.tick(mic);
    if (this.mixer.legs.size) this.emit('speaker', speaker);

    // Report levels ~10 times a second, not 50.
    if (++this._levelCounter >= 5) {
      this._levelCounter = 0;
      if (this.mixer.legs.size) this.emit('levels', this.mixer.levels());
    }
  }

  /** Accept a 20 ms microphone frame from the renderer. */
  pushMicFrame(int16) {
    if (!int16 || int16.length !== this.frameSamples) return;
    this.micQueue.push(int16);
    while (this.micQueue.length > MAX_MIC_QUEUE) this.micQueue.shift();
  }

  /** Create and bind an RTP session for a call leg. */
  async createLeg(callId, { localAddress = '0.0.0.0' } = {}) {
    if (this.sessions.has(callId)) return this.sessions.get(callId);
    const session = new RtpSession({
      localAddress,
      frameSamples: this.frameSamples,
      portRange: this.portRange,
    });
    await session.open();
    session.on('dtmf', (digit) => this.emit('dtmf', callId, digit));
    session.on('error', (err) => this._reportError(err, callId));
    this.sessions.set(callId, session);
    this.mixer.addLeg(callId, session, 'idle');
    this.start();
    return session;
  }

  /**
   * Media errors tend to repeat across every leg while a condition lasts
   * (say, the network is gone). Surface each error code at most once per
   * 30 seconds; the sessions keep their own counts in stats.
   */
  _reportError(err, callId) {
    const code = err.code || err.message;
    const now = Date.now();
    this._errorSeen ??= new Map();
    const last = this._errorSeen.get(code) || 0;
    if (now - last < 30000) return;
    this._errorSeen.set(code, now);
    this.emit('error', err, callId);
  }

  getLeg(callId) {
    return this.sessions.get(callId) || null;
  }

  releaseLeg(callId) {
    const session = this.sessions.get(callId);
    if (session) { session.close(); this.sessions.delete(callId); }
    this.mixer.removeLeg(callId);
    if (!this.sessions.size) {
      this.micQueue.length = 0;
      this.stop();
    }
  }

  setLegMode(callId, mode) {
    this.mixer.setLegMode(callId, mode);
  }

  setMicMuted(muted) {
    this.mixer.setMicMuted(muted);
    for (const session of this.sessions.values()) session.setMuted(muted);
  }

  setSpeakerGain(gain) {
    this.mixer.speakerGain = gain;
  }

  setMicGain(gain) {
    this.mixer.micGain = gain;
  }

  conferenceMembers() {
    return this.mixer.conferenceMembers();
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.releaseLeg(id);
    this.stop();
  }
}

module.exports = { AudioEngine, FRAME_MS, FRAME_SAMPLES };
