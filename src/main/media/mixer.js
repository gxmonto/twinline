'use strict';
/**
 * Local audio mixer / conference bridge.
 *
 * Every 20 ms the audio engine hands the mixer one frame of microphone PCM.
 * The mixer pulls one frame from each call leg, produces a mix-minus feed for
 * every leg (each party hears everyone except themselves) and returns the
 * frame the local speaker should play.
 *
 * Mixing locally — rather than asking the PBX to bridge — is what lets the
 * user drop a single conference participant while staying connected to the
 * other: legs are independent SIP dialogs that merely share an audio bus.
 *
 * Leg modes:
 *   'idle'       leg exists but carries no audio (ringing, or held)
 *   'active'     two-way between the leg and the local user only
 *   'conference' leg joins the bridge with the local user and other members
 */

const FRAME_SAMPLES = 160;             // 20 ms @ 8 kHz
const INT16_MIN = -32768;
const INT16_MAX = 32767;

class AudioMixer {
  constructor({ frameSamples = FRAME_SAMPLES } = {}) {
    this.frameSamples = frameSamples;
    /** @type {Map<string, {session: object, mode: string, gainIn: number, gainOut: number, level: number}>} */
    this.legs = new Map();
    this.micMuted = false;
    this.micGain = 1;
    this.speakerGain = 1;
    this.micLevel = 0;

    this._silence = new Int16Array(frameSamples);
    this._speaker = new Int32Array(frameSamples);
    this._legOut = new Int32Array(frameSamples);
    this._scratch = new Int16Array(frameSamples);

    // What the last tick heard, for taps such as transcription.
    this.lastMic = null;
    /** @type {Map<string, Int16Array>} audible legs' inbound frames */
    this.lastInbound = new Map();
    /** @type {Map<string, {samples: Int16Array, offset: number}>} tones queued per leg */
    this.tones = new Map();
  }

  /**
   * Play a tone into one leg's outbound audio (and the local speaker) over
   * the coming ticks — used for the "this call is being transcribed" beep.
   */
  queueTone(legId, samples) {
    if (!this.legs.has(legId)) return false;
    this.tones.set(legId, { samples, offset: 0 });
    return true;
  }

  addLeg(id, session, mode = 'idle') {
    this.legs.set(id, { session, mode, gainIn: 1, gainOut: 1, level: 0 });
  }

  removeLeg(id) {
    this.legs.delete(id);
    this.tones.delete(id);
    this.lastInbound.delete(id);
  }

  hasLeg(id) {
    return this.legs.has(id);
  }

  setLegMode(id, mode) {
    const leg = this.legs.get(id);
    if (leg) leg.mode = mode;
  }

  getLegMode(id) {
    const leg = this.legs.get(id);
    return leg ? leg.mode : null;
  }

  setLegGain(id, { gainIn, gainOut } = {}) {
    const leg = this.legs.get(id);
    if (!leg) return;
    if (gainIn != null) leg.gainIn = gainIn;
    if (gainOut != null) leg.gainOut = gainOut;
  }

  setMicMuted(muted) {
    this.micMuted = !!muted;
  }

  /** Ids currently bridged together. */
  conferenceMembers() {
    return [...this.legs.entries()].filter(([, l]) => l.mode === 'conference').map(([id]) => id);
  }

  /**
   * Run one 20 ms cycle.
   *
   * @param {Int16Array|null} micFrame microphone PCM, or null for silence
   * @returns {Int16Array} the frame to play locally
   */
  tick(micFrame) {
    const n = this.frameSamples;
    const mic = (!this.micMuted && micFrame && micFrame.length === n) ? micFrame : this._silence;
    this.micLevel = mic === this._silence ? 0 : rms(mic);

    // 1. Collect one inbound frame per audible leg. Pulling exactly once per
    //    tick is what keeps every leg sample-aligned.
    const inbound = [];
    for (const [id, leg] of this.legs) {
      if (leg.mode === 'idle') {
        // Keep the jitter buffer draining so a resumed leg is not stale.
        leg.session.pullFrame();
        leg.level = 0;
        continue;
      }
      const frame = leg.session.pullFrame();
      leg.level = frame ? rms(frame) : 0;
      inbound.push({ id, leg, frame });
    }

    this.lastMic = mic === this._silence ? null : mic;
    this.lastInbound.clear();
    for (const { id, frame } of inbound) if (frame) this.lastInbound.set(id, frame);

    // 2. Speaker = everything the local user should hear.
    const speaker = this._speaker.fill(0);
    for (const { leg, frame } of inbound) {
      if (!frame) continue;
      const g = leg.gainIn;
      for (let i = 0; i < n; i++) speaker[i] += frame[i] * g;
    }

    // 3. Mix-minus per leg.
    for (const { id, leg, frame } of inbound) {
      const out = this._legOut.fill(0);

      // The local user is on every audible leg.
      for (let i = 0; i < n; i++) out[i] = mic[i] * this.micGain;

      // A queued tone goes to that leg and to the local speaker, so both
      // sides hear the same announcement.
      const tone = this.tones.get(id);
      if (tone) {
        for (let i = 0; i < n && tone.offset < tone.samples.length; i++, tone.offset++) {
          out[i] += tone.samples[tone.offset];
          speaker[i] += tone.samples[tone.offset];
        }
        if (tone.offset >= tone.samples.length) this.tones.delete(id);
      }

      // Conference members additionally hear the other members.
      if (leg.mode === 'conference') {
        for (const other of inbound) {
          if (other.id === id || !other.frame || other.leg.mode !== 'conference') continue;
          const g = other.leg.gainOut;
          for (let i = 0; i < n; i++) out[i] += other.frame[i] * g;
        }
      }

      const encoded = this._scratch;
      for (let i = 0; i < n; i++) encoded[i] = clamp(out[i]);
      leg.session.sendFrame(encoded);
    }

    // 4. Legs that are idle still need RTP flowing (NAT keep-alive, and the
    //    far end expects a stream while on hold).
    for (const [, leg] of this.legs) {
      if (leg.mode === 'idle') leg.session.sendFrame(null);
    }

    const output = new Int16Array(n);
    const sg = this.speakerGain;
    for (let i = 0; i < n; i++) output[i] = clamp(speaker[i] * sg);
    return output;
  }

  /** Per-leg and microphone signal levels, 0..1, for meters in the UI. */
  levels() {
    const out = { mic: this.micLevel, legs: {} };
    for (const [id, leg] of this.legs) out.legs[id] = leg.level;
    return out;
  }
}

function clamp(v) {
  return v > INT16_MAX ? INT16_MAX : v < INT16_MIN ? INT16_MIN : v | 0;
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.min(1, Math.sqrt(sum / frame.length) / 8000);
}

module.exports = { AudioMixer, FRAME_SAMPLES };
