'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { VoiceClusterer, cosine } = require('../src/main/transcribe/voices');

/** A unit vector near `base`, jittered so no two utterances are identical. */
function near(base, jitter = 0.05) {
  return base.map((v) => v + (Math.random() - 0.5) * jitter);
}
const A = [1, 0, 0, 0];
const B = [0, 1, 0, 0];
const C = [0, 0, 1, 0];

test('cosine similarity', () => {
  assert.ok(Math.abs(cosine(A, A) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(A, B)) < 1e-9);
  assert.strictEqual(cosine([0, 0], [1, 1]), 0);
});

test('utterances from the same voice share one label; a clearly new voice gets the next number', () => {
  const vc = new VoiceClusterer();
  assert.strictEqual(vc.assign(near(A), 3000).voice, 1);
  assert.strictEqual(vc.assign(near(A), 3000).voice, 1);
  const b = vc.assign(near(B), 3000);
  assert.strictEqual(b.voice, 2);
  assert.strictEqual(b.isNew, true);
  assert.strictEqual(vc.assign(near(A), 2500).voice, 1, 'the first voice keeps its number');
  assert.strictEqual(vc.assign(near(B), 2500).voice, 2);
  assert.strictEqual(vc.assign(near(C), 3000).voice, 3);
  assert.strictEqual(vc.count, 3);
});

test('a short, unfamiliar utterance is assigned to the closest voice instead of founding one', () => {
  const vc = new VoiceClusterer();
  vc.assign(near(A), 3000);
  const r = vc.assign(near(B), 1500);              // 1.5 s: not enough to be sure it is someone new
  assert.strictEqual(r.voice, 1);
  assert.strictEqual(r.isNew, false);
  assert.strictEqual(r.confident, false, 'and it is flagged as a guess');
  assert.strictEqual(vc.count, 1);
  assert.strictEqual(vc.assign(near(B), 2500).voice, 2, 'a long enough utterance from that voice does found one');
});

test('an utterance that is neither clearly the same nor clearly different never founds a voice', () => {
  // Similarity ~0.35: above the "new voice" bar, below the "confident join" bar.
  const vc = new VoiceClusterer();
  vc.assign([1, 0, 0, 0], 3000);
  const r = vc.assign([0.35, 0.94, 0, 0], 4000);
  assert.strictEqual(r.voice, 1);
  assert.strictEqual(r.isNew, false);
  assert.strictEqual(r.confident, false);
  assert.strictEqual(vc.count, 1, 'ambiguity errs towards one speaker');
});

test('centroids drift towards what is heard, but not from doubtful clips', () => {
  const vc = new VoiceClusterer();
  vc.assign([1, 0, 0, 0], 3000);
  vc.assign([0.9, 0.1, 0, 0], 3000);
  const c = vc.voices[0].centroid;
  assert.ok(c[1] > 0.04 && c[1] < 0.06, `centroid moved: ${c[1]}`);
  vc.assign([0.3, 0.95, 0, 0], 3000);              // ambiguous (~0.35): assigned, not learned
  assert.ok(vc.voices[0].centroid[1] < 0.06);
});

test('the number of voices is capped', () => {
  const vc = new VoiceClusterer({ maxVoices: 2 });
  vc.assign(A, 3000); vc.assign(B, 3000);
  assert.ok(vc.assign(C, 3000).voice <= 2);
  assert.strictEqual(vc.count, 2);
});
