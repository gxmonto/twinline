'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Transcriber, VAD_WINDOW } = require('../src/main/transcribe/core');
const { ModelStore, CATALOG } = require('../src/main/transcribe/models');
const { AudioMixer } = require('../src/main/media/mixer');

/**
 * A stand-in for sherpa-onnx: the VAD calls anything above an amplitude
 * threshold speech and closes a segment after `silenceWindows` quiet windows;
 * the recogniser "transcribes" a segment as its sample count, so tests can
 * check exactly which audio reached it.
 */
function fakeSherpa({ silenceWindows = 3, text = (samples) => `heard ${samples.length}` } = {}) {
  let concurrent = 0, maxConcurrent = 0;
  class Vad {
    constructor() { this.buf = []; this.quiet = 0; this.speech = null; this.segments = []; this.pos = 0; }
    acceptWaveform(w) {
      const loud = Math.max(...w) > 0.05;
      if (loud) {
        if (!this.speech) this.speech = { start: this.pos, samples: [] };
        this.speech.samples.push(...w); this.quiet = 0;
      } else if (this.speech) {
        this.speech.samples.push(...w);
        if (++this.quiet >= silenceWindows) this._close();
      }
      this.pos += w.length;
    }
    _close() { const s = this.speech; this.speech = null; this.quiet = 0; this.segments.push({ start: s.start, samples: Float32Array.from(s.samples) }); }
    isDetected() { return !!this.speech; }
    isEmpty() { return this.segments.length === 0; }
    front() { return this.segments[0]; }
    pop() { this.segments.shift(); }
    flush() { if (this.speech) this._close(); }
  }
  class LinearResampler {
    constructor(a, b) { this.ratio = b / a; }
    resample(x) { const out = new Float32Array(Math.round(x.length * this.ratio)); for (let i = 0; i < out.length; i++) out[i] = x[Math.floor(i / this.ratio)]; return out; }
  }
  class OfflineRecognizer {
    static async createAsync(config) { const r = new OfflineRecognizer(); r.config = config; return r; }
    createStream() { return { accept: null, acceptWaveform(o) { this.accept = o; } }; }
    async decodeAsync(stream) {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return { text: text(stream.accept.samples), lang: '<|en|>' };
    }
  }
  return { Vad, LinearResampler, OfflineRecognizer, version: 'fake', get maxConcurrent() { return maxConcurrent; } };
}

function tone(frames, amplitude = 8000) {
  const out = new Int16Array(160 * frames);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i / 3) * amplitude);
  return out;
}
const silence = (frames) => new Int16Array(160 * frames);

async function make(sherpa, opts = {}) {
  const segs = [];
  const speaking = [];
  const t = new Transcriber({
    sherpa, model: { encoder: 'e', decoder: 'd', tokens: 't' }, vadModel: 'v', language: 'auto', threads: 1,
    onSegment: (s) => segs.push(s), onSpeaking: (id, on) => speaking.push([id, on]), ...opts,
  });
  await t.init();
  return { t, segs, speaking };
}

function feed(t, id, int16) {
  for (let off = 0; off < int16.length; off += 160) t.pushAudio(id, int16.subarray(off, off + 160));
}

test('an utterance becomes one segment with timing, after the speaker pauses', async () => {
  const sherpa = fakeSherpa();
  const { t, segs, speaking } = await make(sherpa);
  t.openChannel('caller', { inputRate: 8000 });

  feed(t, 'caller', silence(10));               // 200 ms quiet
  feed(t, 'caller', tone(50));                  // 1 s of speech
  feed(t, 'caller', silence(30));               // pause ends the turn
  await t.idle();

  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].channel, 'caller');
  assert.strictEqual(segs[0].lang, 'en', 'whisper token brackets are stripped');
  assert.ok(segs[0].startMs >= 150 && segs[0].startMs <= 260, `starts ~200 ms in, got ${segs[0].startMs}`);
  assert.ok(segs[0].endMs - segs[0].startMs >= 1000, 'covers the whole utterance');
  assert.deepStrictEqual(speaking, [['caller', true], ['caller', false]]);
});

test('8 kHz input is resampled to 16 kHz before the VAD', async () => {
  const sherpa = fakeSherpa({ text: (s) => `n=${s.length}` });
  const { t, segs } = await make(sherpa);
  t.openChannel('c', { inputRate: 8000 });
  feed(t, 'c', tone(50));
  feed(t, 'c', silence(30));
  await t.idle();
  const n = parseInt(segs[0].text.slice(2), 10);
  // 1 s of speech ≈ 16000 samples at 16 kHz (plus the trailing silence windows).
  assert.ok(n >= 16000 && n < 16000 + VAD_WINDOW * 4, `segment has ${n} samples`);
});

