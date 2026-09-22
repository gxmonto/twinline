'use strict';
/**
 * The recognition pipeline, independent of Electron so it can run inside a
 * utility process (worker.js) or from the command line (tools/transcribe-file.js).
 *
 * Per audio channel:
 *   8 kHz Int16 frames → float → 16 kHz → Silero VAD (512-sample windows)
 *   → speech segments → Whisper (decoded one at a time, off the main thread)
 *   → { text, lang, startMs, endMs }
 *
 * Channels are independent, so "you" and "the caller" are recognised
 * separately and never need speaker diarisation.
 */

const VAD_WINDOW = 512;            // samples at 16 kHz, what Silero expects
const TARGET_RATE = 16000;
const MIN_SEGMENT_SEC = 0.4;       // shorter bursts are clicks, not words

// Whisper produces these on silence and noise; they carry no information.
const HALLUCINATIONS = new Set([
  'thank you.', 'thank you', 'thanks for watching.', 'thanks for watching', 'you', 'bye.', 'bye',
  'subtítulos realizados por la comunidad de amara.org', 'subtitles by the amara.org community',
  '[music]', '[blank_audio]', '(music)', '.', '...',
]);

/**
 * 8 kHz → 16 kHz by linear interpolation, carrying the last sample across
 * frames so there is no seam. Done in JS rather than with sherpa-onnx's
 * resampler because that one returns N-API external buffers, which Electron's
 * V8 memory cage rejects ("External buffers are not allowed").
 */
class Upsampler2x {
  constructor() { this.last = 0; this.primed = false; }
  process(x) {
    const out = new Float32Array(x.length * 2);
    let prev = this.primed ? this.last : (x.length ? x[0] : 0);
    for (let i = 0; i < x.length; i++) {
      out[2 * i] = (prev + x[i]) / 2;
      out[2 * i + 1] = x[i];
      prev = x[i];
    }
    this.last = prev;
    this.primed = true;
    return out;
  }
}

class Transcriber {
  /**
   * @param {object} opts
   * @param {object} opts.sherpa       the sherpa-onnx-node module
   * @param {object} opts.model        { encoder, decoder, tokens } file paths
   * @param {string} opts.vadModel     silero_vad.onnx path
   * @param {string} [opts.language]   'auto' | ISO code ('en', 'es', ...)
   * @param {number} [opts.threads]
   * @param {(seg: object) => void} opts.onSegment
   * @param {(id: string, speaking: boolean) => void} [opts.onSpeaking]
   */
  constructor({ sherpa, model, vadModel, language = 'auto', threads = 4, onSegment, onSpeaking = () => {} }) {
    this.sherpa = sherpa;
    this.model = model;
    this.vadModel = vadModel;
    this.language = language;
    this.threads = threads;
    this.onSegment = onSegment;
    this.onSpeaking = onSpeaking;
    this.recognizer = null;
    this.channels = new Map();
    this.queue = [];
    this.decoding = false;
    this.stats = { segments: 0, decodeMs: 0, dropped: 0 };
  }

