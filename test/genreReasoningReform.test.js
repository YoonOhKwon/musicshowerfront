const test = require("node:test");
const assert = require("node:assert/strict");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const rules = require("../data/compositeGenreRules.json");
const hierarchy = require("../data/genreHierarchy.json");

function state({ primary = "J-pop", topK = [["J-pop", 0.08]], confidence = 0.72,
  fourOnFloor = null, swing = null, brokenBeat = null, sampleBased = null,
  sidechain = null, filterSweep = null, instruments = {}, mood = {} } = {}) {
  return {
    classifierGenre: { primary, uncertain: false, semanticConfidence: confidence, confidence,
      topK: topK.map(([label, value]) => ({ label, confidence: value })) },
    rhythmicGrammar: { fourOnFloor, swing, brokenBeat },
    productionEvidence: { sampleBased, sidechain, filterSweep },
    instrumentationEvidence: instruments,
    moodDimensions: mood,
    trackCharacter: { space: { spaciousness: mood.spaciousness ?? null } }
  };
}

test("pure J-pop evidence cannot manufacture Future Funk", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy);
  const result = engine.evaluate(state(), 0);
  assert.equal(result.primary.genre, "J-pop");
  assert.equal(result.hypotheses.some(item => item.genre === "Future Funk"), false);
});

test("Future Funk is a composite hypothesis with coverage and independent provenance", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy);
  const result = engine.evaluate(state({
    topK: [["J-pop", 0.08], ["Nu Disco", 0.074], ["Disco", 0.065]],
    fourOnFloor: 0.88, sampleBased: 0.82, sidechain: 0.76,
    instruments: { synthesizer: 0.72 }, mood: { brightness: 0.75 }
  }), 0);
  const future = result.hypotheses.find(item => item.genre === "Future Funk");
  assert.ok(future);
  assert.ok(future.evidenceCoverage >= 0.75);
  assert.ok(future.independentEvidenceCount >= 3);
  assert.ok(future.supportingEvidence.some(item => item.path === "productionEvidence.sampleBased"));
  assert.ok(result.relations.some(item => item.relationFamily === "SOURCE"));
  assert.ok(result.relations.some(item => item.relationTarget === "J-pop" && item.relationType === "source"));
  assert.equal(result.relations.some(item => item.relationTarget === "City Pop"), false,
    "a City Pop source relation needs an actual City Pop classifier constituent");
});

test("temporal stability rises without changing semantic confidence", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy);
  const input = state({ primary: "House", topK: [["House", 0.09], ["Techno", 0.04]], confidence: 0.74 });
  const first = engine.evaluate(input, 0).primary;
  const later = engine.evaluate(input, 6000).primary;
  assert.equal(later.semanticConfidence, first.semanticConfidence);
  assert.ok(later.temporalStability > first.temporalStability);
});

test("a challenger needs margin, independent evidence and persistence before takeover", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy, { switchMargin: 0.04, takeoverMs: 2000 });
  engine.evaluate(state({ confidence: 0.7 }), 0);
  const composite = state({ confidence: 0.68,
    topK: [["J-pop", 0.07], ["Nu Disco", 0.068], ["Disco", 0.065]],
    fourOnFloor: 0.92, sampleBased: 0.9, sidechain: 0.82,
    instruments: { synthesizer: 0.8 }, mood: { brightness: 0.8 } });
  let result = engine.evaluate(composite, 1000);
  assert.equal(result.primary.genre, "J-pop");
  assert.equal(result.pendingChallenger.genre, "Future Funk");
  result = engine.evaluate(composite, 2500);
  assert.equal(result.primary.genre, "J-pop");
  result = engine.evaluate(composite, 3100);
  assert.equal(result.primary.genre, "Future Funk");
  assert.deepEqual(result.takeover.from, "J-pop");
});

test("a one-window composite spike remains a challenger and cannot take over", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy, { switchMargin: 0.04, takeoverMs: 2000 });
  engine.evaluate(state({ confidence: 0.7 }), 0);
  const spike = state({ confidence: 0.68,
    topK: [["J-pop", .07], ["Nu Disco", .068], ["Disco", .065]],
    fourOnFloor: .92, sampleBased: .9, sidechain: .82 });
  const during = engine.evaluate(spike, 1000);
  assert.equal(during.primary.genre, "J-pop");
  const after = engine.evaluate(state({ confidence: 0.7 }), 1600);
  assert.equal(after.primary.genre, "J-pop");
  assert.equal(after.takeover, null);
});

test("taxonomy children and merely related alternatives are separate", () => {
  const engine = new GenreHypotheses.Engine(rules, hierarchy);
  const result = engine.evaluate(state({ primary: "House", confidence: 0.8,
    topK: [["House", 0.1], ["Deep House", 0.08], ["Techno", 0.07]] }), 0);
  assert.ok(result.actualSubgenres.some(item => item.label === "Deep House"));
  assert.ok(result.relatedGenres.some(item => item.label === "Techno"));
  assert.equal(result.actualSubgenres.some(item => item.label === "Techno"), false);
});

test("the composite catalog is general across all configured hybrid genres", () => {
  const fixtures = [
    ["French House", state({ primary: "House", confidence: 0.78, topK: [["House", .1], ["Disco", .08]],
      fourOnFloor: .85, sampleBased: .8, filterSweep: .7 })],
    ["Nu Disco", state({ primary: "Nu Disco", confidence: .78, topK: [["Nu Disco", .1], ["Disco", .08]],
      fourOnFloor: .84, instruments: { synthesizer: .7 } })],
    ["Jazz Rap", state({ primary: "Hip-Hop", confidence: .76, topK: [["Hip-Hop", .1], ["Jazz", .08]],
      swing: .7, instruments: { piano: .72 } })],
    ["Electro Swing", state({ primary: "Jazz", confidence: .76, topK: [["Jazz", .1], ["House", .08]],
      swing: .82, instruments: { brass: .74 } })],
    ["Liquid DnB", state({ primary: "Drum & Bass", confidence: .78,
      topK: [["Drum & Bass", .1], ["Atmospheric DnB", .08]], brokenBeat: .82,
      mood: { spaciousness: .78 } })]
  ];
  for (const [expected, input] of fixtures) {
    const result = new GenreHypotheses.Engine(rules, hierarchy).evaluate(input, 0);
    assert.ok(result.hypotheses.some(item => item.genre === expected), expected);
  }
});

test("adjacent labels from one classifier remain one independent evidence family", () => {
  const result = new GenreHypotheses.Engine(rules, hierarchy).evaluate(state({
    primary: "J-pop", confidence: .78,
    topK: [["J-pop", .1], ["City Pop", .09], ["Vaporwave", .08], ["Nu Disco", .07]]
  }), 0);
  const rejected = result.rejectedHypotheses.find(item => item.genre === "Future Funk");
  assert.ok(rejected);
  assert.deepEqual(rejected.independentEvidenceFamilies, ["genreModel"]);
  assert.equal(rejected.independentEvidenceCount, 1);
});

test("generic Disco plus Funk does not manufacture the modern Nu Disco branch", () => {
  const result = new GenreHypotheses.Engine(rules, hierarchy).evaluate(state({
    primary: "Disco", confidence: .8, topK: [["Disco", .1], ["Funk", .09]],
    fourOnFloor: .9, instruments: { synth: .75, bass: .7 }
  }), 0);
  assert.equal(result.hypotheses.some(item => item.genre === "Nu Disco"), false);
});
