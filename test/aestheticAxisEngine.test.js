const test = require("node:test");
const assert = require("node:assert/strict");
const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const GenreContext = require("../js/semantic/genreContextEngine");
const aestheticAxes = require("../data/aestheticAxes.json");
const aestheticRegions = require("../data/aestheticRegions.json");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");

test("a missing component is excluded from the weighted average, never averaged in as 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [
      { path: "moodDimensions.warmth", weight: 0.5 },
      { path: "moodDimensions.valence", weight: 0.2 },
      { path: "moodDimensions.aggression", weight: 0.3, invert: true }
    ] } }
  }, { entries: [] });
  // Only warmth is present; valence/aggression are genuinely unmeasured. If they were silently
  // treated as 0 the result would be dragged down to well below 0.9 -- it must not be.
  const { axes } = engine.evaluateAxes({ moodDimensions: { warmth: 0.9 } }, {});
  assert.equal(axes.warmth, 0.9);
});

test("an axis with zero resolvable components stays null, never becomes 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { intimacy: { components: [
      { path: "productionEvidence.stereoWidth", weight: 0.35, invert: true },
      { path: "productionEvidence.reverb", weight: 0.35, invert: true },
      { path: "moodDimensions.warmth", weight: 0.3 }
    ] } }
  }, { entries: [] });
  const { axes, contributingPaths } = engine.evaluateAxes({ productionEvidence: {}, moodDimensions: {} }, {});
  assert.equal(axes.intimacy, null);
  assert.deepEqual(contributingPaths.intimacy, []);
});

test("a genre-prior component alone (no real acoustic signal) cannot manufacture an axis value", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { glossiness: { components: [
      { path: "moodDimensions.brightness", weight: 0.5 },
      { genrePriors: { "city pop": 0.8 }, weight: 0.5 }
    ] } }
  }, { entries: [] });
  const genre = { primary: "City Pop", confidence: 0.85, uncertain: false };
  const grounded = engine.evaluateAxes({ moodDimensions: { brightness: 0.7 } }, genre);
  assert.ok(grounded.axes.glossiness !== null, "brightness is a real measurement, so this must resolve");
  const genreOnly = engine.evaluateAxes({ moodDimensions: {} }, genre);
  assert.equal(genreOnly.axes.glossiness, null, "genre label alone must not fabricate an unmeasured axis");
});

test("region text is keyed to axis combinations, not genre identity: same genre, different production/mood values produce different words", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const genre = { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false };

  // Same genre and genre-confidence throughout -- only the measured evidence differs.
  const nostalgicDecayed = engine.evaluate({
    moodDimensions: { warmth: 0.75, brightness: 0.3, valence: 0.6, aggression: 0.2 },
    productionEvidence: { sampleBased: 0.8, distortion: 0.7 },
    rhythmicGrammar: {}
  }, genre);
  const glossyUrban = engine.evaluate({
    moodDimensions: { warmth: 0.3, brightness: 0.85, valence: 0.6, aggression: 0.2 },
    productionEvidence: { filterSweep: 0.8, stereoWidth: 0.75, sidechain: 0.1, distortion: 0.05 },
    rhythmicGrammar: { fourOnFloor: 0.8 }
  }, genre);

  const decayedTexts = nostalgicDecayed.candidates.map(c => c.text);
  const urbanTexts = glossyUrban.candidates.map(c => c.text);
  assert.ok(decayedTexts.length > 0, "decayed/nostalgic evidence should surface at least one region");
  assert.ok(urbanTexts.length > 0, "glossy/urban evidence should surface at least one region");
  assert.ok(decayedTexts.some(text => !urbanTexts.includes(text)),
    `same genre, different evidence must not converge on identical wording; got ${JSON.stringify(decayedTexts)} vs ${JSON.stringify(urbanTexts)}`);
  // The specific expected direction: decay-flavored evidence should not surface the urban/glossy
  // 80s-style region, and vice versa.
  assert.ok(!decayedTexts.includes("도시의 야경"));
  assert.ok(!urbanTexts.includes("바스러진 테이프 소리"));
});

