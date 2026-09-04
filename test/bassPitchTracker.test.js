const test = require("node:test");
const assert = require("node:assert/strict");
const BassPitchTracker = require("../js/audio/bassPitchTracker");

const SAMPLE_RATE = 48000;
const FFT_SIZE = 4096;
const BIN_COUNT = 32;

// startBin=3, endBin=22 for the default [41,250]Hz range at this sample rate/fftSize.
function spectrumWithPeak(bin, peak = 255, background = 20) {
  const data = new Uint8Array(BIN_COUNT).fill(background);
  if (bin >= 0 && bin < BIN_COUNT) data[bin] = peak;
  return data;
}

function flatSpectrum(level = 40) {
  return new Uint8Array(BIN_COUNT).fill(level);
}

test("a repeated bass note at regular intervals shows low pitch motion and high regularity", () => {
  const tracker = new BassPitchTracker.Tracker();
  const onsets = [];
  for (let index = 0; index < 12; index++) {
    const at = index * 500;
    tracker.observeFrame(spectrumWithPeak(10), SAMPLE_RATE, FFT_SIZE, at);
    onsets.push(at);
  }
  const profile = tracker.profile(onsets);
  assert.ok(profile.bassPitchMotion !== null, "expected a motion value, not null");
  assert.ok(profile.bassPitchMotion < 0.15, `expected low motion for a repeated note, got ${profile.bassPitchMotion}`);
  assert.ok(profile.bassOnsetRegularity > 0.85, `expected high regularity for evenly spaced onsets, got ${profile.bassOnsetRegularity}`);
});

test("a bassline stepping between distinct notes shows higher pitch motion", () => {
  const tracker = new BassPitchTracker.Tracker();
  const onsets = [];
  const bins = [5, 9, 13, 17, 5, 9, 13, 17, 5, 9, 13, 17];
  for (let index = 0; index < bins.length; index++) {
    const at = index * 500;
    tracker.observeFrame(spectrumWithPeak(bins[index]), SAMPLE_RATE, FFT_SIZE, at);
    onsets.push(at);
  }
  const profile = tracker.profile(onsets);
  assert.ok(profile.bassPitchMotion > 0.4, `expected clearly higher motion for a moving bassline, got ${profile.bassPitchMotion}`);
});

test("irregular onset spacing lowers regularity even with a stable note", () => {
  const tracker = new BassPitchTracker.Tracker();
  const onsets = [0, 210, 640, 720, 1500, 1550, 3200, 3210, 5000, 5900, 7000, 7050];
  for (const at of onsets) tracker.observeFrame(spectrumWithPeak(10), SAMPLE_RATE, FFT_SIZE, at);
  const profile = tracker.profile(onsets);
  assert.ok(profile.bassOnsetRegularity < 0.5, `expected low regularity for jittery onsets, got ${profile.bassOnsetRegularity}`);
});

test("fewer than 8 onsets refuses to guess", () => {
  const tracker = new BassPitchTracker.Tracker();
  const onsets = [];
  for (let index = 0; index < 5; index++) {
    const at = index * 500;
    tracker.observeFrame(spectrumWithPeak(10), SAMPLE_RATE, FFT_SIZE, at);
    onsets.push(at);
  }
  const profile = tracker.profile(onsets);
  assert.equal(profile.bassPitchMotion, null);
  assert.equal(profile.bassOnsetRegularity, null);
});

test("a flat, unpitched bass band refuses to claim note movement", () => {
  const tracker = new BassPitchTracker.Tracker();
  const onsets = [];
  for (let index = 0; index < 12; index++) {
    const at = index * 500;
    tracker.observeFrame(flatSpectrum(), SAMPLE_RATE, FFT_SIZE, at);
    onsets.push(at);
  }
  const profile = tracker.profile(onsets);
  assert.equal(profile.bassPitchMotion, null);
  assert.equal(profile.bassOnsetRegularity, null);
});

test("reset clears accumulated history", () => {
  const tracker = new BassPitchTracker.Tracker();
  for (let index = 0; index < 12; index++) tracker.observeFrame(spectrumWithPeak(10), SAMPLE_RATE, FFT_SIZE, index * 500);
  tracker.reset();
  const profile = tracker.profile([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  assert.equal(profile.sampleCount, 0);
});
