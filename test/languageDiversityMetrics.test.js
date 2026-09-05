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
