/**
 * Microphone capture worklet.
 *
 * The audio graph runs at 8 kHz with a 128-sample render quantum, but RTP
 * wants 160-sample (20 ms) frames, so we repack across quanta and post one
 * Int16 frame at a time to the main thread.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSamples = 160;
    this.buffer = new Float32Array(this.frameSamples);
    this.filled = 0;
    this.enabled = true;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'enabled') this.enabled = !!event.data.value;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.frameSamples) {
        this.filled = 0;
        if (!this.enabled) continue;
        const frame = new Int16Array(this.frameSamples);
        for (let j = 0; j < this.frameSamples; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          frame[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(frame.buffer, [frame.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
