'use strict';
/**
 * Adaptive jitter buffer for fixed-size audio frames.
 *
 * Frames are pushed keyed by 16-bit RTP sequence number and pulled in playout
 * order at a steady rate. Missing frames are concealed by fading out the last
 * good frame, which sounds far better than inserting digital silence.
 */

const MAX_SEQ = 0x10000;

/** Signed distance from `a` to `b` across the 16-bit sequence space. */
function seqDelta(a, b) {
  let d = (b - a) % MAX_SEQ;
  if (d >= MAX_SEQ / 2) d -= MAX_SEQ;
  if (d < -MAX_SEQ / 2) d += MAX_SEQ;
  return d;
}

class JitterBuffer {
  /**
   * @param {object} opts
   * @param {number} opts.frameSamples samples in one frame (160 for 20 ms @ 8 kHz)
   * @param {number} [opts.targetFrames] initial playout delay, in frames
   * @param {number} [opts.minFrames]
   * @param {number} [opts.maxFrames]
   */
  constructor({ frameSamples = 160, targetFrames = 3, minFrames = 2, maxFrames = 12 } = {}) {
    this.frameSamples = frameSamples;
    this.target = targetFrames;
    this.min = minFrames;
    this.max = maxFrames;

    /** @type {Map<number, Int16Array>} keyed by extended sequence number */
    this.frames = new Map();
    this.baseSeq = null;          // 16-bit seq mapped to extended 0
    this.highestExt = -1;
    this.playoutExt = null;
    this.prebuffering = true;
    this.lastFrame = null;
    this.concealCount = 0;

    this.stats = { received: 0, lost: 0, late: 0, duplicated: 0, concealed: 0, overflow: 0 };
  }

  reset() {
    this.frames.clear();
    this.baseSeq = null;
    this.highestExt = -1;
    this.playoutExt = null;
    this.prebuffering = true;
    this.lastFrame = null;
    this.concealCount = 0;
  }

  /** Map a wire sequence number onto a monotonic extended sequence number. */
  _extend(seq) {
    if (this.baseSeq === null) {
      this.baseSeq = seq;
      return 0;
    }
    // Anchor on the highest seen so wraparound is handled in both directions.
    const anchorSeq = (this.baseSeq + this.highestExt) % MAX_SEQ;
    return this.highestExt + seqDelta(anchorSeq, seq);
  }

  /**
   * Insert a decoded frame.
   * @param {number} seq  16-bit RTP sequence number
   * @param {Int16Array} pcm
   */
  push(seq, pcm) {
    const ext = this._extend(seq);
    this.stats.received++;

    if (this.playoutExt !== null && ext < this.playoutExt) {
      this.stats.late++;                       // arrived after its slot played
      return false;
    }
    if (this.frames.has(ext)) {
      this.stats.duplicated++;
      return false;
    }

    this.frames.set(ext, pcm);
    if (ext > this.highestExt) this.highestExt = ext;

    // A burst of arrivals means the sender is ahead of us; drop the oldest
    // rather than letting delay grow without bound.
    while (this.frames.size > this.max) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
      this.stats.overflow++;
      if (this.playoutExt !== null && oldest >= this.playoutExt) this.playoutExt = oldest + 1;
    }

    if (this.prebuffering && this.frames.size >= this.target) {
      this.prebuffering = false;
      this.playoutExt = Math.min(...this.frames.keys());
    }
    return true;
  }

  /** Number of frames queued ahead of the playout point. */
  get depth() {
    return this.frames.size;
  }

  /**
   * Pull the next frame for playout. Always returns a frame of `frameSamples`
   * samples; returns null only while prebuffering or when the stream is idle.
   */
  pull() {
    if (this.prebuffering) return null;
    if (this.playoutExt === null) return null;

    const frame = this.frames.get(this.playoutExt);
    if (frame) {
      this.frames.delete(this.playoutExt);
      this.playoutExt++;
      this.lastFrame = frame;
      this.concealCount = 0;
      this._adapt();
      return frame;
    }

    // Nothing for this slot.
    if (this.frames.size === 0) {
      // Stream stalled. After a short conceal run, go back to prebuffering so
      // we re-establish a healthy delay when audio resumes.
      this.concealCount++;
      if (this.concealCount > this.max) {
        this.prebuffering = true;
        this.lastFrame = null;
        return null;
      }
      this.stats.concealed++;
      return this._conceal();
    }

    const nextAvailable = Math.min(...this.frames.keys());
    const gap = nextAvailable - this.playoutExt;
    if (gap > 0 && this.frames.size > this.target) {
      // We are behind and have plenty queued: skip the gap instead of stalling.
      this.stats.lost += gap;
      this.playoutExt = nextAvailable;
      return this.pull();
    }

    this.stats.concealed++;
    this.concealCount++;
    this.playoutExt++;             // treat the slot as lost and move on
    this.stats.lost++;
    return this._conceal();
  }

  /** Fade the last good frame out over successive conceal calls. */
  _conceal() {
    if (!this.lastFrame) return new Int16Array(this.frameSamples);
    const gain = Math.max(0, 1 - this.concealCount * 0.25);
    if (gain === 0) return new Int16Array(this.frameSamples);
    const out = new Int16Array(this.frameSamples);
    for (let i = 0; i < out.length && i < this.lastFrame.length; i++) {
      out[i] = (this.lastFrame[i] * gain) | 0;
    }
    return out;
  }

  /** Nudge the target delay towards what the network is actually delivering. */
  _adapt() {
    const depth = this.frames.size;
    if (depth > this.target + 2 && this.target < this.max - 2) this.target++;
    else if (depth === 0 && this.target > this.min) this.target++;
    else if (depth > this.min && this.target > this.min && depth < this.target - 2) this.target--;
  }
}

module.exports = { JitterBuffer, seqDelta };
