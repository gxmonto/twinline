'use strict';
/**
 * Main-process side of transcription: owns the worker utility process, taps
 * the audio engine, assembles transcripts and stores them.
 *
 * Channels: the microphone is one shared channel ("you"); each transcribed
 * call has its own remote channel ("caller"). A mic segment is appended to
 * every transcript that is live at that moment, which is exactly right for a
 * conference.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { utilityProcess } = require('electron');
const log = require('../log').child('transcribe');

const FRAME_SAMPLES = 160;

/** 1400 Hz, 400 ms: the conventional "this call is being recorded" beep. */
function consentTone(sampleRate = 8000, ms = 400, level = 0.25) {
  const n = Math.round(sampleRate * ms / 1000);
  const out = new Int16Array(n);
  const ramp = Math.round(sampleRate * 0.02);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    out[i] = Math.round(Math.sin(2 * Math.PI * 1400 * i / sampleRate) * 32767 * level * env);
  }
  return out;
}

class TranscriptionService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../media/engine').AudioEngine} opts.audio
   * @param {import('./models').ModelStore} opts.models
   * @param {string} opts.transcriptsDir
   * @param {string} opts.workerPath      absolute path to worker.js (outside the asar)
   * @param {string} opts.platformDir     directory holding the sherpa-onnx shared libraries
   */
  constructor({ audio, models, transcriptsDir, workerPath, platformDir }) {
    super();
    this.audio = audio;
    this.models = models;
    this.dir = transcriptsDir;
    this.workerPath = workerPath;
    this.platformDir = platformDir;
    this.settings = { model: 'small', language: 'auto', autoStart: false, consentTone: true, threads: 4 };

    this.worker = null;
    this.workerState = 'off';          // off | starting | ready | error
    this.workerError = null;
    this._readyWaiters = [];
    this._closeWaiters = new Map();    // channel id -> resolve

    /** @type {Map<string, object>} live transcripts by call id */
    this.live = new Map();
    this.micUsers = 0;
    this.micOpenedAt = null;
    this._tapping = false;
    this._onFrames = (frames) => this._handleFrames(frames);

    fs.mkdirSync(this.dir, { recursive: true });
  }

  configure(settings) {
    const before = this.settings;
    this.settings = { ...this.settings, ...settings };
    // Model, language or thread changes need a fresh worker; apply when idle.
    if (this.worker && !this.live.size &&
        (before.model !== this.settings.model || before.language !== this.settings.language || before.threads !== this.settings.threads)) {
      this._shutdownWorker();
    }
  }

  get available() {
    return this.models.installed(this.settings.model) && this.models.installed('vad');
  }

  status() {
    return {
      state: this.workerState,
      error: this.workerError,
      available: this.available,
      model: this.settings.model,
      language: this.settings.language,
      autoStart: this.settings.autoStart,
      active: [...this.live.keys()],
    };
  }

  isActive(callId) {
    return this.live.has(callId);
  }

  // ---- worker -------------------------------------------------------------

  _spawnWorker() {
    const env = { ...process.env };
    // The addon's shared libraries live beside it; each platform finds them
    // through its own variable. A fresh process is the only way to set these.
    if (process.platform === 'win32') env.PATH = `${this.platformDir};${env.PATH || ''}`;
    else if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = `${this.platformDir}:${env.DYLD_LIBRARY_PATH || ''}`;
    else env.LD_LIBRARY_PATH = `${this.platformDir}:${env.LD_LIBRARY_PATH || ''}`;

    this.workerState = 'starting';
    this.workerError = null;
    this.emit('status', this.status());
    log.info('starting worker', { worker: this.workerPath, model: this.settings.model, language: this.settings.language });

    const child = utilityProcess.fork(this.workerPath, [], {
      env,
      serviceName: 'TwinLine transcription',
      stdio: 'pipe',
    });
    child.stdout?.on('data', (d) => log.debug(`worker: ${String(d).trim()}`));
    child.stderr?.on('data', (d) => log.warn(`worker: ${String(d).trim()}`));
    child.on('message', (msg) => this._onWorkerMessage(msg));
    child.on('exit', (code) => {
      log.warn('worker exited', { code });
      if (this.worker === child) {
        this.worker = null;
        if (this.workerState !== 'off') {
          this.workerState = 'error';
          this.workerError = this.workerError || `speech engine stopped (exit code ${code})`;
        }
        this._failWaiters(new Error(this.workerError || 'worker exited'));
        for (const id of [...this.live.keys()]) this._finish(id, { aborted: true });
        this.emit('status', this.status());
      }
    });
    this.worker = child;

    const model = this.models.paths(this.settings.model);
    const vad = this.models.paths('vad');
    child.postMessage({
      type: 'init',
      model,
      vadModel: vad.vad,
      language: this.settings.language,
      threads: this.settings.threads,
    });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.workerState = 'ready';
        log.info('worker ready', { sherpa: msg.version });
        for (const w of this._readyWaiters.splice(0)) w.resolve();
        this.emit('status', this.status());
        break;
      case 'error':
        log.error('worker error', msg);
        if (msg.fatal) {
          this.workerState = 'error';
          this.workerError = msg.message;
          this._failWaiters(new Error(msg.message));
          this.emit('status', this.status());
        } else {
          this.emit('warning', msg.message);
        }
        break;
      case 'segment': this._onSegment(msg); break;
      case 'speaking': this._onSpeaking(msg); break;
      case 'closed': {
        const resolve = this._closeWaiters.get(msg.id);
        if (resolve) { this._closeWaiters.delete(msg.id); resolve(); }
        break;
      }
      default: break;
    }
  }

  _failWaiters(err) {
    for (const w of this._readyWaiters.splice(0)) w.reject(err);
    for (const [id, resolve] of this._closeWaiters) { this._closeWaiters.delete(id); resolve(); }
  }

  async _ensureWorker() {
    if (this.workerState === 'ready' && this.worker) return;
    if (!this.available) {
      throw new Error(`The "${this.settings.model}" speech model is not downloaded. Get it in Settings → Transcription.`);
    }
    if (!this.worker || this.workerState === 'error') this._spawnWorker();
    await new Promise((resolve, reject) => {
      this._readyWaiters.push({ resolve, reject });
      setTimeout(() => reject(new Error('speech engine took too long to start')), 60000).unref?.();
    });
  }

  _shutdownWorker() {
    if (!this.worker) return;
    try { this.worker.postMessage({ type: 'shutdown' }); } catch { /* already gone */ }
    const child = this.worker;
    this.worker = null;
    this.workerState = 'off';
    setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 3000).unref?.();
  }

  // ---- audio tap ----------------------------------------------------------

  _setTapping(on) {
    if (on === this._tapping) return;
    this._tapping = on;
    if (on) { this.audio.on('frames', this._onFrames); this.audio.tap(+1); }
    else { this.audio.off('frames', this._onFrames); this.audio.tap(-1); }
  }

  _handleFrames({ mic, legs }) {
    if (!this.worker || this.workerState !== 'ready') return;
    if (this.micUsers > 0 && mic) this.worker.postMessage({ type: 'audio', id: 'mic', samples: mic });
    for (const [callId] of this.live) {
      const frame = legs.get(callId);
      if (frame) this.worker.postMessage({ type: 'audio', id: `${callId}|remote`, samples: frame });
    }
  }

  // ---- transcripts --------------------------------------------------------

  /**
   * Begin transcribing a connected call.
   * @param {object} info { callId, remoteNumber, remoteName, contactName, accountId, answeredAt }
   */
  async start(info) {
    if (this.live.has(info.callId)) return this.live.get(info.callId);
    await this._ensureWorker();

    const record = {
      callId: info.callId,
      accountId: info.accountId,
      remoteNumber: info.remoteNumber,
      remoteName: info.contactName || info.remoteName || null,
      startedAt: Date.now(),
      callAnsweredAt: info.answeredAt || Date.now(),
      model: this.settings.model,
      language: this.settings.language,
      lines: [],
      speaking: { you: false, caller: false },
      finished: false,
      file: null,
    };
    this.live.set(info.callId, record);

    this.worker.postMessage({ type: 'open', id: `${info.callId}|remote`, label: 'caller', inputRate: 8000 });
    if (this.micUsers++ === 0) {
      this.micOpenedAt = Date.now();
      this.worker.postMessage({ type: 'open', id: 'mic', label: 'you', inputRate: 8000 });
    }
    record.remoteOpenedAt = Date.now();
    this._setTapping(true);

    if (this.settings.consentTone) this.audio.injectTone(info.callId, consentTone());

    log.info('transcription started', { call: info.callId.slice(0, 8), remote: info.remoteNumber });
    this.emit('started', this._public(record));
    return record;
  }

  /** Stop transcribing a call; resolves once its last segment is decoded and saved. */
  async stop(callId, { reason = 'stopped' } = {}) {
    const record = this.live.get(callId);
    if (!record || record.stopping) return record ? this._public(record) : null;
    record.stopping = true;

    const waits = [];
    if (this.worker && this.workerState === 'ready') {
      waits.push(this._closeChannel(`${callId}|remote`));
      if (--this.micUsers === 0) waits.push(this._closeChannel('mic'));
    } else {
      this.micUsers = Math.max(0, this.micUsers - 1);
    }
    if (this.micUsers === 0) this._setTapping(false);

    await Promise.all(waits);
    return this._finish(callId, { reason });
  }

  _closeChannel(id) {
    return new Promise((resolve) => {
      this._closeWaiters.set(id, resolve);
      try { this.worker.postMessage({ type: 'close', id }); } catch { resolve(); }
      setTimeout(() => { if (this._closeWaiters.delete(id)) resolve(); }, 30000).unref?.();
    });
  }

  _finish(callId, { reason = 'stopped', aborted = false } = {}) {
    const record = this.live.get(callId);
    if (!record) return null;
    this.live.delete(callId);
    record.finished = true;
    record.endedAt = Date.now();
    record.reason = aborted ? 'engine stopped' : reason;

    if (record.lines.length) {
      record.file = this._save(record);
    }
    if (!this.live.size && this.worker) {
      // Keep the worker warm for a while; models take seconds to load.
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => { if (!this.live.size) this._shutdownWorker(); }, 10 * 60 * 1000);
      this._idleTimer.unref?.();
    }
    log.info('transcription finished', { call: callId.slice(0, 8), lines: record.lines.length, file: record.file && path.basename(record.file) });
    const pub = this._public(record);
    this.emit('finished', pub);
    return pub;
  }

  _onSegment(seg) {
    const isMic = seg.channel === 'mic';
    const absolute = (isMic ? this.micOpenedAt : null);
    const targets = isMic
      ? [...this.live.values()]
      : [this.live.get(seg.channel.split('|')[0])].filter(Boolean);

    for (const record of targets) {
      const openedAt = isMic ? absolute : record.remoteOpenedAt;
      const atMs = Math.max(0, openedAt + seg.startMs - record.callAnsweredAt);
      // A mic utterance that started before this transcript began is not ours.
      if (isMic && openedAt + seg.endMs < record.startedAt) continue;
      const line = {
        n: record.lines.length + 1,
        speaker: isMic ? 'you' : 'caller',
        atMs,
        durationMs: seg.endMs - seg.startMs,
        text: seg.text,
        lang: seg.lang,
        error: seg.error || undefined,
      };
      record.lines.push(line);
      this.emit('line', { callId: record.callId, line });
    }
  }

  _onSpeaking(msg) {
    const isMic = msg.id === 'mic';
    const targets = isMic ? [...this.live.values()] : [this.live.get(msg.id.split('|')[0])].filter(Boolean);
    for (const record of targets) {
      record.speaking[isMic ? 'you' : 'caller'] = msg.speaking;
      this.emit('speaking', { callId: record.callId, speaker: isMic ? 'you' : 'caller', speaking: msg.speaking });
    }
  }

  _public(record) {
    const { speaking, stopping, ...rest } = record;
    return { ...rest, speaking: { ...speaking }, file: record.file ? path.basename(record.file) : null };
  }

  liveTranscript(callId) {
    const record = this.live.get(callId);
    return record ? this._public(record) : null;
  }

  // ---- storage ------------------------------------------------------------

  _save(record) {
    const stamp = new Date(record.startedAt);
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    const who = String(record.remoteNumber || 'unknown').replace(/[^\w+]/g, '') || 'unknown';
    const base = `${when}_${who}_${record.callId.slice(0, 8)}`;
    const json = path.join(this.dir, `${base}.json`);
    const txt = path.join(this.dir, `${base}.txt`);

    const { speaking, stopping, ...toSave } = record;
    fs.writeFileSync(json, JSON.stringify(toSave, null, 2));
    fs.writeFileSync(txt, formatTranscript(toSave));
    return json;
  }

  list() {
    let files;
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files.map((f) => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        return {
          file: f, callId: t.callId, remoteNumber: t.remoteNumber, remoteName: t.remoteName,
          startedAt: t.startedAt, endedAt: t.endedAt, lines: t.lines.length, accountId: t.accountId,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
  }

  read(file) {
    const safe = path.basename(file);
    const full = path.join(this.dir, safe);
    if (!full.startsWith(this.dir) || !fs.existsSync(full)) throw new Error('no such transcript');
    const record = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { ...record, file: safe, text: formatTranscript(record) };
  }

  remove(file) {
    const safe = path.basename(file);
    for (const ext of ['.json', '.txt']) fs.rmSync(path.join(this.dir, safe.replace(/\.json$/, ext)), { force: true });
    return { ok: true };
  }

  /**
   * Self-test: push 8 kHz Int16 PCM through the real worker and return the
   * recognised segments. Used by `--smoke-wav` to prove the utility process,
   * library path and model all work in the packaged app.
   */
  async testAudio(int16At8k) {
    await this._ensureWorker();
    const segments = [];
    const onSeg = (seg) => { if (seg.channel === 'selftest') segments.push(seg); };
    const listener = (msg) => { if (msg.type === 'segment') onSeg(msg); };
    this.worker.on('message', listener);
    try {
      this.worker.postMessage({ type: 'open', id: 'selftest', label: 'test', inputRate: 8000 });
      for (let off = 0; off < int16At8k.length; off += FRAME_SAMPLES) {
        const frame = new Int16Array(FRAME_SAMPLES);
        frame.set(int16At8k.subarray(off, Math.min(off + FRAME_SAMPLES, int16At8k.length)));
        this.worker.postMessage({ type: 'audio', id: 'selftest', samples: frame });
      }
      await this._closeChannel('selftest');
    } finally {
      this.worker.off('message', listener);
    }
    return segments;
  }

  async shutdown() {
    for (const id of [...this.live.keys()]) await this.stop(id, { reason: 'app closing' }).catch(() => {});
    this._shutdownWorker();
  }
}

function formatTranscript(record) {
  const stamp = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const who = record.remoteName ? `${record.remoteName} (${record.remoteNumber})` : record.remoteNumber;
  const head = [
    `TwinLine transcript — call with ${who}`,
    `${new Date(record.startedAt).toLocaleString()}${record.endedAt ? ` – ${new Date(record.endedAt).toLocaleTimeString()}` : ''}`,
    `Model: whisper-${record.model}, language: ${record.language}`,
    '',
  ];
  const body = record.lines.map((l) => `[${stamp(l.atMs)}] ${l.speaker === 'you' ? 'You' : 'Caller'}: ${l.text}`);
  return head.concat(body).join('\n') + '\n';
}

module.exports = { TranscriptionService, consentTone, formatTranscript, FRAME_SAMPLES };
