const test = require("node:test");
const assert = require("node:assert/strict");
const Selection = require("../js/visual/phraseSelection");

test("evidenceReadinessOf folds confidence/coverage/stability into one bounded scalar, honest about a missing genre read", () => {
  assert.equal(Selection.evidenceReadinessOf(null), 0);
  assert.equal(Selection.evidenceReadinessOf({}), 0, "missing fields must not be treated as full confidence");
  assert.equal(Selection.evidenceReadinessOf({ semanticConfidence: 1, evidenceCoverage: 1, temporalStability: 1 }), 1);
  const partial = Selection.evidenceReadinessOf({ semanticConfidence: 0.8, evidenceCoverage: 0.5, temporalStability: 0.5 });
  assert.ok(Math.abs(partial - 0.2) < 1e-9, `expected the product 0.8*0.5*0.5, got ${partial}`);
});

test("45s+ layer ratios sum to 1 and FACT stays the single largest layer (music-first, not aesthetic-first)", () => {
  const ratios = Selection.layerRatios(60, false);
  const total = Object.values(ratios).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `ratios must sum to 1, got ${total}`);
  const largest = Object.entries(ratios).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(largest, "FACT");
});

test("45s+ gives AESTHETIC+IMPRESSION meaningfully more room than the 30-45s band, reflecting sustained-listening confidence", () => {
  const midBand = Selection.layerRatios(40, false);
  const deepBand = Selection.layerRatios(60, false);
  const midOpen = midBand.AESTHETIC + midBand.IMPRESSION;
  const deepOpen = deepBand.AESTHETIC + deepBand.IMPRESSION;
  assert.ok(deepOpen > midOpen * 1.5, `expected a real increase, got ${midOpen} -> ${deepOpen}`);
});

// Regression coverage for a real bug this project shipped and then fixed: choose()'s layer draw
// (js/visual/phraseSelection.js) is a share of only the layers actually PRESENT in that tick's
// candidate pool -- a layer with no candidates contributes nothing to the sum, and its ratio
// silently redistributes onto whichever layers ARE present. An earlier 45s+ ratio (AESTHETIC 0.30 +
// IMPRESSION 0.30, FACT only 0.15) meant that whenever a pool had no AESTHETIC candidates, CONTEXT's
// unchanged 0.20 share ballooned to ~29% of the remaining budget -- breaking
// test/realtimeLanguage.test.js's "category scheduling" test, whose synthetic pool has no
// AESTHETIC items. This computes the same redistribution directly and keeps it bounded.
test("if AESTHETIC has no candidates this tick, CONTEXT's redistributed share stays reasonable (does not spike)", () => {
  const ratios = Selection.layerRatios(60, false);
  const withoutAesthetic = { ...ratios };
  delete withoutAesthetic.AESTHETIC;
  const total = Object.values(withoutAesthetic).reduce((sum, value) => sum + value, 0);
  const contextShare = withoutAesthetic.CONTEXT / total;
  assert.ok(contextShare < 0.25, `CONTEXT's redistributed share spiked to ${contextShare}`);
});

// Regression coverage for the project-transformation ask: layer scheduling must react to how
// confident/stable the engine's OWN genre reasoning already is, not elapsed session time alone --
// a fast, sure read should reach CONTEXT/AESTHETIC sooner than the raw clock would grant.
test("evidenceReadiness pulls the layer schedule toward a later time band at the same observationSeconds", () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pool = ["genre", "live", "dynamics"].flatMap(category =>
    Array.from({ length: 4 }, (_, i) => ({ text: category + i, category, weight: 1 })));
  const sample = evidenceReadiness => {
    seed = 7;
    const counts = { genre: 0, live: 0, dynamics: 0 };
    for (let i = 0; i < 8000; i++) counts[Selection.choose(pool, [], random, { observationSeconds: 10, evidenceReadiness }).category]++;
    return counts;
  };
  // At observationSeconds=10 alone (the "<15s" band: CONTEXT 0.23), readiness=1 doubles the
  // effective seconds to 20 (the "<30s" band: CONTEXT 0.33) -- genre/CONTEXT's share should rise.
  const noReadiness = sample(0), fullReadiness = sample(1);
  assert.ok(fullReadiness.genre > noReadiness.genre * 1.2,
    `expected readiness to raise CONTEXT share, got ${noReadiness.genre} -> ${fullReadiness.genre}`);
});
