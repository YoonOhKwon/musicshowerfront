const test = require("node:test");
const assert = require("node:assert/strict");
const SignalMath = require("../js/audio/signalMath");

test("frequency bands are normalized by their own bin counts", () => {
  const spectrum = new Uint8Array(2048).fill(255);
  const bands = SignalMath.averageBands(spectrum, 48000, 4096, {
    bass: [20, 250],
    mid: [250, 2000],
    high: [2000, 12000]
  });
  assert.equal(bands.bass, 1);
  assert.equal(bands.mid, 1);
  assert.equal(bands.high, 1);
});

test("spectral flux ignores falling energy and averages positive change", () => {
  const previous = Uint8Array.from([100, 200, 20, 0]);
  const current = Uint8Array.from([150, 150, 20, 255]);
  const expected = (50 / 255 + 1) / 4;
  assert.ok(Math.abs(SignalMath.spectralFlux(current, previous) - expected) < 1e-12);
});

test("tempo candidates fold into a musically useful range", () => {
  assert.equal(SignalMath.foldBpm(60, 75, 175), 120);
  assert.equal(SignalMath.foldBpm(180, 75, 175), 90);
  assert.equal(SignalMath.foldBpm(128, 75, 175), 128);
});

test("normalized distance compares compact feature fingerprints", () => {
  assert.equal(SignalMath.normalizedDistance([0, 0.5, 1], [0, 0.5, 1]), 0);
  assert.ok(SignalMath.normalizedDistance([0, 0, 0], [1, 1, 1]) > 0.99);
});

test("mean vector distance captures note-profile movement", () => {
  assert.equal(SignalMath.meanVectorDistance([[0, 1], [0, 1], [0, 1]]), 0);
  assert.equal(SignalMath.meanVectorDistance([[0, 1], [1, 0]]), 1);
});

test("ratio above measures transient density", () => {
  assert.equal(SignalMath.ratioAbove([0.1, 0.5, 0.8, 0.2], 0.4), 0.5);
  assert.equal(SignalMath.ratioAbove([], 0.4), 0);
});
