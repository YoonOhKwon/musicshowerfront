const test = require("node:test");
const assert = require("node:assert/strict");
const SemanticChange = require("../js/semantic/semanticChange");

test("one beat-sized novelty spike does not replace the semantic epoch", () => {
  const detector = new SemanticChange.Detector({ threshold: 0.3, cooldownMs: 0 });
  detector.update({ embedding: [1, 0], genre: [{ label: "House", confidence: 0.1 }], character: [0.3, 0.4] }, 0);
  const result = detector.update({ embedding: [1, 0], genre: [{ label: "House", confidence: 0.1 }], character: [0.3, 0.4], novelty: 1 }, 1000);
  assert.equal(result.changed, false);
  assert.equal(result.epoch, 0);
});

test("corroborated embedding, genre and character change increments epoch", () => {
  const detector = new SemanticChange.Detector({ threshold: 0.3, cooldownMs: 0 });
  detector.update({ embedding: [1, 0], genre: [{ label: "House", confidence: 0.1 }], character: [0.1, 0.2] }, 0);
  const result = detector.update({ embedding: [0, 1], genre: [{ label: "Jungle", confidence: 0.11 }], character: [0.9, 0.8], novelty: 0.8, sectionTransition: true }, 1000);
  assert.equal(result.changed, true);
  assert.equal(result.epoch, 1);
});

test("first useful musical evidence can explicitly leave the startup epoch", () => {
  const detector = new SemanticChange.Detector();
  assert.equal(detector.advance(1000), 1);
  assert.equal(detector.epoch, 1);
});
