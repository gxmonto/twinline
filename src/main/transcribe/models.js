'use strict';
/**
 * Speech-recognition model catalogue, download and storage.
 *
 * Models are int8 Whisper exports for sherpa-onnx, fetched file by file from
 * Hugging Face (so nothing has to be unpacked), plus the Silero voice-activity
 * detector. Everything lives under <userData>/models.
 *
 * Whisper is multilingual and detects the language per utterance, which is
 * what makes mixed English/Spanish calls work without configuration.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const log = require('../log').child('models');

const HF = (model, file) => `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${model}/resolve/main/${file}`;
const HF_PARAKEET = (file) => `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/${file}`;

// Every file is pinned by size and (for the model binaries) SHA-256, taken
// from the Hugging Face LFS metadata when the catalogue was written. ONNX
// files are parsed by native code, so a swapped download must be refused.
const CATALOG = {
  parakeet: {
    id: 'parakeet',
    type: 'nemo_transducer',
    dir: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet-TDT 0.6B v3 — recommended: fast, accurate, 25 languages incl. English and Spanish',
    approxMB: 670,
    files: [
      { name: 'encoder.int8.onnx', url: HF_PARAKEET('encoder.int8.onnx'), role: 'encoder', size: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
      { name: 'decoder.int8.onnx', url: HF_PARAKEET('decoder.int8.onnx'), role: 'decoder', size: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
      { name: 'joiner.int8.onnx', url: HF_PARAKEET('joiner.int8.onnx'), role: 'joiner', size: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
      { name: 'tokens.txt', url: HF_PARAKEET('tokens.txt'), role: 'tokens', size: 93939 },
    ],
  },
  base: {
    id: 'base',
    type: 'whisper',
    label: 'Whisper base — smallest download, lower accuracy',
    approxMB: 160,
    files: [
      { name: 'base-encoder.int8.onnx', url: HF('base', 'base-encoder.int8.onnx'), role: 'encoder', size: 29120534, sha256: '0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11' },
      { name: 'base-decoder.int8.onnx', url: HF('base', 'base-decoder.int8.onnx'), role: 'decoder', size: 130672026, sha256: '9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d' },
      { name: 'base-tokens.txt', url: HF('base', 'base-tokens.txt'), role: 'tokens', size: 816730 },
    ],
  },
  small: {
    id: 'small',
    type: 'whisper',
    label: 'Whisper small — moderate accuracy, ~2 s per utterance',
    approxMB: 375,
    files: [
      { name: 'small-encoder.int8.onnx', url: HF('small', 'small-encoder.int8.onnx'), role: 'encoder', size: 112442483, sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
      { name: 'small-decoder.int8.onnx', url: HF('small', 'small-decoder.int8.onnx'), role: 'decoder', size: 262226114, sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
      { name: 'small-tokens.txt', url: HF('small', 'small-tokens.txt'), role: 'tokens', size: 816730 },
    ],
  },
  medium: {
    id: 'medium',
    type: 'whisper',
    label: 'Whisper medium — slow (5–10 s per utterance), language detection unreliable on phone audio',
    approxMB: 950,
    files: [
      { name: 'medium-encoder.int8.onnx', url: HF('medium', 'medium-encoder.int8.onnx'), role: 'encoder', size: 374196283, sha256: '1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e' },
      { name: 'medium-decoder.int8.onnx', url: HF('medium', 'medium-decoder.int8.onnx'), role: 'decoder', size: 571059257, sha256: '595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747' },
      { name: 'medium-tokens.txt', url: HF('medium', 'medium-tokens.txt'), role: 'tokens', size: 816730 },
    ],
  },
};

const VAD = {
  id: 'vad',
  label: 'Silero voice activity detector',
  approxMB: 1,
  files: [
    { name: 'silero_vad.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', role: 'vad', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
  ],
};

// Voice fingerprints, used to tell people apart when several speak through
// one call (a conference hosted by the other side). Fetched with any model.
const SPEAKER = {
  id: 'speaker',
  dir: 'speaker',
  label: 'Speaker embedding model (tells voices apart)',
  approxMB: 29,
  files: [
    { name: 'wespeaker_en_voxceleb_CAM++.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx', role: 'speaker', size: 29292684, sha256: 'c46fad10b5f81e1aa4a60c162714208577093655076c5450f8c469e522ec54ef' },
  ],
};

class ModelStore extends EventEmitter {
  constructor(rootDir) {
    super();
    this.root = rootDir;
    this.active = new Map();        // id -> { controller, progress }
  }

  dirFor(id) {
    if (id === 'vad') return path.join(this.root, 'vad');
    const entry = ModelStore.entry(id);
    return path.join(this.root, entry.dir || `whisper-${id}`);
  }

  static entry(id) {
    if (id === 'vad') return VAD;
    if (id === 'speaker') return SPEAKER;
    const m = CATALOG[id];
    if (!m) throw new Error(`unknown model "${id}"`);
    return m;
  }

  /** Absolute paths of an installed model's files (plus its type), or null if incomplete. */
  paths(id) {
    const entry = ModelStore.entry(id);
    const dir = this.dirFor(id);
    const out = { type: entry.type };
    for (const f of entry.files) {
      const p = path.join(dir, f.name);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
      out[f.role] = p;
    }
    return out;
  }

  installed(id) {
    return this.paths(id) !== null;
  }

  /** Everything the Settings page needs in one call. */
  status() {
    const models = Object.values(CATALOG).map((m) => ({
      id: m.id,
      type: m.type,
      label: m.label,
      approxMB: m.approxMB,
      installed: this.installed(m.id),
      downloading: this.active.has(m.id),
      progress: this.active.get(m.id)?.progress || null,
      sizeOnDiskMB: this._sizeOnDisk(m.id),
    }));
    return {
      root: this.root,
      vadInstalled: this.installed('vad'),
      vadDownloading: this.active.has('vad'),
      speakerInstalled: this.installed('speaker'),
      models,
    };
  }

  _sizeOnDisk(id) {
    try {
      const dir = this.dirFor(id);
      return Math.round(fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0) / 1e6);
    } catch {
      return 0;
    }
  }

  /**
   * Download a model (and the VAD if missing). Progress is emitted as
   * 'progress' { id, file, received, total, percent } roughly 4×/second.
   */
  async download(id) {
    if (this.active.has(id)) return this.status();
    const entry = ModelStore.entry(id);
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });

    const controller = new AbortController();
    const state = { controller, progress: { file: null, received: 0, total: 0, percent: 0 } };
    this.active.set(id, state);
    this.emit('progress', { id, ...state.progress });
    log.info('download start', { id });

    try {
      for (const f of entry.files) {
        const dest = path.join(dir, f.name);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
        state.progress.file = f.name;
        const digest = await downloadFile(f.url, dest, controller.signal, (received, total) => {
          state.progress.received = received;
          state.progress.total = total;
          state.progress.percent = total ? Math.round((received / total) * 100) : 0;
          this.emit('progress', { id, ...state.progress });
        });
        verifyFile(dest, f, digest);
      }
      log.info('download done', { id });
      this.emit('installed', { id });
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) log.info('download cancelled', { id });
      else { log.error('download failed', { id, error: err }); this.emit('error', { id, message: err.message }); }
      throw err;
    } finally {
      this.active.delete(id);
      this.emit('progress', { id, done: true });
    }
    // The VAD is tiny and every model needs it; the speaker model is small
    // and what makes "Caller 1 / Caller 2" possible.
    if (id !== 'vad' && id !== 'speaker') {
      if (!this.installed('vad')) await this.download('vad');
      if (!this.installed('speaker')) await this.download('speaker').catch((err) => log.warn('speaker model download failed', err));
    }
    return this.status();
  }

  cancel(id) {
    const state = this.active.get(id);
    if (state) state.controller.abort();
    return this.status();
  }

  remove(id) {
    if (this.active.has(id)) this.cancel(id);
    fs.rmSync(this.dirFor(id), { recursive: true, force: true });
    log.info('model removed', { id });
    return this.status();
  }
}

