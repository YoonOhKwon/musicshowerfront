"use strict";

// Local production measurements over one capture window (mono PCM), independent of Music Flamingo:
// tempo and beat grid from spectral flux, bar-level loop repetition, and beat-aligned sidechain
// ducking (the same detector the browser engine uses). A loop cut from a recording repeats almost
// identically bar to bar; a performed part varies, so repetition is measured as the correlation of
// consecutive bar-length spectrogram segments.

const RhythmicGrammar = require("../js/semantic/rhythmicGrammar");

const FRAME = 1024;
const BANDS = 40;
const MIN_BPM = 70;
const MAX_BPM = 180;

function fftMagnitudes(frame, real, imaginary) {
  const size = frame.length;
  for (let i = 0; i < size; i++) {
    real[i] = frame[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    imaginary[i] = 0;
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; }
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
}

// Log-spaced band energies per frame, a low-band (<150 Hz) envelope and positive spectral flux.
function spectrogram(samples, sampleRate, hop) {
  const frames = Math.floor((samples.length - FRAME) / hop) + 1;
  if (frames < 32) return null;
  const real = new Float64Array(FRAME), imaginary = new Float64Array(FRAME);
  const binHz = sampleRate / FRAME;
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => 40 * Math.pow(Math.min(7000, sampleRate / 2 - binHz) / 40, i / BANDS));
  const bandOf = new Int16Array(FRAME / 2).fill(-1);
  for (let bin = 1; bin < FRAME / 2; bin++) {
    const hz = bin * binHz;
    for (let band = 0; band < BANDS; band++) if (hz >= edges[band] && hz < edges[band + 1]) { bandOf[bin] = band; break; }
  }
  const lowLimit = Math.ceil(150 / binHz);
  const bands = new Float32Array(frames * BANDS);
  const low = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const frame = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) frame[i] = samples[f * hop + i] || 0;
    fftMagnitudes(frame, real, imaginary);
    const energy = new Float64Array(BANDS);
    let lowEnergy = 0;
    for (let bin = 1; bin < FRAME / 2; bin++) {
      const power = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
      if (bandOf[bin] >= 0) energy[bandOf[bin]] += power;
      if (bin <= lowLimit) lowEnergy += power;
    }
    let rise = 0;
    for (let band = 0; band < BANDS; band++) {
      const value = Math.log1p(energy[band] * 1e3);
      bands[f * BANDS + band] = value;
      if (f) rise += Math.max(0, value - bands[(f - 1) * BANDS + band]);
    }
    low[f] = Math.sqrt(lowEnergy);
    flux[f] = rise;
  }
  // Remove each band's mean level. Otherwise the fixed spectral tilt (bass louder than air) dominates
  // the segment correlation and any music looks repetitive; what should match is the time pattern.
  for (let band = 0; band < BANDS; band++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += bands[f * BANDS + band];
    const mean = sum / frames;
    for (let f = 0; f < frames; f++) bands[f * BANDS + band] -= mean;
  }
  return { frames, bands, low, flux };
}

// Beat period (frames, fractional) and phase from the flux autocorrelation, favouring periods whose
// double also correlates so a half-tempo reading does not win.
function beatGrid(flux, hopSeconds) {
  const n = flux.length;
  const mean = flux.reduce((a, b) => a + b, 0) / n;
  const centered = Float64Array.from(flux, value => value - mean);
  const minLag = Math.floor(60 / MAX_BPM / hopSeconds);
  const maxLag = Math.ceil(60 / MIN_BPM / hopSeconds);
  const acf = new Float64Array(maxLag * 2 + 2);
  for (let lag = 0; lag < acf.length && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += centered[i] * centered[i + lag];
    acf[lag] = sum / (n - lag);
  }
  if (!(acf[0] > 0)) return null;
  let bestLag = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = acf[lag] + 0.5 * (acf[lag * 2] || 0);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const [a, b, c] = [acf[bestLag - 1], acf[bestLag], acf[bestLag + 1]];
  const denominator = a - 2 * b + c;
  const period = bestLag + (denominator ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator)) : 0);
  const confidence = Math.max(0, Math.min(1, acf[bestLag] / acf[0] * 2.5));
  let phase = 0, phaseScore = -Infinity;
  for (let offset = 0; offset < bestLag; offset++) {
    let sum = 0;
    for (let t = offset; t < n; t += period) sum += flux[Math.round(t)] || 0;
    if (sum > phaseScore) { phaseScore = sum; phase = offset; }
  }
  return { period, phase, bpm: 60 / (period * hopSeconds), confidence };
}

function pearson(bands, startA, startB, length) {
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  const count = length * BANDS;
  for (let i = 0; i < count; i++) {
    const x = bands[startA * BANDS + i], y = bands[startB * BANDS + i];
    sumA += x; sumB += y; sumAB += x * y; sumA2 += x * x; sumB2 += y * y;
  }
  const covariance = sumAB - sumA * sumB / count;
  const variance = Math.sqrt((sumA2 - sumA * sumA / count) * (sumB2 - sumB * sumB / count));
  return variance > 0 ? covariance / variance : 0;
}

// Median correlation of consecutive n-bar segments, searched over a small alignment offset.
function barRepetition(spec, grid, bars) {
  const segment = grid.period * 4 * bars;
  const length = Math.round(segment);
  const starts = [];
  for (let t = grid.phase; Math.round(t) + length <= spec.frames; t += segment) starts.push(Math.round(t));
  if (starts.length < 3) return null;
  const scores = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    let best = -1;
    for (let shift = -2; shift <= 2; shift++) {
      const next = starts[i + 1] + shift;
      if (next < 0 || next + length > spec.frames) continue;
      best = Math.max(best, pearson(spec.bands, starts[i], next, length));
    }
    scores.push(best);
  }
  scores.sort((x, y) => x - y);
  return scores[Math.floor(scores.length / 2)];
}

function analyzeLoopEvidence(samples, sampleRate = 16000) {
  const hop = Math.round(sampleRate * 0.02);
  const hopSeconds = hop / sampleRate;
  const spec = samples && samples.length ? spectrogram(samples, sampleRate, hop) : null;
  if (!spec) return null;
  const grid = beatGrid(spec.flux, hopSeconds);
  if (!grid) return null;
  let loopRepetition = null, loopBars = null;
  for (const bars of [1, 2, 4]) {
    const score = barRepetition(spec, grid, bars);
    if (score !== null && (loopRepetition === null || score > loopRepetition)) { loopRepetition = score; loopBars = bars; }
  }
  const envelope = Array.from(spec.low, (value, frame) => ({ at: frame * hopSeconds * 1000, value }));
  const beatTimestamps = [];
  for (let t = grid.phase; t < spec.frames; t += grid.period) beatTimestamps.push(t * hopSeconds * 1000);
  const sidechain = RhythmicGrammar.detectSidechain(envelope, beatTimestamps, grid.confidence);
  const round = value => value === null || value === undefined ? null : Number(value.toFixed(3));
  return { seconds: round(samples.length / sampleRate), tempoBpm: round(grid.bpm), beatConfidence: round(grid.confidence),
    loopRepetition: round(loopRepetition), loopBars, sidechain: round(sidechain) };
}

module.exports = { analyzeLoopEvidence };
