'use strict';
/**
 * Atomic file writes that survive Windows.
 *
 * "Write a .tmp, then rename over the real file" keeps a half-written
 * settings.json from ever existing. On Windows, though, the rename often
 * fails with EPERM/EBUSY for a few milliseconds: Defender or another scanner
 * opens the freshly written .tmp to look at it, and a file somebody has open
 * cannot be renamed. One user's settings "never saved" because of exactly
 * that (2026-10-03). So the rename is retried for a moment, and if it still
 * will not go, the file is written in place rather than losing the save.
 */

const fs = require('fs');
const path = require('path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

/** Block for `ms` without a timer (callers are synchronous save() methods). */
function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* not allowed here: no pause */ }
}

/**
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{mode?: number, retries?: number, delayMs?: number, fs?: typeof fs}} [opts]
 * @returns {'renamed'|'in-place'} how the write landed
 */
function writeFileAtomic(file, data, { mode = 0o600, retries = 6, delayMs = 50, fs: f = fs } = {}) {
  f.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  f.writeFileSync(tmp, data, { mode });
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      f.renameSync(tmp, file);
      return 'renamed';
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code)) break;
      pause(delayMs * (attempt + 1));
    }
  }
  // The rename never went through: do not lose the save. Write in place
  // (not atomic, but the data is already safely in the .tmp if this fails).
  try {
    f.writeFileSync(file, data, { mode });
    try { f.unlinkSync(tmp); } catch { /* leave it */ }
    return 'in-place';
  } catch (err) {
    err.message = `${err.message} (after rename failed: ${lastErr && lastErr.message})`;
    throw err;
  }
}

module.exports = { writeFileAtomic, RETRY_CODES };
