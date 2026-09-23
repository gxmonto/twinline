'use strict';
/**
 * Main-process side of transcription: owns the worker utility process, taps
 * the audio engine, assembles transcripts and stores them.
 *
 * Channels: the microphone is one shared channel ("you"). Each transcript has
 * one channel per remote *party* — normally just the call itself, but in a
 * conference every member, so every voice is recognised and labelled. Who the
 * parties are is decided by the CallManager through `participants(callId)`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const log = require('../log').child('transcribe');
const { VoiceClusterer } = require('./voices');

const FRAME_SAMPLES = 160;

class TranscriptionService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../media/engine').AudioEngine} opts.audio
   * @param {import('./models').ModelStore} opts.models
   * @param {string} opts.transcriptsDir
   * @param {string} opts.workerPath      absolute path to worker.js (outside the asar)
   * @param {string} opts.platformDir     directory holding the sherpa-onnx shared libraries
   */
  constructor({ audio, models, transcriptsDir, workerPath, platformDir, fork = null }) {
    super();
    this.audio = audio;
    this.models = models;
    this.dir = transcriptsDir;
    this.workerPath = workerPath;
    this.platformDir = platformDir;
    // Injectable for tests; the real thing is Electron's utilityProcess.fork.
    this.fork = fork || ((modulePath, args, options) => require('electron').utilityProcess.fork(modulePath, args, options));
    this.settings = { model: 'parakeet', language: 'auto', autoStart: false, threads: 0 };
    /** Which calls' audio belongs in a transcript; set by the CallManager. */
    this.participants = (callId) => [{ callId, label: 'Caller' }];
    /** Per-channel counters, so the log can say whether audio ever arrived. */
    this.counters = new Map();

    this.worker = null;
    this.workerState = 'off';          // off | starting | ready | error
    this.workerError = null;
    this._readyWaiters = [];
    this._closeWaiters = new Map();    // channel id -> resolve

    /** @type {Map<string, object>} live transcripts by owning call id */
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

  /** Fetch the small speaker model for installs that predate it. */
  async ensureSpeakerModel() {
    if (this.models.installed('speaker') || !this.available) return;
    await this.models.download('speaker').catch((err) => log.warn('speaker model download failed', err));
    if (this.worker && !this.live.size) this._shutdownWorker();     // reload with voices on
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

  /** The transcript that covers `callId`, as owner or as a conference party. */
  recordFor(callId) {
    const own = this.live.get(callId);
    if (own) return own;
    for (const record of this.live.values()) if (record.parties.has(callId)) return record;
    return null;
  }

  isActive(callId) {
    return this.recordFor(callId) !== null;
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

    const child = this.fork(this.workerPath, [], {
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
    const speaker = this.models.installed('speaker') ? this.models.paths('speaker') : null;
    // Leave two cores for the audio clock and the UI; recognition takes the rest.
    const threads = this.settings.threads > 0 ? this.settings.threads : Math.max(2, Math.min(8, os.cpus().length - 2));
    child.postMessage({
      type: 'init',
      model: { ...model, type: this.models.constructor.entry(this.settings.model).type },
      vadModel: vad.vad,
      speakerModel: speaker ? speaker.speaker : null,
      language: this.settings.language,
      threads,
    });
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.workerState = 'ready';
        this.voicesEnabled = !!msg.voices;
        log.info('worker ready', { sherpa: msg.version, voices: this.voicesEnabled });
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
    if (this.micUsers > 0) {
      this._count('mic', mic);
      if (mic) this.worker.postMessage({ type: 'audio', id: 'mic', samples: mic });
    }
    for (const record of this.live.values()) {
      this._syncParties(record);
      for (const [partyId, party] of record.parties) {
        const frame = legs.get(partyId);
        this._count(party.channel, frame);
        if (frame) this.worker.postMessage({ type: 'audio', id: party.channel, samples: frame });
      }
    }
  }

  _count(id, frame) {
    let c = this.counters.get(id);
    if (!c) { c = { frames: 0, empty: 0, loud: 0 }; this.counters.set(id, c); }
    if (!frame) { c.empty++; return; }
    c.frames++;
    // Cheap loudness: any sample over ~-30 dBFS counts the frame as non-silent.
    for (let i = 0; i < frame.length; i += 8) { if (Math.abs(frame[i]) > 1000) { c.loud++; break; } }
  }

  /**
   * Open a channel for every party the CallManager says belongs in this
   * transcript (conference members join and leave), close the ones that left.
   */
  _syncParties(record) {
    const wanted = this.participants(record.callId);
    const wantedIds = new Set(wanted.map((p) => p.callId));

    for (const p of wanted) {
      const existing = record.parties.get(p.callId);
      if (existing) {
        // Names can arrive later (a contact match, or a conference forming).
        if (p.label && p.label !== existing.label) { existing.label = p.label; record.partyLabels[p.callId] = p.label; }
        continue;
      }
      const channel = `${record.callId}|party:${p.callId}`;
      record.parties.set(p.callId, { label: p.label || 'Caller', channel, openedAt: Date.now(), voices: new VoiceClusterer() });
      record.partyLabels[p.callId] = p.label || 'Caller';
      if (this.worker && this.workerState === 'ready') {
        this.worker.postMessage({ type: 'open', id: channel, label: p.label || 'Caller', inputRate: 8000 });
      }
    }
    for (const [id, party] of [...record.parties]) {
      if (wantedIds.has(id)) continue;
      record.parties.delete(id);
      // Let the worker decode whatever that party said last; no need to wait.
      if (this.worker && this.workerState === 'ready') this.worker.postMessage({ type: 'close', id: party.channel });
    }
  }

  // ---- transcripts --------------------------------------------------------

  /**
   * Begin transcribing a connected call (and, if it is in a conference, the
   * whole conference).
   * @param {object} info { callId, remoteNumber, remoteName, contactName, accountId, answeredAt }
   */
  async start(info) {
    const existing = this.recordFor(info.callId);
    if (existing) return existing;
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
      parties: new Map(),          // partyCallId -> { label, channel, openedAt, voices }
      partyLabels: {},             // partyCallId -> label, kept after a party leaves
      voiceCounts: {},             // partyCallId -> distinct voices heard (>1 means several people)
      speaking: { you: false, caller: false },
      speakingParties: new Set(),
      finished: false,
      file: null,
    };
    this.live.set(info.callId, record);

    this._syncParties(record);
    if (this.micUsers++ === 0) {
      this.micOpenedAt = Date.now();
      this.worker.postMessage({ type: 'open', id: 'mic', label: 'you', inputRate: 8000 });
    }
    this._setTapping(true);

    log.info('transcription started', { call: info.callId.slice(0, 8), remote: info.remoteNumber, parties: [...record.parties.keys()].map((k) => k.slice(0, 8)) });
    this.emit('started', this._public(record));
    return record;
  }

  /**
   * When calls are bridged into a conference, one transcript covers all of
   * them. Keep the earliest and close the others.
   */
  async mergeConference(memberIds) {
    const records = memberIds.map((id) => this.live.get(id)).filter(Boolean)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const extra of records.slice(1)) {
      await this.stop(extra.callId, { reason: 'merged into the conference transcript' });
    }
    if (records[0]) { this._syncParties(records[0]); this.emit('started', this._public(records[0])); }
    return records[0] ? this._public(records[0]) : null;
  }

  /** Stop the transcript covering `callId`; resolves once its last segment is decoded and saved. */
  async stop(callId, { reason = 'stopped' } = {}) {
    const record = this.recordFor(callId);
    if (!record || record.stopping) return record ? this._public(record) : null;
    record.stopping = true;

    const waits = [];
    if (this.worker && this.workerState === 'ready') {
      for (const party of record.parties.values()) waits.push(this._closeChannel(party.channel));
      if (--this.micUsers === 0) waits.push(this._closeChannel('mic'));
    } else {
      this.micUsers = Math.max(0, this.micUsers - 1);
    }
    if (this.micUsers === 0) this._setTapping(false);

    await Promise.all(waits);
    return this._finish(record.callId, { reason });
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
    // Counters answer "did audio from each side reach the engine at all?"
    const audioCounts = { mic: this.counters.get('mic') || null };
    for (const [id, party] of Object.entries(record.partyLabels)) {
      const channel = `${callId}|party:${id}`;
      audioCounts[party] = this.counters.get(channel) || null;
      this.counters.delete(channel);
    }
    log.info('transcription finished', {
      call: callId.slice(0, 8),
      lines: record.lines.length,
      you: record.lines.filter((l) => l.speaker === 'you').length,
      callers: record.lines.filter((l) => l.speaker === 'caller').length,
      audio: audioCounts,
      file: record.file && path.basename(record.file),
    });
    if (!this.live.size) this.counters.delete('mic');

    const pub = this._public(record);
    this.emit('finished', pub);
    return pub;
  }

  /** Which transcript and party a worker channel id belongs to. */
  _resolveChannel(channelId) {
    if (channelId === 'mic') return { mic: true, records: [...this.live.values()] };
    const bar = channelId.indexOf('|party:');
    if (bar === -1) return { mic: false, records: [] };
    const record = this.live.get(channelId.slice(0, bar));
    const partyId = channelId.slice(bar + 7);
    return { mic: false, records: record ? [record] : [], partyId };
  }

  _onSegment(seg) {
    const { mic, records, partyId } = this._resolveChannel(seg.channel);
    for (const record of records) {
      const party = mic ? null : record.parties.get(partyId);
      const openedAt = mic ? this.micOpenedAt : (party ? party.openedAt : record.startedAt);
      const atMs = Math.max(0, openedAt + seg.startMs - record.callAnsweredAt);
      // A mic utterance that started before this transcript began is not ours.
      if (mic && openedAt + seg.endMs < record.startedAt) continue;
      // Several people can speak through one party's stream (a PBX-hosted
      // conference); group their utterances by voice.
      let voice = null;
      if (!mic && party && seg.embedding && seg.embedding.length) {
        const result = party.voices.assign(seg.embedding, seg.endMs - seg.startMs);
        voice = result.voice;
        if (result.isNew && party.voices.count > 1) {
          record.voiceCounts[partyId] = party.voices.count;
          log.info('another voice detected on the line', { call: record.callId.slice(0, 8), party: record.partyLabels[partyId], voices: party.voices.count });
          this.emit('voices', { callId: record.callId, party: record.partyLabels[partyId], voices: party.voices.count });
        }
      }
      const line = {
        n: record.lines.length + 1,
        speaker: mic ? 'you' : 'caller',
        party: mic ? null : (record.partyLabels[partyId] || 'Caller'),
        partyId: mic ? null : partyId,
        voice,
        atMs,
        durationMs: seg.endMs - seg.startMs,
        text: seg.text,
        lang: seg.lang,
        error: seg.error || undefined,
      };
      record.lines.push(line);
      this.emit('line', { callId: record.callId, line, voices: record.voiceCounts });
    }
  }

  _onSpeaking(msg) {
    const { mic, records, partyId } = this._resolveChannel(msg.id);
    for (const record of records) {
      if (mic) record.speaking.you = msg.speaking;
      else {
        if (msg.speaking) record.speakingParties.add(partyId); else record.speakingParties.delete(partyId);
        record.speaking.caller = record.speakingParties.size > 0;
      }
      this.emit('speaking', {
        callId: record.callId,
        speaker: mic ? 'you' : 'caller',
        party: mic ? null : record.partyLabels[partyId],
        speaking: mic ? msg.speaking : record.speaking.caller,
      });
    }
  }

  _public(record) {
    const { speaking, speakingParties, stopping, parties, ...rest } = record;
    return {
      ...rest,
      speaking: { ...speaking },
      parties: [...parties.values()].map((p) => p.label),
      voiceCounts: { ...record.voiceCounts },
      file: record.file ? path.basename(record.file) : null,
    };
  }

  liveTranscript(callId) {
    const record = this.recordFor(callId);
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

    const { speaking, speakingParties, stopping, parties, ...toSave } = record;   // parties hold clusterers
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
          parties: Object.values(t.partyLabels || {}),
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
    const listener = (msg) => { if (msg.type === 'segment' && msg.channel === 'selftest') segments.push(msg); };
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

/**
 * Speaker label for a line: "You"; the party's name when more than one party
 * spoke; and a voice number when several people were heard through one party
 * ("Caller 2", "Ada · voice 2").
 */
function speakerLabel(line, multiParty, voiceCounts = {}) {
  if (line.speaker === 'you') return 'You';
  const base = multiParty && line.party ? line.party : 'Caller';
  const voices = line.partyId ? voiceCounts[line.partyId] : 0;
  if (voices > 1 && line.voice) return multiParty && line.party ? `${base} · voice ${line.voice}` : `Caller ${line.voice}`;
  return base;
}

function hasMultipleParties(record) {
  const labels = new Set((record.lines || []).filter((l) => l.speaker === 'caller').map((l) => l.party || 'Caller'));
  const known = new Set(Object.values(record.partyLabels || {}));
  return labels.size > 1 || known.size > 1;
}

function formatTranscript(record) {
  const stamp = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const who = record.remoteName ? `${record.remoteName} (${record.remoteNumber})` : record.remoteNumber;
  const parties = Object.values(record.partyLabels || {});
  const head = [
    `TwinLine transcript — call with ${who}`,
    `${new Date(record.startedAt).toLocaleString()}${record.endedAt ? ` – ${new Date(record.endedAt).toLocaleTimeString()}` : ''}`,
    parties.length > 1 ? `Conference with: ${parties.join(', ')}` : null,
    `Model: ${record.model}, language: ${record.language}`,
    '',
  ].filter((l) => l !== null);
  const multi = hasMultipleParties(record);
  const voiceCounts = record.voiceCounts || {};
  const several = Object.values(voiceCounts).some((n) => n > 1);
  if (several) head.splice(head.length - 1, 0, 'Several voices were heard on the line; "Caller 1/2/…" are told apart by voice and are approximate.');
  const body = record.lines.map((l) => `[${stamp(l.atMs)}] ${speakerLabel(l, multi, voiceCounts)}: ${l.text}`);
  return head.concat(body).join('\n') + '\n';
}

module.exports = { TranscriptionService, formatTranscript, speakerLabel, hasMultipleParties, FRAME_SAMPLES };
