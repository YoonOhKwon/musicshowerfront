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

// Project-transformation ask: a direct-audio caption (lib/directAudioReview.js's toObservations())
// participates as a genuinely independent evidence family, not a bolt-on side channel. "directAudio"
// isn't in dependencyFamily's hardcoded map, so it falls through to the raw group name -- this
// confirms that fallback actually makes it count as its own family (not silently dropped or merged
// into an existing one) and that it corroborates with a classifier read on the same concept.
test("a directAudio-sourced observation counts as its own independent evidence family and corroborates with the classifier", () => {
  const engine = new EvidenceFusion.Engine();
  const [fused] = engine.fuse({
    genreModel: [{ text: "베이퍼웨이브 미학 연상", category: "association", confidence: 0.5 }],
    directAudio: [{ text: "베이퍼웨이브 미학 연상", category: "association", confidence: 0.45, source: "directAudio" }]
  });
  assert.equal(fused.independentEvidenceCount, 2);
  assert.ok(fused.confidence > 0.5, `expected a corroboration boost, got ${fused.confidence}`);
});

test("a directAudio-only observation still passes through at its own (reduced) confidence, never boosted or dropped for being the sole source", () => {
  const engine = new EvidenceFusion.Engine();
  const [fused] = engine.fuse({
    directAudio: [{ text: "템포감", category: "production", confidence: 0.6, source: "directAudio" }]
  });
  assert.equal(fused.independentEvidenceCount, 1);
  assert.ok(Math.abs(fused.confidence - 0.6) < 0.01, `single source passes through unweighted, got ${fused.confidence}`);
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
