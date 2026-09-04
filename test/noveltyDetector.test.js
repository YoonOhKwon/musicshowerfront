const test = require("node:test");
const assert = require("node:assert/strict");
const NoveltyDetector = require("../js/ml/noveltyDetector");

test("stable audio produces low novelty", () => {
  const detector = new NoveltyDetector.Detector({ smoothing: 1 });
  const frame = { rms: 0.1, flux: 0.01, centroid: 1200, bpm: 120, bass: 0.3, mid: 0.4, high: 0.2 };
  detector.update(frame);
  assert.ok(detector.update(frame).score < 0.01);
});

test("large feature jump produces high novelty", () => {
  const detector = new NoveltyDetector.Detector({ smoothing: 1, threshold: 0.2 });
  detector.update({ rms: 0.01, flux: 0, centroid: 200, bpm: 70, bass: 0.05, mid: 0.05, high: 0.05 });
  const result = detector.update({ rms: 0.25, flux: 0.08, centroid: 11000, bpm: 170, bass: 0.9, mid: 0.8, high: 0.9 });
  assert.ok(result.score > 0.3);
  assert.equal(result.transitionDetected, true);
});

test("embedding novelty uses cosine distance without clamping signed vectors", () => {
  assert.ok(NoveltyDetector.cosineDistance([1, 0], [1, 0]) < 1e-9);
  assert.ok(NoveltyDetector.cosineDistance([1, 0], [0, 1]) > 0.99);
  assert.ok(NoveltyDetector.cosineDistance([-1, 0], [1, 0]) > 0.99);
});
