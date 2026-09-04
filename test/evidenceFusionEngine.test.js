const test = require("node:test");
const assert = require("node:assert/strict");
const EvidenceFusion = require("../js/semantic/evidenceFusionEngine");

test("independent sources agreeing on a concept corroborate to a higher confidence than either alone", () => {
  const engine = new EvidenceFusion.Engine();
  const [fused] = engine.fuse({
    genreModel: [{ text: "UK Garage", category: "genre", confidence: 0.7 }],
    embedding: [{ text: "UK Garage", category: "genre", confidence: 0.75 }]
  });
  assert.equal(fused.text, "UK Garage");
  assert.equal(fused.evidenceCount, 2);
  assert.ok(fused.confidence > 0.75, `expected corroboration boost above 0.75, got ${fused.confidence}`);
  assert.deepEqual(fused.fusionSources.sort(), ["embedding", "genreModel"]);
});

test("a single-source item passes through close to its own confidence, without a boost", () => {
  const engine = new EvidenceFusion.Engine();
  const [fused] = engine.fuse({
    rhythm: [{ text: "four on the floor", category: "rhythm", confidence: 0.6 }]
  });
  assert.equal(fused.evidenceCount, 1);
  assert.ok(Math.abs(fused.confidence - 0.6) < 0.001);
});

test("unrelated items from different sources are kept separate, not merged", () => {
  const engine = new EvidenceFusion.Engine();
  const fused = engine.fuse({
    genreModel: [{ text: "Techno", category: "genre", confidence: 0.8 }],
    rhythm: [{ text: "four on the floor", category: "rhythm", confidence: 0.7 }]
  });
  assert.equal(fused.length, 2);
  assert.ok(fused.some(item => item.text === "Techno" && item.category === "genre"));
  assert.ok(fused.some(item => item.text === "four on the floor" && item.category === "rhythm"));
});
