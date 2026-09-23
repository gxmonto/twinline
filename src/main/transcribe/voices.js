'use strict';
/**
 * Online speaker clustering for one audio channel.
 *
 * When the far end is a PBX-hosted conference, everything the other people
 * say arrives mixed into a single stream and there are no separate SIP legs
 * to label. What we can do is fingerprint each utterance (a speaker
 * embedding) and group utterances by voice as they arrive: "Caller 1",
 * "Caller 2", … The first voice heard keeps number 1.
 *
 * Calibration note: on 8 kHz telephone audio, embeddings from a wideband
 * model are much less separable than on clean speech — in a synthetic test
 * two voices scored 0.61 against each other while one voice scored 0.58
 * against itself. So this is deliberately conservative: it joins an existing
 * voice readily, and only declares a *new* voice on strong evidence (a long
 * utterance dissimilar to every known voice). Missing a second person is the
 * cheaper mistake; splitting one person in two would be wrong in the record.
 *
 * Pure JavaScript over the embeddings sherpa-onnx computes; no model here.
 */

/** Cosine similarity of two vectors. */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

class VoiceClusterer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.joinThreshold]  similarity at or above which an utterance clearly belongs to a voice
   * @param {number} [opts.newThreshold]   similarity below which (to every voice) an utterance may found a new one
   * @param {number} [opts.minNewMs]       an utterance shorter than this never founds a new voice
   * @param {number} [opts.maxVoices]      safety cap; beyond it, closest voice wins
   */
  constructor({ joinThreshold = 0.45, newThreshold = 0.28, minNewMs = 2000, maxVoices = 6 } = {}) {
    this.joinThreshold = joinThreshold;
    this.newThreshold = newThreshold;
    this.minNewMs = minNewMs;
    this.maxVoices = maxVoices;
    /** @type {Array<{id: number, centroid: Float32Array, count: number}>} */
    this.voices = [];
  }

  get count() {
    return this.voices.length;
  }

  /**
   * Assign an utterance to a voice.
   * @param {ArrayLike<number>} embedding
   * @param {number} durationMs
   * @returns {{voice: number, similarity: number, isNew: boolean, confident: boolean}}
   */
  assign(embedding, durationMs) {
    const e = Float32Array.from(embedding);
    let best = null, bestSim = -1;
    for (const v of this.voices) {
      const sim = cosine(e, v.centroid);
      if (sim > bestSim) { bestSim = sim; best = v; }
    }

    const founds = !best || (bestSim < this.newThreshold && durationMs >= this.minNewMs && this.voices.length < this.maxVoices);
    if (founds) {
      const voice = { id: this.voices.length + 1, centroid: e, count: 1 };
      this.voices.push(voice);
      return { voice: voice.id, similarity: bestSim, isNew: true, confident: !best || true };
    }

    // Running mean keeps the centroid representative as more is heard; an
    // ambiguous or short utterance is assigned but does not move the centroid.
    const confident = bestSim >= this.joinThreshold;
    if (confident) {
      const w = best.count / (best.count + 1);
      for (let i = 0; i < e.length; i++) best.centroid[i] = best.centroid[i] * w + e[i] * (1 - w);
      best.count += 1;
    }
    return { voice: best.id, similarity: bestSim, isNew: false, confident };
  }
}

module.exports = { VoiceClusterer, cosine };
