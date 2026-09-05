const test = require("node:test");
const assert = require("node:assert/strict");
const Selection = require("../js/visual/phraseSelection");

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
