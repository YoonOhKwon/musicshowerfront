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

test("visible-layer occupancy prioritizes a newly available deep-listening layer", () => {
  const candidates = [
    { text: "단단한 킥", category: "production", layer: "FACT", weight: 1 },
    { text: "빛바랜 상업 공간의 미학", category: "association", layer: "AESTHETIC", weight: 1 }
  ];
  const active = Array.from({ length: 8 }, (_, index) => ({
    text: `현재 사실 ${index}`, category: "production", layer: "FACT"
  }));
  const progressiveEngine = { getLayerWeights: () => ({
    LIVE: 0, FACT: 0.35, CONTEXT: 0.15, AESTHETIC: 0.35, IMPRESSION: 0.15
  }) };
  const selected = Selection.choose(candidates, [], () => 0.99, {
    active, observationSeconds: 60, progressiveEngine
  });
  assert.equal(selected.layer, "AESTHETIC");
});

test("a Flamingo (resolutionMomentum) AESTHETIC/IMPRESSION concept is exempt from the recent-family dedup that would otherwise starve it between captures", () => {
  const recent = [
    { text: "몽환적인 안개", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "아지랑이", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "흐릿한 정서", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" },
    { text: "꿈결 같은 기분", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" }
  ];
  // A fresh Flamingo impression sharing the SAME family as everything just shown -- Flamingo has
  // no idea what the local engine just displayed, and with only ~2 impressions per capture this
  // is the common case, not an edge case.
  const flamingoItem = { text: "아득한 정서", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike",
    resolutionMomentum: true, source: "directAudio", sourceFamily: "directAudio", weight: 0.8, confidence: 0.8 };

  const picked = Selection.choose([flamingoItem], recent, () => 0, { observationSeconds: 60 });
  assert.ok(picked, "a resolutionMomentum open-layer item must survive the family filter even when its family was just shown");
  assert.equal(picked.text, "아득한 정서");
});

test("a NON-Flamingo AESTHETIC concept sharing a just-shown family is still filtered out (the exemption is narrow)", () => {
  const recent = [
    { text: "몽환적인 안개", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "아지랑이", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "흐릿한 정서", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" },
    { text: "꿈결 같은 기분", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" }
  ];
  // A same-family local candidate PLUS an unrelated-family FACT candidate: the FACT item keeps
  // `available` non-empty on its own, so the soft "fall back to everyone if the filter would empty
  // the whole pool" escape hatch does not mask whether the AESTHETIC item specifically got dropped.
  const localItem = { text: "안개 낀 감성", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike",
    weight: 0.8, confidence: 0.8 };
  const unrelatedFact = { text: "킥 밀도 상승", category: "rhythm", layer: "FACT", semanticFamily: "rhythm-only",
    weight: 0.8, confidence: 0.8 };

  let sawAesthetic = false, sawFact = false;
  for (let i = 0; i < 300; i++) {
    const picked = Selection.choose([localItem, unrelatedFact], recent, Math.random, { observationSeconds: 60 });
    if (picked?.text === "안개 낀 감성") sawAesthetic = true;
    if (picked?.text === "킥 밀도 상승") sawFact = true;
  }
  assert.equal(sawAesthetic, false, "ordinary local/LLM open-layer language must still respect the recent-family dedup");
  assert.equal(sawFact, true, "the unrelated-family candidate should still be selectable (sanity check on the test setup)");
});

test("with an unrelated candidate present too, the SAME Flamingo concept still gets through where the local one could not", () => {
  const recent = [
    { text: "몽환적인 안개", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "아지랑이", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike" },
    { text: "흐릿한 정서", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" },
    { text: "꿈결 같은 기분", category: "mood", layer: "IMPRESSION", semanticFamily: "dreamlike" }
  ];
  const flamingoItem = { text: "안개 낀 감성", category: "association", layer: "AESTHETIC", semanticFamily: "dreamlike",
    resolutionMomentum: true, source: "directAudio", sourceFamily: "directAudio", weight: 0.8, confidence: 0.8 };
  const unrelatedFact = { text: "킥 밀도 상승", category: "rhythm", layer: "FACT", semanticFamily: "rhythm-only",
    weight: 0.8, confidence: 0.8 };

  let sawAesthetic = false;
  for (let i = 0; i < 300; i++) {
    const picked = Selection.choose([flamingoItem, unrelatedFact], recent, Math.random, { observationSeconds: 60 });
    if (picked?.text === "안개 낀 감성") sawAesthetic = true;
  }
  assert.equal(sawAesthetic, true, "the resolutionMomentum exemption must let the Flamingo concept surface even with a same-family recent history");
});
