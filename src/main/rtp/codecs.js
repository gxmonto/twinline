'use strict';
/**
 * G.711 µ-law and A-law (ITU-T G.711 / RFC 3551), implemented as lookup
 * tables built from the reference segment algorithm.
 *
 * All PCM here is 16-bit signed, 8 kHz, mono, in Int16Array form.
 */

const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;
const BIAS = 0x84;
const CLIP = 8159;

const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

function search(value, table) {
  for (let i = 0; i < table.length; i++) if (value <= table[i]) return i;
  return table.length;
}

function linear2ulaw(pcm) {
  let value = pcm >> 2;              // 14-bit
  let mask;
  if (value < 0) { value = -value; mask = 0x7f; } else { mask = 0xff; }
  if (value > CLIP) value = CLIP;
  value += BIAS >> 2;

  const seg = search(value, SEG_UEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  return (((seg << 4) | ((value >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

function ulaw2linear(u) {
  const val = (~u) & 0xff;
  let t = ((val & QUANT_MASK) << 3) + BIAS;
  t <<= (val & SEG_MASK) >> SEG_SHIFT;
  return (val & SIGN_BIT) ? (BIAS - t) : (t - BIAS);
}

function linear2alaw(pcm) {
  let value = pcm >> 3;              // 13-bit
  let mask;
  if (value >= 0) { mask = 0xd5; } else { mask = 0x55; value = -value - 1; }

  const seg = search(value, SEG_AEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;

  let aval = seg << SEG_SHIFT;
  aval |= seg < 2 ? (value >> 1) & QUANT_MASK : (value >> seg) & QUANT_MASK;
  return (aval ^ mask) & 0xff;
}

function alaw2linear(a) {
  const val = a ^ 0x55;
  let t = (val & QUANT_MASK) << 4;
  const seg = (val & SEG_MASK) >> SEG_SHIFT;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else { t += 0x108; t <<= seg - 1; }
  return (val & SIGN_BIT) ? t : -t;
}

// Precomputed tables: encoding is indexed by (sample + 32768).
const ULAW_ENCODE = new Uint8Array(65536);
const ALAW_ENCODE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) {
  const sample = i - 32768;
  ULAW_ENCODE[i] = linear2ulaw(sample);
  ALAW_ENCODE[i] = linear2alaw(sample);
}

const ULAW_DECODE = new Int16Array(256);
const ALAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  ULAW_DECODE[i] = ulaw2linear(i);
  ALAW_DECODE[i] = alaw2linear(i);
}

/** Encode Int16 PCM to a µ-law Buffer. */
function encodePCMU(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ULAW_ENCODE[(pcm[i] + 32768) & 0xffff];
  return out;
}

/** Decode a µ-law Buffer to Int16 PCM. */
function decodePCMU(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ULAW_DECODE[buf[i]];
  return out;
}

function encodePCMA(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ALAW_ENCODE[(pcm[i] + 32768) & 0xffff];
  return out;
}

function decodePCMA(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ALAW_DECODE[buf[i]];
  return out;
}

/**
 * Codec registry. `staticPt` is the RFC 3551 static payload type, used when a
 * peer offers the format with no matching a=rtpmap line.
 */
const CODECS = {
  PCMU: {
    name: 'PCMU', rate: 8000, channels: 1, staticPt: 0, bytesPerSample: 1,
    encode: encodePCMU, decode: decodePCMU,
    silence: (samples) => Buffer.alloc(samples, ULAW_ENCODE[32768]),
  },
  PCMA: {
    name: 'PCMA', rate: 8000, channels: 1, staticPt: 8, bytesPerSample: 1,
    encode: encodePCMA, decode: decodePCMA,
    silence: (samples) => Buffer.alloc(samples, ALAW_ENCODE[32768]),
  },
};

/** Resolve a preference list of codec names to descriptors. */
function preferenceList(names) {
  const out = [];
  for (const n of names || ['PCMU', 'PCMA']) {
    const codec = CODECS[String(n).toUpperCase()];
    if (codec && !out.includes(codec)) out.push(codec);
  }
  return out.length ? out : [CODECS.PCMU];
}

/** Codec descriptors in SDP offer form, with their static payload types. */
function offerCodecs(names) {
  return preferenceList(names).map((c) => ({
    pt: c.staticPt, name: c.name, rate: c.rate, channels: c.channels,
  }));
}

module.exports = {
  CODECS,
  preferenceList,
  offerCodecs,
  encodePCMU, decodePCMU, encodePCMA, decodePCMA,
  linear2ulaw, ulaw2linear, linear2alaw, alaw2linear,
};
