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
    /** Called with (message, kind) when a device vanished, came back, or audio was repaired. */
    this.onDeviceEvent = null;
    this.micEnabled = true;
    this.lastFrameAt = 0;
    this._active = { input: null, output: null };   // device ids actually in use
    this._recovering = null;
    this._lastRecoverAt = 0;
    this._guardsInstalled = false;
    this._deviceChangeTimer = null;
    this._watchdog = null;
  }

  // ---- self-healing ------------------------------------------------------
  //
  // Bluetooth headsets are the usual culprit: connecting, disconnecting or
  // flipping between the music and hands-free profiles ends the microphone
  // track and removes the output device the graph was bound to. Nothing in
  // WebAudio repairs that by itself — the app simply went deaf and mute until
  // it was restarted (Mike, 1.4.23). So: watch the devices, the tracks, the
  // context and the frame flow, and rebuild the graph when any of them break.

  _installGuards() {
    if (this._guardsInstalled) return;
    this._guardsInstalled = true;
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(this._deviceChangeTimer);
      // Headsets announce several devices in quick succession; settle first.
      this._deviceChangeTimer = setTimeout(() => this._onDevicesChanged(), 700);
    });
  }

  async _onDevicesChanged() {
    // Always rebuild. With "default" devices the resolved ids never change,
    // yet the old graph stays bound to the physical device that just left or
    // came back (Windows, Bluetooth headset idling off and on — 1.4.29).
    if (this.started) await this._recover('audio devices changed');
  }

  /** The device ids to use now: the configured ones when present, else default. */
  async _resolveDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch { /* no permission yet */ }
    const have = (kind, id) => !id || id === 'default' || list.some((d) => d.kind === kind && d.deviceId === id);
    const { inputDeviceId, outputDeviceId } = this.settings;
    return {
      input: have('audioinput', inputDeviceId) ? (inputDeviceId || 'default') : 'default',
      output: have('audiooutput', outputDeviceId) ? (outputDeviceId || 'default') : 'default',
      inputFellBack: !have('audioinput', inputDeviceId),
      outputFellBack: !have('audiooutput', outputDeviceId),
    };
  }

  /** Rebuild the whole graph once; concurrent triggers share the one rebuild. */
  _recover(reason) {
    if (this._recovering) return this._recovering;
    this._lastRecoverAt = Date.now();
    this._recovering = (async () => {
      try {
        await Promise.race([this.restart(), new Promise((_, rej) => setTimeout(() => rej(new Error('rebuild timed out')), 8000))]);
        const note = this._active.fallbackNote;
        this._report(note ? `Audio reconnected (${reason}); ${note}` : `Audio reconnected (${reason})`, note ? 'warn' : '');
      } catch (err) {
        this._report(`Audio could not be restarted (${reason}): ${err.message}`, 'error');
      } finally {
        this._recovering = null;
      }
    })();
    return this._recovering;
  }

  _report(message, kind = '') {
    if (this.onDeviceEvent) this.onDeviceEvent(message, kind);
  }

  _startWatchdog() {
    clearInterval(this._watchdog);
    this.lastFrameAt = Date.now();
    this._watchdog = setInterval(() => {
      if (!this.started || !this.capture || !this.micEnabled || !this.context) return;
      if (this.context.state === 'suspended') { this.context.resume().catch(() => {}); return; }
      // A live microphone posts a frame every 20 ms. Silence of this length
      // means the track died without saying so (Bluetooth profile switch).
      const quiet = Date.now() - this.lastFrameAt;
      if (quiet > 2500 && Date.now() - this._lastRecoverAt > 6000) this._recover('microphone stopped delivering audio');
    }, 1000);
  }

  applySettings(audioSettings) {
    this.settings = { ...this.settings, ...audioSettings };
  }

  /** Bring up the capture/playback graph. Safe to call repeatedly. */
  async start() {
    if (this.started) return true;
    this._installGuards();

    this.context = new AudioContext({ sampleRate: 8000, latencyHint: 'interactive' });
    this.context.onstatechange = () => {
      // Windows "interrupts" a context when the output device goes away.
      if (this.started && this.context && (this.context.state === 'interrupted' || this.context.state === 'suspended')) {
        this.context.resume().catch(() => this._recover('audio output interrupted'));
      }
    };
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
    this._startWatchdog();
    return !this.lastError;
  }

  async _openMicrophone() {
    const { echoCancellation, noiseSuppression, autoGainControl } = this.settings;
    const want = await this._resolveDevices();
    const inputDeviceId = want.input;
    this._active.input = inputDeviceId;
    this._active.fallbackNote = want.inputFellBack ? 'the chosen microphone is not connected, using the system default' : null;
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
      this.lastFrameAt = Date.now();
      if (this.onFrame) this.onFrame(new Int16Array(event.data));
    };
    this.source.connect(this.capture);
    this.lastError = null;

    // The track tells us when the device goes away; `mute` is also how a
    // Bluetooth profile switch shows up, so a mute that lasts counts too.
    for (const track of this.stream.getAudioTracks()) {
      track.onended = () => this._recover('microphone disconnected');
      track.onmute = () => setTimeout(() => { if (track.muted && this.stream && this.stream.getAudioTracks().includes(track)) this._recover('microphone muted by the system'); }, 1500);
    }
  }

  async _applySink() {
    const want = await this._resolveDevices();
    const id = want.output;
    this._active.output = id;
    if (want.outputFellBack) {
      this._active.fallbackNote = [this._active.fallbackNote, 'the chosen speaker is not connected, using the system default'].filter(Boolean).join('; ');
    }
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
    clearInterval(this._watchdog);
    this._watchdog = null;
    if (this.context) this.context.onstatechange = null;
    this.stopRinging();
    if (this.stream) { for (const track of this.stream.getTracks()) track.stop(); this.stream = null; }
    if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect(); this.capture = null; }
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.playback) { this.playback.disconnect(); this.playback = null; }
    if (this.ringContext === this.context) this.ringContext = null;   // shared; closes below
    if (this.context) { this.context.close().catch(() => {}); this.context = null; }   // not awaited: close() can hang on a vanished device
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
    this.micEnabled = !!enabled;
    this.lastFrameAt = Date.now();          // a muted mic posts nothing; do not mistake that for a dead one
    if (this.capture) this.capture.port.postMessage({ type: 'enabled', value: enabled });
  }

  get microphoneReady() {
    return !!this.capture;
  }

  // ---- local tones --------------------------------------------------------

  /**
   * Where tones play. When the ringtone device is the call device, tones go
   * through the call's own AudioContext: one audio session instead of two, so
   * Windows' "communications" ducking has nothing to lower and levels stay
   * consistent. A separate ringtone device needs its own context.
   */
  async _ensureRingContext() {
    const ringId = this.settings.ringtoneDeviceId || 'default';
    const outId = this.settings.outputDeviceId || 'default';
    const sameDevice = ringId === 'default' || ringId === outId;
    if (sameDevice && this.context && this.context.state !== 'closed') {
      if (this.ringContext && this.ringContext !== this.context) { this.ringContext.close().catch(() => {}); }
      this.ringContext = this.context;
      return this.context;
    }
    if (this.ringContext && this.ringContext !== this.context && this.ringContext.state !== 'closed') return this.ringContext;
    this.ringContext = new AudioContext();
    if (ringId !== 'default' && typeof this.ringContext.setSinkId === 'function') {
      try { await this.ringContext.setSinkId(ringId); } catch { /* fall back to default */ }
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
      : kind === 'waiting'
        // Call waiting: two short soft beeps every few seconds, under the conversation.
        ? { tones: [440], bursts: [[0.18, 0.18], [0.18, 3.5]], level: Math.max(0.02, this.settings.ringVolume) * 0.12 }
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
