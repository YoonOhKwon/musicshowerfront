const test = require("node:test");
const assert = require("node:assert/strict");
const ZeroShotGenre = require("../js/ml/zeroShotGenre");

test("zero-shot refuses unavailable or dimension-mismatched assets", () => {
  const unavailable = new ZeroShotGenre.Classifier({
    available: false, model: "clap", dimension: 2,
    entries: [{ label: "House", embedding: [1, 0] }]
  });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.classify([1, 0]), []);

  const available = new ZeroShotGenre.Classifier({
    available: true, model: "clap", audioEncoder: "same-checkpoint", dimension: 2,
    entries: [{ label: "House", embedding: [1, 0] }]
  });
  assert.deepEqual(available.classify([1, 0, 0]), []);
  assert.equal(available.classify([1, 0])[0].label, "House");
});
