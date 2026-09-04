const test = require("node:test");
const assert = require("node:assert/strict");
const GenreTracking = require("../js/ml/genreTracker");

const prediction = (label, confidence) => ({ label, confidence });

test("genre tracker stays stable through minor prediction noise", () => {
  const tracker = new GenreTracking.GenreTracker({ persistence: 2, switchMargin: 0.12 });
  for (let index = 0; index < 5; index++) {
    tracker.update([prediction("House", 0.8), prediction("Techno", 0.2)]);
  }
  const noisy = tracker.update([prediction("Techno", 0.53), prediction("House", 0.47)], { novelty: 0.05 });
  assert.equal(noisy.primary, "House");
});

test("persistent new genre switches the tracker", () => {
  const tracker = new GenreTracking.GenreTracker({ persistence: 2, switchMargin: 0.05 });
  tracker.update([prediction("House", 0.9), prediction("Jungle", 0.1)]);
  let state;
  for (let index = 0; index < 8; index++) {
    state = tracker.update([prediction("Jungle", 0.92), prediction("House", 0.08)], { novelty: 0.45 });
  }
  assert.equal(state.primary, "Jungle");
});

test("genre uncertainty rejects low-margin high-entropy predictions", () => {
  const uncertain = GenreTracking.assessUncertainty([
    prediction("IDM", 0.34), prediction("Glitch", 0.33), prediction("Breakcore", 0.33)
  ]);
  const confident = GenreTracking.assessUncertainty([
    prediction("Jazz", 0.9), prediction("Soul", 0.1)
  ]);
  assert.equal(uncertain.uncertain, true);
  assert.equal(confident.uncertain, false);
});

test("multi-label confidence remains absolute instead of being renormalized", () => {
  const low = GenreTracking.normalizePredictions([
    prediction("House", 0.1), prediction("Techno", 0.05)
  ]);
  const high = GenreTracking.normalizePredictions([
    prediction("House", 0.9), prediction("Techno", 0.45)
  ]);
  assert.equal(low[0].confidence, 0.1);
  assert.equal(high[0].confidence, 0.9);
  assert.ok(Math.abs(low[0].probability - high[0].probability) < 1e-9);
  assert.equal(GenreTracking.assessUncertainty(low, { entropyThreshold: 1 }).uncertain, true);
  assert.equal(GenreTracking.assessUncertainty(high, { entropyThreshold: 1 }).uncertain, false);
});
