'use strict';
/**
 * Run the exact transcription pipeline TwinLine uses on a WAV file, from the
 * command line — for checking a model, or debugging a transcript complaint.
 *
 *   node tools/transcribe-file.js speech.wav [--model small] [--lang auto|en|es]
 *                                 [--models-dir <dir>] [--telephone]
 *
 * --telephone squeezes the audio through the same path a real call takes
 * (8 kHz, G.711 µ-law) before recognition, so results are representative.
 *
 * Models are read from %APPDATA%\TwinLine\models (Linux: ~/.config/TwinLine/models)
 * unless --models-dir is given.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const { Transcriber } = require(path.join(root, 'src', 'main', 'transcribe', 'core'));
const { ModelStore } = require(path.join(root, 'src', 'main', 'transcribe', 'models'));
const codecs = require(path.join(root, 'src', 'main', 'rtp', 'codecs'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function defaultModelsDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'TwinLine', 'models');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'TwinLine', 'models');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'TwinLine', 'models');
}

/** Minimal PCM WAV reader: 16-bit mono/stereo, any rate. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12, fmt = null, data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(offset + 10), rate: buf.readUInt32LE(offset + 12), bits: buf.readUInt16LE(offset + 22) };
    if (id === 'data') data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('malformed WAV');
  if (fmt.bits !== 16) throw new Error('only 16-bit PCM WAV is supported');
  const frames = data.length / 2 / fmt.channels;
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = data.readInt16LE(i * 2 * fmt.channels);   // left channel
  return { samples: mono, rate: fmt.rate };
}

/** Naive decimation/interpolation; good enough for a test harness. */
function resampleInt16(samples, from, to) {
  const out = new Int16Array(Math.round(samples.length * to / from));
  for (let i = 0; i < out.length; i++) {
    const pos = i * from / to;
    const a = Math.floor(pos), b = Math.min(a + 1, samples.length - 1);
    out[i] = Math.round(samples[a] + (samples[b] - samples[a]) * (pos - a));
  }
  return out;
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: node tools/transcribe-file.js <wav> [--model small] [--lang auto] [--telephone]'); process.exit(2); }

  const store = new ModelStore(arg('models-dir', defaultModelsDir()));
  const modelId = arg('model', 'parakeet');
  const model = store.paths(modelId);
  const vad = store.paths('vad');
  if (!model) { console.error(`model "${modelId}" is not downloaded in ${store.root}`); process.exit(1); }
  if (!vad) { console.error(`VAD is not downloaded in ${store.root}`); process.exit(1); }

  let { samples, rate } = readWav(file);
  if (process.argv.includes('--telephone')) {
    // 8 kHz, µ-law round trip: what the far end actually sounds like.
    const eightK = resampleInt16(samples, rate, 8000);
    samples = codecs.decodePCMU(codecs.encodePCMU(eightK));
    rate = 8000;
  }

  // Platform library path, as the app's worker sets it.
  const platformDir = path.join(root, 'node_modules', `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`);
  if (process.platform === 'win32') process.env.PATH = `${platformDir};${process.env.PATH}`;
  const sherpa = require('sherpa-onnx-node');

  const t0 = Date.now();
  const lines = [];
  const transcriber = new Transcriber({
    sherpa, model, vadModel: vad.vad,
    language: arg('lang', 'auto'),
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
    onSegment: (seg) => {
      const stamp = `${String(Math.floor(seg.startMs / 60000)).padStart(2, '0')}:${String(Math.floor((seg.startMs % 60000) / 1000)).padStart(2, '0')}`;
      const line = seg.error ? `[${stamp}] (error: ${seg.error})` : `[${stamp}] ${seg.lang ? `(${seg.lang}) ` : ''}${seg.text}`;
      lines.push(line);
      console.log(line + (seg.decodeMs ? `   ~${seg.decodeMs} ms` : ''));
    },
  });
  await transcriber.init();
  console.log(`engine sherpa-onnx ${sherpa.version}, model ${modelId}, input ${rate} Hz, loaded in ${Date.now() - t0} ms\n`);

  transcriber.openChannel('file', { inputRate: rate, label: 'file' });
  // Feed in 20 ms frames exactly as calls arrive.
  const frame = Math.round(rate / 50);
  for (let off = 0; off < samples.length; off += frame) {
    const chunk = samples.subarray(off, Math.min(off + frame, samples.length));
    const padded = new Int16Array(frame); padded.set(chunk);
    transcriber.pushAudio('file', padded);
  }
  transcriber.closeChannel('file');
  await transcriber.idle();
  console.log(`\n${lines.length} line(s); ${transcriber.stats.dropped} segment(s) dropped; total decode ${transcriber.stats.decodeMs} ms`);
}

main().catch((err) => { console.error(err); process.exit(1); });