test("aesthetic-axis region candidates flow through genreContextEngine alongside rule/relation candidates", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const result = engine.evaluate({
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.75, swing: 0.2 },
    productionEvidence: { sampleBased: 0.8, filterSweep: 0.75, stereoWidth: 0.7 },
    moodDimensions: { brightness: 0.8, warmth: 0.35, valence: 0.6, aggression: 0.2 },
    instruments: [], expressionFeatures: {}
  });
  const axisCandidates = result.candidates.filter(item => item.source === "aesthetic-axis");
  assert.ok(axisCandidates.length > 0, "a confidently-known genre with real glossy/urban evidence should surface at least one axis-based candidate");
  for (const candidate of axisCandidates) assert.ok(candidate.anchors.length >= 2, "axis candidates must carry real evidence anchors");
});

test("without a wired axis engine, genreContextEngine behaves exactly as before (no axis candidates, no crash)", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge);
  const result = engine.evaluate({
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.75 }, productionEvidence: { sampleBased: 0.8 },
    moodDimensions: { brightness: 0.8 }, instruments: [], expressionFeatures: {}
  });
  assert.equal(result.candidates.some(item => item.source === "aesthetic-axis"), false);
});

test("axes report a delta/direction, not just a current value, once a trailing-window baseline exists", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { nostalgia: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 1_000_000;
  const first = engine.evaluate({ moodDimensions: { warmth: 0.3 } }, {}, t0);
  assert.equal(first.delta.nostalgia, null, "no baseline yet -- must not report a fabricated 0 delta");
  assert.equal(first.direction.nostalgia, null);
  const later = engine.evaluate({ moodDimensions: { warmth: 0.75 } }, {}, t0 + 12000);
  assert.ok(later.delta.nostalgia > 0.4, `expected a strong rising delta, got ${later.delta.nostalgia}`);
  assert.equal(later.direction.nostalgia, "rising");
  const fallen = engine.evaluate({ moodDimensions: { warmth: 0.3 } }, {}, t0 + 24000);
  assert.ok(fallen.delta.nostalgia < 0);
  assert.equal(fallen.direction.nostalgia, "falling");
});

test("a tiny axis fluctuation reports as stable, not a spurious rising/falling flip", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 2_000_000;
  engine.evaluate({ moodDimensions: { warmth: 0.5 } }, {}, t0);
  const result = engine.evaluate({ moodDimensions: { warmth: 0.52 } }, {}, t0 + 12000);
  assert.equal(result.direction.warmth, "stable");
});

test("a null current or baseline value keeps delta/direction null, never fabricated as 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 3_000_000;
  engine.evaluate({ moodDimensions: {} }, {}, t0);
  const result = engine.evaluate({ moodDimensions: { warmth: 0.6 } }, {}, t0 + 12000);
  assert.equal(result.delta.warmth, null);
  assert.equal(result.direction.warmth, null);
});

test("a region barely clearing its min threshold does not fire just because genre confidence is high (selectivity is margin-based, not genre-based)", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [{ text: "따뜻한 아날로그 온기", category: "association", requires: [{ axis: "warmth", min: 0.5 }], minAxes: 1 }] });
  const genre = { primary: "City Pop", confidence: 0.9, uncertain: false };
  assert.equal(engine.evaluate({ moodDimensions: { warmth: 0.55 } }, genre).candidates.length, 0,
    "barely over the min threshold, even with a very confident genre, must not be enough");
  assert.equal(engine.evaluate({ moodDimensions: { warmth: 0.8 } }, genre).candidates.length, 1,
    "comfortably clearing the threshold should fire");
});

test("a region can require an axis direction (e.g. 'deepening nostalgia'), not just its current value", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions, { historyWindowMs: 10000 });
  const genre = { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false };
  const t0 = 4_000_000;
  const flatState = { moodDimensions: { warmth: 0.5, brightness: 0.4, valence: 0.5, aggression: 0.3 },
    productionEvidence: { sampleBased: 0.75 }, rhythmicGrammar: {} };
  const first = engine.evaluate(flatState, genre, t0);
  assert.ok(!first.candidates.some(item => item.text === "짙어지는 향수"), "no baseline yet, direction-gated region must not fire");
  const deepening = engine.evaluate({ ...flatState, moodDimensions: { ...flatState.moodDimensions, warmth: 1 } }, genre, t0 + 12000);
  assert.ok(deepening.candidates.some(item => item.text === "짙어지는 향수"),
    `expected the rising-nostalgia region once warmth clearly climbed; got ${JSON.stringify(deepening.candidates.map(c => c.text))}`);
});
