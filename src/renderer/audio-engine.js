'use strict';
/**
 * Renderer-side audio: microphone capture, speaker playback, and the local
 * tones (ringtone, ringback, DTMF feedback).
 *
 * The graph runs at 8 kHz so no resampling is needed between WebAudio and
 * G.711. The browser resamples the physical devices for us.
 */

const FRAME_SAMPLES = 160;

export class RendererAudio {
  constructor() {
    this.context = null;
    this.stream = null;
    this.source = null;
    this.capture = null;
    this.playback = null;
    this.ringContext = null;
    this.ringNodes = null;
    this.started = false;
    this.settings = {
      inputDeviceId: 'default',
      outputDeviceId: 'default',
      ringtoneDeviceId: 'default',
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ringVolume: 0.7,
    };
    this.onFrame = null;
    this.lastError = null;
  }

  applySettings(audioSettings) {
    this.settings = { ...this.settings, ...audioSettings };
  }

  /** Bring up the capture/playback graph. Safe to call repeatedly. */
  async start() {
    if (this.started) return true;

    this.context = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule('worklets/capture-processor.js');
    await this.context.audioWorklet.addModule('worklets/playback-processor.js');

    // Playback first, so incoming audio works even if the mic is refused.
    this.playback = new AudioWorkletNode(this.context, 'playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.playback.connect(this.context.destination);
    await this._applySink();

    try {
      await this._openMicrophone();
    } catch (err) {
      this.lastError = err;
      // Keep going: the user can still hear the far end and fix the device
      // in Settings. The main process sends silence in our place.
    }

    this.started = true;
    if (this.context.state === 'suspended') await this.context.resume();
    return !this.lastError;
  }

  async _openMicrophone() {
    const { inputDeviceId, echoCancellation, noiseSuppression, autoGainControl } = this.settings;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputDeviceId && inputDeviceId !== 'default' ? { exact: inputDeviceId } : undefined,
        echoCancellation,
        noiseSuppression,
        autoGainControl,
        channelCount: 1,
      },
      video: false,
    });

    this.source = this.context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.context, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.capture.port.onmessage = (event) => {
      if (this.onFrame) this.onFrame(new Int16Array(event.data));
    };
    this.source.connect(this.capture);
    this.lastError = null;
  }

  async _applySink() {
    const id = this.settings.outputDeviceId;
    if (!id || id === 'default') return;
    try {
      if (typeof this.context.setSinkId === 'function') await this.context.setSinkId(id);
    } catch (err) {
      this.lastError = err;
    }
  }

  /** Re-open the devices after the user changes them in Settings. */
  async restart() {
    await this.stop();
    return this.start();
  }

  async stop() {
    this.stopRinging();
    if (this.stream) { for (const track of this.stream.getTracks()) track.stop(); this.stream = null; }
    if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect(); this.capture = null; }
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.playback) { this.playback.disconnect(); this.playback = null; }
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    this.started = false;
  }

  /** Queue a decoded frame from the SIP stack for playback. */
  play(arrayBuffer) {
    if (this.playback) this.playback.port.postMessage(arrayBuffer, [arrayBuffer]);
  }

  resetPlayback() {
    if (this.playback) this.playback.port.postMessage({ type: 'reset' });
  }

  setMicrophoneEnabled(enabled) {
    if (this.capture) this.capture.port.postMessage({ type: 'enabled', value: enabled });
  }

  get microphoneReady() {
    return !!this.capture;
  }

  // ---- local tones --------------------------------------------------------

  async _ensureRingContext() {
    if (this.ringContext) return this.ringContext;
    this.ringContext = new AudioContext();
    const id = this.settings.ringtoneDeviceId;
    if (id && id !== 'default' && typeof this.ringContext.setSinkId === 'function') {
      try { await this.ringContext.setSinkId(id); } catch { /* fall back to default */ }
    }
    return this.ringContext;
  }

  /**
   * Ringtone for an incoming call, or ringback while an outgoing call rings.
   * @param {'ring'|'ringback'} kind
   */
  async startRinging(kind = 'ring') {
    // Already ringing this way: leave the cadence alone. Restarting on every
    // state update would reset the pattern and sound like stuttering.
    if (this.ringNodes && this.ringNodes.kind === kind) return;
    await this.stopRinging();

    const ctx = await this._ensureRingContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    // Each pattern is a list of [onSeconds, offSeconds] bursts that repeat.
    // The ringtone is a classic double ring so it reads as "phone" even
    // from another room; ringback is the North American 2 s / 4 s cadence.
    const pattern = kind === 'ringback'
      ? { tones: [440, 480], bursts: [[2.0, 4.0]], level: 0.12 }
      : { tones: [523.25, 659.25], bursts: [[0.4, 0.2], [0.4, 2.0]], level: Math.max(0.02, this.settings.ringVolume) * 0.35 };

    const oscillators = pattern.tones.map((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start();
      return osc;
    });

    const period = pattern.bursts.reduce((sum, [on, off]) => sum + on + off, 0);
    const nodes = { kind, gain, oscillators, timer: null, nextStart: ctx.currentTime + 0.02 };
    this.ringNodes = nodes;

    // Keep roughly two periods scheduled ahead so the cadence never stalls
    // when the renderer is busy or the window is hidden.
    const schedule = () => {
      if (this.ringNodes !== nodes) return;
      while (nodes.nextStart < ctx.currentTime + period * 2) {
        let t = nodes.nextStart;
        for (const [on, off] of pattern.bursts) {
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(pattern.level, t + 0.02);
          gain.gain.setValueAtTime(pattern.level, t + on - 0.02);
          gain.gain.linearRampToValueAtTime(0, t + on);
          t += on + off;
        }
        nodes.nextStart = t;
      }
    };
    schedule();
    nodes.timer = setInterval(schedule, Math.max(250, period * 500));
  }

  get ringingKind() {
    return this.ringNodes ? this.ringNodes.kind : null;
  }

  async stopRinging() {
    if (!this.ringNodes) return;
    const { gain, oscillators, timer } = this.ringNodes;
    this.ringNodes = null;
    clearInterval(timer);
    try {
      gain.gain.cancelScheduledValues(this.ringContext.currentTime);
      gain.gain.setValueAtTime(0, this.ringContext.currentTime);
      for (const osc of oscillators) { osc.stop(); osc.disconnect(); }
      gain.disconnect();
    } catch { /* context may already be closing */ }
  }

  /**
   * Short status tones so the user hears what happened without looking:
   *   'connected' — rising two-note blip when a call is answered
   *   'ended'     — falling two-note blip when a call ends
   *   'busy'      — the familiar busy signal, briefly
   */
  async playCue(kind) {
    const ctx = await this._ensureRingContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);

    const notes = kind === 'connected'
      ? [[660, 0.0, 0.09], [880, 0.1, 0.12]]
      : kind === 'ended'
        ? [[660, 0.0, 0.09], [440, 0.1, 0.14]]
        : [[480, 0.0, 0.25], [620, 0.0, 0.25], [480, 0.5, 0.25], [620, 0.5, 0.25]];

    let end = 0;
    for (const [freq, at, dur] of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.02);
      gain.gain.setValueAtTime(0.09, now + at);
      gain.gain.setValueAtTime(0.09, now + at + dur - 0.02);
      gain.gain.linearRampToValueAtTime(0, now + at + dur);
      end = Math.max(end, at + dur);
    }
    setTimeout(() => gain.disconnect(), (end + 0.2) * 1000);
  }

  /** Short DTMF confirmation tone in the local earpiece. */
  async playDtmfFeedback(digit) {
    const ROWS = { '1': 697, '2': 697, '3': 697, 'A': 697, '4': 770, '5': 770, '6': 770, 'B': 770, '7': 852, '8': 852, '9': 852, 'C': 852, '*': 941, '0': 941, '#': 941, 'D': 941 };
    const COLS = { '1': 1209, '4': 1209, '7': 1209, '*': 1209, '2': 1336, '5': 1336, '8': 1336, '0': 1336, '3': 1477, '6': 1477, '9': 1477, '#': 1477, 'A': 1633, 'B': 1633, 'C': 1633, 'D': 1633 };
    const key = String(digit).toUpperCase();
    if (!(key in ROWS)) return;

    const ctx = await this._ensureRingContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    gain.connect(ctx.destination);

    for (const freq of [ROWS[key], COLS[key]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.13);
    }
    setTimeout(() => gain.disconnect(), 300);
  }

  /** Enumerate devices; requires permission to have been granted once. */
  static async devices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs: all.filter((d) => d.kind === 'audioinput').map(toDevice),
        outputs: all.filter((d) => d.kind === 'audiooutput').map(toDevice),
      };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }
}

function toDevice(d) {
  return { id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : 'Unnamed device') };
}

export { FRAME_SAMPLES };