/**
 * Refuse a downloaded file whose size or SHA-256 differs from the catalogue.
 * The file is removed so a retry starts clean.
 */
function verifyFile(dest, entry, digest) {
  const size = fs.statSync(dest).size;
  const problems = [];
  if (entry.size && size !== entry.size) problems.push(`size ${size}, expected ${entry.size}`);
  if (entry.sha256 && digest && digest !== entry.sha256) problems.push('SHA-256 mismatch');
  if (problems.length) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${entry.name} failed its integrity check (${problems.join('; ')}); the download was discarded`);
  }
}

/** Stream a URL to disk via a .part file, following redirects. Resolves with the SHA-256. */
function downloadFile(url, dest, signal, onProgress, redirects = 6) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'user-agent': 'TwinLine' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, signal, onProgress, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} downloading ${path.basename(dest)}`)); return; }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      const part = `${dest}.part`;
      const out = fs.createWriteStream(part);
      const hash = require('crypto').createHash('sha256');
      let received = 0;
      let lastReport = 0;

      const onAbort = () => { req.destroy(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });

      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        const now = Date.now();
        if (now - lastReport > 250) { lastReport = now; onProgress(received, total); }
      });
      res.pipe(out);
      out.on('finish', () => {
        signal.removeEventListener('abort', onAbort);
        if (total && received !== total) {
          fs.rmSync(part, { force: true });
          reject(new Error(`incomplete download of ${path.basename(dest)} (${received}/${total} bytes)`));
          return;
        }
        fs.renameSync(part, dest);
        onProgress(received, total || received);
        resolve(hash.digest('hex'));
      });
      const fail = (err) => {
        signal.removeEventListener('abort', onAbort);
        out.destroy();
        fs.rmSync(part, { force: true });
        reject(err);
      };
      res.on('error', fail);
      out.on('error', fail);
      req.on('error', fail);
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
  });
}

function abortError() {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  return err;
}

module.exports = { ModelStore, CATALOG, VAD, SPEAKER, verifyFile };
