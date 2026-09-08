"use strict";

const Expressions = require("../js/semantic/musicExpressionEngine");

// The same physical measurements consumed by the browser's expression engine. The
// visualizer's 0..1 effect controls are deliberately not used as musical evidence.
function measureFrame(samples, sampleRate) {
  const size = 2048;
  const real = new Float64Array(size), imaginary = new Float64Array(size);
  const offset = Math.max(0, samples.length - size);
  for (let i = 0; i < size; i++) {
    real[i] = (samples[offset + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    for (let start = 0; start < size; start += length) {
      for (let j = 0; j < length / 2; j++) {
        const a = start + j, b = a + length / 2;
        const cosine = Math.cos(angle * j), sine = Math.sin(angle * j);
        const r = real[b] * cosine - imaginary[b] * sine;
        const im = real[b] * sine + imaginary[b] * cosine;
        real[b] = real[a] - r; imaginary[b] = imaginary[a] - im;
        real[a] += r; imaginary[a] += im;
      }
    }
  }
  const spectrum = Float32Array.from(real.subarray(0, size / 2), (r, i) =>
    20 * Math.log10(Math.max(1e-12, Math.hypot(r, imaginary[i]) / size)));
  return { ...Expressions.measure(samples), ...Expressions.measureSpectrum(spectrum, sampleRate, size) };
}

module.exports = { measureFrame };