test('the 2x upsampler is seamless across frames', () => {
  const { Upsampler2x } = require('../src/main/transcribe/core');
  const up = new Upsampler2x();
  const a = up.process(Float32Array.from([0, 1]));
  const b = up.process(Float32Array.from([2, 3]));
  // Every input sample is kept; the interpolated one between frames uses the
  // last sample of the previous frame, not a zero.
  assert.deepStrictEqual([...a], [0, 0, 0.5, 1]);
  assert.deepStrictEqual([...b], [1.5, 2, 2.5, 3]);
});

test('too-short bursts and Whisper hallucinations are dropped', async () => {
  const sherpa = fakeSherpa({ text: () => 'Thank you.' });
  const { t, segs } = await make(sherpa);
  t.openChannel('c', { inputRate: 8000 });
  feed(t, 'c', tone(5));         // 100 ms click
  feed(t, 'c', silence(30));
  feed(t, 'c', tone(50));        // real length, but the model says "Thank you."
  feed(t, 'c', silence(30));
  await t.idle();
  assert.strictEqual(segs.length, 0);
  assert.strictEqual(t.stats.dropped, 2);
});

test('segments decode one at a time across channels', async () => {
  const sherpa = fakeSherpa();
  const { t, segs } = await make(sherpa);
  t.openChannel('you', { inputRate: 8000 });
  t.openChannel('caller', { inputRate: 8000 });
  for (let round = 0; round < 3; round++) {
    feed(t, 'you', tone(40)); feed(t, 'you', silence(30));
    feed(t, 'caller', tone(40)); feed(t, 'caller', silence(30));
  }
  await t.idle();
  assert.strictEqual(segs.length, 6);
  assert.strictEqual(sherpa.maxConcurrent, 1, 'Whisper never runs concurrently');
  assert.strictEqual(segs.filter((s) => s.channel === 'you').length, 3);
});

test('closing a channel flushes speech that had not paused yet', async () => {
  const sherpa = fakeSherpa();
  const { t, segs } = await make(sherpa);
  t.openChannel('c', { inputRate: 8000 });
  feed(t, 'c', tone(60));        // still talking when the call ends
  t.closeChannel('c');
  await t.idle();
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(t.channels.size, 0);
});

test('model store knows what is installed and where', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinline-models-'));
  const store = new ModelStore(dir);
  assert.strictEqual(store.installed('small'), false);
  assert.strictEqual(store.paths('vad'), null);

  const small = store.dirFor('small');
  fs.mkdirSync(small, { recursive: true });
  for (const f of CATALOG.small.files) fs.writeFileSync(path.join(small, f.name), 'x');
  const p = store.paths('small');
  assert.ok(p.encoder.endsWith('small-encoder.int8.onnx'));
  assert.ok(p.decoder.endsWith('small-decoder.int8.onnx'));
  assert.ok(p.tokens.endsWith('small-tokens.txt'));

  // A zero-byte file (interrupted download) does not count as installed.
  fs.writeFileSync(path.join(small, 'small-decoder.int8.onnx'), '');
  assert.strictEqual(store.installed('small'), false);

  const status = store.status();
  assert.strictEqual(status.models.length, 3);
  assert.deepStrictEqual(status.models.map((m) => m.id), ['base', 'small', 'medium']);
  assert.throws(() => ModelStore.entry('gigantic'));
});

test('mixer exposes per-party audio for taps and plays a queued tone to both sides', () => {
  const mixer = new AudioMixer();
  const remote = { pullFrame: () => new Int16Array(160).fill(300), sent: [], sendFrame(p) { this.sent.push(p ? p.slice() : null); } };
  mixer.addLeg('a', remote, 'active');

  const mic = new Int16Array(160).fill(100);
  let speaker = mixer.tick(mic);
  assert.strictEqual(mixer.lastMic[0], 100);
  assert.strictEqual(mixer.lastInbound.get('a')[0], 300);
  assert.strictEqual(speaker[0], 300);

  const beep = new Int16Array(400).fill(1000);        // 2.5 frames long
  assert.strictEqual(mixer.queueTone('a', beep), true);
  speaker = mixer.tick(mic);
  assert.strictEqual(remote.sent.at(-1)[0], 1100, 'caller hears mic + tone');
  assert.strictEqual(speaker[0], 1300, 'local user hears caller + tone');
  mixer.tick(mic);
  speaker = mixer.tick(mic);
  assert.strictEqual(speaker[0], 1300, 'third frame carries the tail of the tone');
  assert.strictEqual(speaker[100], 300, 'and the tone ends mid-frame');
  speaker = mixer.tick(mic);
  assert.strictEqual(speaker[0], 300, 'tone finished');
  assert.strictEqual(mixer.queueTone('nope', beep), false);
});