  async init() {
    this.recognizer = await this.sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: this.model.encoder,
          decoder: this.model.decoder,
          language: this.language === 'auto' ? '' : this.language,
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: this.model.tokens,
        numThreads: this.threads,
        provider: 'cpu',
        debug: 0,
        modelType: 'whisper',
      },
    });
    return this;
  }

  _vad() {
    return new this.sherpa.Vad({
      sileroVad: {
        model: this.vadModel,
        threshold: 0.5,
        minSilenceDuration: 0.5,      // a conversational pause ends the turn
        minSpeechDuration: 0.25,
        windowSize: VAD_WINDOW,
        maxSpeechDuration: 20,        // long monologues are split for latency
      },
      sampleRate: TARGET_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    }, 60);
  }

  openChannel(id, { inputRate = 8000, label = id } = {}) {
    if (this.channels.has(id)) return;
    this.channels.set(id, {
      id,
      label,
      resampler: inputRate === TARGET_RATE ? null
        : inputRate * 2 === TARGET_RATE ? new Upsampler2x()
        : new this.sherpa.LinearResampler(inputRate, TARGET_RATE),
      vad: this._vad(),
      pending: new Float32Array(0),
      speaking: false,
      samplesIn: 0,              // at 16 kHz, for timestamps
      openedAt: Date.now(),
    });
  }

  /** Feed one frame of Int16 PCM. */
  pushAudio(id, int16) {
    const ch = this.channels.get(id);
    if (!ch) return;

    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32768;
    const resampled = !ch.resampler ? floats
      : ch.resampler instanceof Upsampler2x ? ch.resampler.process(floats)
      : ch.resampler.resample(floats);

    // Accumulate into exact VAD windows.
    const merged = new Float32Array(ch.pending.length + resampled.length);
    merged.set(ch.pending);
    merged.set(resampled, ch.pending.length);
    let offset = 0;
    while (merged.length - offset >= VAD_WINDOW) {
      ch.vad.acceptWaveform(merged.subarray(offset, offset + VAD_WINDOW));
      offset += VAD_WINDOW;
      ch.samplesIn += VAD_WINDOW;
    }
    ch.pending = merged.slice(offset);

    const speaking = ch.vad.isDetected();
    if (speaking !== ch.speaking) { ch.speaking = speaking; this.onSpeaking(id, speaking); }
    this._drain(ch);
  }

  /** Flush a channel (call ended) and forget it. Pending segments still decode. */
  closeChannel(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    try {
      if (ch.pending.length) {
        const padded = new Float32Array(VAD_WINDOW);
        padded.set(ch.pending.subarray(0, VAD_WINDOW));
        ch.vad.acceptWaveform(padded);
      }
      ch.vad.flush();
      this._drain(ch);
    } catch { /* channel is going away regardless */ }
    if (ch.speaking) this.onSpeaking(id, false);
    this.channels.delete(id);
  }

  _drain(ch) {
    while (!ch.vad.isEmpty()) {
      // false: copy into a normal buffer; external buffers are refused in Electron.
      const seg = ch.vad.front(false);
      ch.vad.pop();
      if (seg.samples.length / TARGET_RATE < MIN_SEGMENT_SEC) { this.stats.dropped++; continue; }
      this.queue.push({
        channel: ch.id,
        label: ch.label,
        samples: seg.samples,
        startMs: Math.round((seg.start / TARGET_RATE) * 1000),
        endMs: Math.round(((seg.start + seg.samples.length) / TARGET_RATE) * 1000),
      });
    }
    this._pump();
  }

  /** Decode queued segments one at a time so Whisper never runs concurrently. */
  async _pump() {
    if (this.decoding) return;
    this.decoding = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        const t0 = Date.now();
        let result;
        try {
          const stream = this.recognizer.createStream();
          stream.acceptWaveform({ samples: job.samples, sampleRate: TARGET_RATE });
          result = await this.recognizer.decodeAsync(stream);
        } catch (err) {
          this.onSegment({ ...job, samples: undefined, error: err.message });
          continue;
        }
        this.stats.decodeMs += Date.now() - t0;
        const text = String(result.text || '').trim();
        if (!text || HALLUCINATIONS.has(text.toLowerCase())) { this.stats.dropped++; continue; }
        this.stats.segments++;
        this.onSegment({
          channel: job.channel,
          label: job.label,
          text,
          lang: (result.lang || '').replace(/^<\|/, '').replace(/\|>$/, '') || null,
          startMs: job.startMs,
          endMs: job.endMs,
          decodeMs: Date.now() - t0,
        });
      }
    } finally {
      this.decoding = false;
    }
  }

  /** Wait until every queued segment has been decoded. */
  async idle() {
    while (this.decoding || this.queue.length) await new Promise((r) => setTimeout(r, 25));
  }

  close() {
    for (const id of [...this.channels.keys()]) this.closeChannel(id);
  }
}

module.exports = { Transcriber, Upsampler2x, TARGET_RATE, VAD_WINDOW, HALLUCINATIONS };
