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

const CATALOG = {
  base: {
    id: 'base',
    label: 'Whisper base — fastest, lower accuracy',
    approxMB: 160,
    files: [
      { name: 'base-encoder.int8.onnx', url: HF('base', 'base-encoder.int8.onnx'), role: 'encoder' },
      { name: 'base-decoder.int8.onnx', url: HF('base', 'base-decoder.int8.onnx'), role: 'decoder' },
      { name: 'base-tokens.txt', url: HF('base', 'base-tokens.txt'), role: 'tokens' },
    ],
  },
  small: {
    id: 'small',
    label: 'Whisper small — recommended',
    approxMB: 375,
    files: [
      { name: 'small-encoder.int8.onnx', url: HF('small', 'small-encoder.int8.onnx'), role: 'encoder' },
      { name: 'small-decoder.int8.onnx', url: HF('small', 'small-decoder.int8.onnx'), role: 'decoder' },
      { name: 'small-tokens.txt', url: HF('small', 'small-tokens.txt'), role: 'tokens' },
    ],
  },
  medium: {
    id: 'medium',
    label: 'Whisper medium — best accuracy, slow on older CPUs',
    approxMB: 950,
    files: [
      { name: 'medium-encoder.int8.onnx', url: HF('medium', 'medium-encoder.int8.onnx'), role: 'encoder' },
      { name: 'medium-decoder.int8.onnx', url: HF('medium', 'medium-decoder.int8.onnx'), role: 'decoder' },
      { name: 'medium-tokens.txt', url: HF('medium', 'medium-tokens.txt'), role: 'tokens' },
    ],
  },
};

const VAD = {
  id: 'vad',
  label: 'Silero voice activity detector',
  approxMB: 1,
  files: [
    { name: 'silero_vad.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx', role: 'vad' },
  ],
};

class ModelStore extends EventEmitter {
  constructor(rootDir) {
    super();
    this.root = rootDir;
    this.active = new Map();        // id -> { controller, progress }
  }

  dirFor(id) {
    return path.join(this.root, id === 'vad' ? 'vad' : `whisper-${id}`);
  }

  static entry(id) {
    if (id === 'vad') return VAD;
    const m = CATALOG[id];
    if (!m) throw new Error(`unknown model "${id}"`);
    return m;
  }

  /** Absolute paths of an installed model's files, or null if incomplete. */
  paths(id) {
    const entry = ModelStore.entry(id);
    const dir = this.dirFor(id);
    const out = {};
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
        await downloadFile(f.url, dest, controller.signal, (received, total) => {
          state.progress.received = received;
          state.progress.total = total;
          state.progress.percent = total ? Math.round((received / total) * 100) : 0;
          this.emit('progress', { id, ...state.progress });
        });
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
    // The VAD is tiny and every model needs it.
    if (id !== 'vad' && !this.installed('vad')) await this.download('vad');
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

/** Stream a URL to disk via a .part file, following redirects. */
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
      let received = 0;
      let lastReport = 0;

      const onAbort = () => { req.destroy(abortError()); };
      signal.addEventListener('abort', onAbort, { once: true });

      res.on('data', (chunk) => {
        received += chunk.length;
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
        resolve();
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

module.exports = { ModelStore, CATALOG, VAD };
