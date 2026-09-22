/**
 * Speaker playback worklet.
 *
 * Mixed frames arrive from the main process over IPC, which is fast but not
 * sample-accurate, so they land in a ring buffer with a short prebuffer.
 * Underruns output silence rather than glitching the graph.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 8000;                  // 1 second at 8 kHz
    this.ring = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.prebuffer = 320;                  // 40 ms before we start playing
    this.priming = true;
    this.underruns = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === 'reset') { this._reset(); return; }
      this._push(new Int16Array(data));
    };
  }

  _reset() {
    this.read = this.write = this.available = 0;
    this.priming = true;
  }

  _push(frame) {
    // Drop the oldest audio if the main process out-runs the sound card.
    if (this.available + frame.length > this.capacity) {
      const drop = this.available + frame.length - this.capacity;
      this.read = (this.read + drop) % this.capacity;
      this.available -= drop;
    }
    for (let i = 0; i < frame.length; i++) {
      this.ring[this.write] = frame[i] / 32768;
      this.write = (this.write + 1) % this.capacity;
    }
    this.available += frame.length;

    if (this.priming && this.available >= this.prebuffer) this.priming = false;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    if (this.priming || this.available < out.length) {
      out.fill(0);
      if (!this.priming) {
        this.underruns++;
        // Sustained starvation: re-prime so we rebuild a safety margin.
        if (this.underruns > 25) { this.priming = true; this.underruns = 0; }
      }
      return true;
    }

    this.underruns = 0;
    for (let i = 0; i < out.length; i++) {
      out[i] = this.ring[this.read];
      this.read = (this.read + 1) % this.capacity;
    }
    this.available -= out.length;

    // Bound added latency if we have drifted ahead.
    if (this.available > 2400) {
      const drop = this.available - 1600;
      this.read = (this.read + drop) % this.capacity;
      this.available -= drop;
    }
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
