const test = require("node:test");
const assert = require("node:assert/strict");
const Metrics = require("../js/semantic/languageDiversityMetrics");

test("axisCoverage buckets each axis into low/mid/high bands and flags cells with zero entries as blind spots", () => {
  const entries = [
    { requires: [{ axis: "nostalgia", min: 0.8 }] },
    { requires: [{ axis: "nostalgia", min: 0.85 }, { axis: "decay", min: 0.5 }] }
  ];
  const result = Metrics.axisCoverage(entries, ["nostalgia", "decay", "warmth"]);
  assert.deepEqual(result.bands, ["low", "mid", "high"]);
  assert.equal(result.cells.length, 9, "3 axes x 3 bands");
  const nostalgiaHigh = result.cells.find(cell => cell.axis === "nostalgia" && cell.band === "high");
  assert.equal(nostalgiaHigh.count, 2, "both entries gate on nostalgia in the high band (min 0.8, 0.85)");
  const decayMid = result.cells.find(cell => cell.axis === "decay" && cell.band === "mid");
  assert.equal(decayMid.count, 1, "min 0.5 falls in the middle third of [0,1]");
  assert.ok(result.blindSpots.some(cell => cell.axis === "warmth"), "an axis with no entries at all should be entirely blind");
  assert.ok(result.blindSpots.some(cell => cell.axis === "nostalgia" && cell.band === "low"), "nostalgia has no low-band entry");
});

test("axisCoverage accepts either `requires` (aestheticRegions.json) or `region` (generated vocabulary) shaped entries", () => {
  const viaRequires = Metrics.axisCoverage([{ requires: [{ axis: "warmth", min: 0.7 }] }], ["warmth"]);
  const viaRegion = Metrics.axisCoverage([{ region: [{ axis: "warmth", min: 0.7 }] }], ["warmth"]);
  assert.deepEqual(viaRequires.cells, viaRegion.cells);
});

test("axisCoverage ignores conditions on axes outside the declared axis list, without crashing", () => {
  const result = Metrics.axisCoverage([{ requires: [{ axis: "not_a_real_axis", min: 0.9 }] }], ["warmth"]);
  assert.equal(result.cells.length, 3);
  assert.equal(result.blindSpots.length, 3, "the bogus-axis entry must not count toward any real cell");
});

test("blindSpotRatio is 1 when no entries are supplied at all", () => {
  const result = Metrics.axisCoverage([], ["nostalgia", "warmth"]);
  assert.equal(result.blindSpotRatio, 1);
});

test("vocabularyPoolSize counts DISTINCT text per epistemic layer, not raw item count", () => {
  const items = [
    { text: "밝은 음색", category: "dynamics" }, { text: "밝은 음색", category: "dynamics" }, // duplicate text, same layer
    { text: "과거의 향기", category: "association" }, { text: "짙어지는 향수", category: "mood" }
  ];
  const result = Metrics.vocabularyPoolSize(items);
  assert.equal(result.byLayer.FACT, 1, "the duplicate text must not be counted twice");
  assert.equal(result.byLayer.AESTHETIC, 1);
  assert.equal(result.byLayer.IMPRESSION, 1);
  assert.equal(result.total, 3);
});

test("vocabularyPoolSize ignores items with no usable text, never crashes on an empty pool", () => {
  assert.deepEqual(Metrics.vocabularyPoolSize([]).byLayer, Object.fromEntries(
    require("../js/semantic/languageLayerPolicy").names.map(layer => [layer, 0])));
  assert.equal(Metrics.vocabularyPoolSize([{ category: "dynamics" }, null, { text: "" }]).total, 0);
});

test("layerDistribution reports each layer's share of a selected stream, summing to 1", () => {
  const items = [
    { text: "a", category: "dynamics" }, { text: "b", category: "dynamics" }, // FACT
    { text: "c", category: "association" }, // AESTHETIC
    { text: "d", category: "mood" } // IMPRESSION
  ];
  const result = Metrics.layerDistribution(items);
  assert.ok(Math.abs(result.byLayer.FACT - 0.5) < 1e-9);
  assert.ok(Math.abs(result.byLayer.AESTHETIC - 0.25) < 1e-9);
  assert.ok(Math.abs(result.byLayer.IMPRESSION - 0.25) < 1e-9);
  assert.ok(Math.abs(result.openLayerRatio - 0.5) < 1e-9, "AESTHETIC + IMPRESSION combined");
  const sum = Object.values(result.byLayer).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("layerDistribution on an empty stream reports 0 everywhere, never NaN", () => {
  const result = Metrics.layerDistribution([]);
  assert.ok(Object.values(result.byLayer).every(value => value === 0));
  assert.equal(result.openLayerRatio, 0);
});

test("clicheDistribution reports 0 for a stream with no open-layer items at all", () => {
  const items = [{ text: "밝은 음색", category: "dynamics" }, { text: "재즈 계열", category: "lineage" }];
  assert.deepEqual(Metrics.clicheDistribution(items), { count: 0, mean: 0, max: 0 });
});

test("clicheDistribution measures higher mean/max when open-layer items lean on the known cliche family", () => {
  const clean = [{ text: "따뜻한 오후의 결", category: "mood" }, { text: "도시의 야경", category: "association" }];
  const clicheHeavy = [{ text: "과열된 긴장", category: "mood" }, { text: "차가운 황홀", category: "association" }];
  const cleanResult = Metrics.clicheDistribution(clean);
  const clicheResult = Metrics.clicheDistribution(clicheHeavy);
  assert.equal(cleanResult.count, 2);
  assert.equal(cleanResult.mean, 0);
  assert.ok(clicheResult.mean > cleanResult.mean);
  assert.ok(clicheResult.max > 0);
});
