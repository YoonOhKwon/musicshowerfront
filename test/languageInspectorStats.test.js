const test = require("node:test");
const assert = require("node:assert/strict");
const Inspector = require("../js/semantic/languageInspector");

test("layerTier collapses the five epistemic layers into the project's own strict/middle/open tiers", () => {
  assert.equal(Inspector.layerTier("LIVE"), "strict");
  assert.equal(Inspector.layerTier("FACT"), "strict");
  assert.equal(Inspector.layerTier("CONTEXT"), "middle");
  assert.equal(Inspector.layerTier("AESTHETIC"), "open");
  assert.equal(Inspector.layerTier("IMPRESSION"), "open");
  assert.equal(Inspector.layerTier("NOT_A_LAYER"), "unknown");
});

test("axisBucket groups evidence-axis counts into 1 / 2 / 3+", () => {
  assert.equal(Inspector.axisBucket(0), "1");
  assert.equal(Inspector.axisBucket(1), "1");
  assert.equal(Inspector.axisBucket(2), "2");
  assert.equal(Inspector.axisBucket(3), "3+");
  assert.equal(Inspector.axisBucket(6), "3+");
});

test("selectionStatsOf reports candidate/selected counts and the overall selection rate", () => {
  const candidates = [
    { text: "a", layer: "FACT", score: 0.9, diagnostics: { evidenceAxes: ["x", "y"] } },
    { text: "b", layer: "AESTHETIC", score: 0.5, valid: false, diagnostics: { evidenceAxes: ["x"], rejectionReason: "insufficient-evidence" } },
    { text: "c", layer: "IMPRESSION", score: 0.7, diagnostics: { evidenceAxes: ["x", "y", "z"] } }
  ];
  const stats = Inspector.selectionStatsOf(candidates, new Set(["a", "c"]));
  assert.equal(stats.candidateCount, 3);
  assert.equal(stats.selectedCount, 2);
  assert.ok(Math.abs(stats.selectionRate - 2 / 3) < 1e-9);
});

test("selectionStatsOf breaks selection down by strict/middle/open tier", () => {
  const candidates = [
    { text: "fact1", layer: "FACT", score: 0.9, diagnostics: { evidenceAxes: [] } },
    { text: "fact2", layer: "FACT", score: 0.8, diagnostics: { evidenceAxes: [] } },
    { text: "ctx1", layer: "CONTEXT", score: 0.6, diagnostics: { evidenceAxes: [] } },
    { text: "aes1", layer: "AESTHETIC", score: 0.4, diagnostics: { evidenceAxes: [] } }
  ];
  const stats = Inspector.selectionStatsOf(candidates, new Set(["fact1", "ctx1"]));
  assert.deepEqual(stats.byLayerTier.strict, { total: 2, selected: 1 });
  assert.deepEqual(stats.byLayerTier.middle, { total: 1, selected: 1 });
  assert.deepEqual(stats.byLayerTier.open, { total: 1, selected: 0 });
});

test("selectionStatsOf breaks selection down by axis-combination size, so 3+ axis survival is directly readable", () => {
  const candidates = [
    { text: "one-axis", layer: "AESTHETIC", score: 0.5, diagnostics: { evidenceAxes: ["x"] } },
    { text: "three-axis-a", layer: "AESTHETIC", score: 0.6, diagnostics: { evidenceAxes: ["x", "y", "z"] } },
    { text: "three-axis-b", layer: "AESTHETIC", score: 0.5, diagnostics: { evidenceAxes: ["x", "y", "z"] } }
  ];
  const stats = Inspector.selectionStatsOf(candidates, new Set(["three-axis-a"]));
  assert.deepEqual(stats.byAxisBucket["1"], { total: 1, selected: 0 });
  assert.deepEqual(stats.byAxisBucket["3+"], { total: 2, selected: 1 });
});

test("selectionStatsOf lists the top dropped candidates by score, with their rejection reason", () => {
  const candidates = [
    { text: "kept", layer: "FACT", score: 0.95, diagnostics: { evidenceAxes: [] } },
    { text: "dropped-high", layer: "AESTHETIC", score: 0.7, valid: false, diagnostics: { evidenceAxes: [], rejectionReason: "generic-ai-poetry" } },
    { text: "dropped-low", layer: "IMPRESSION", score: 0.2, valid: false, diagnostics: { evidenceAxes: [], rejectionReason: "duplicate-concept" } }
  ];
  const stats = Inspector.selectionStatsOf(candidates, new Set(["kept"]));
  assert.equal(stats.topDropped[0].text, "dropped-high");
  assert.equal(stats.topDropped[0].rejectionReason, "generic-ai-poetry");
  assert.equal(stats.topDropped[1].text, "dropped-low");
});

test("selectionStatsOf never divides by zero on an empty candidate list", () => {
  const stats = Inspector.selectionStatsOf([], new Set());
  assert.equal(stats.candidateCount, 0);
  assert.equal(stats.selectionRate, 0);
  assert.deepEqual(stats.topDropped, []);
});
