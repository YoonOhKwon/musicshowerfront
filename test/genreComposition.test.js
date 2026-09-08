const test = require("node:test");
const assert = require("node:assert/strict");
const GenreContext = require("../js/semantic/genreContextEngine");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");
const genreHierarchy = require("../data/genreHierarchy.json");
const aestheticAxes = require("../data/aestheticAxes.json");

// data/genreCompositions.json is gone. It named "Future Funk 계열" and "French House 계열" when the
// classifier's top-K matched a written-down label combination -- a second hardcoded genre-name
// table alongside compositeGenreRules.json, patching the same hole in the same closed-world way.
// Composite naming now lives in genreHypothesisEngine, where the NAME comes from a listener.

function nuDiscoState(overrides = {}) {
  return {
    genre: { primary: "Nu Disco", family: "Pop / Internet", confidence: 0.8, uncertain: false,
      topK: [{ label: "Nu Disco", confidence: 0.4 }, { label: "Vaporwave", confidence: 0.25 },
        { label: "City Pop", confidence: 0.2 }] },
    rhythmicGrammar: { fourOnFloor: 0.8 },
    productionEvidence: { sampleBased: 0.75 },
    moodDimensions: {}, instruments: [], expressionFeatures: {},
    ...overrides
  };
}

test("genreContextEngine no longer emits composition-named genres at all", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const result = engine.evaluate(nuDiscoState());
  assert.ok(!result.candidates.some((item) => item.source === "genre-composition"),
    "the top-K label combination alone must never produce a genre name");
  assert.ok(!result.candidates.some((item) => /Future Funk|French House/.test(item.text || "")));
});

test("the engine no longer accepts a compositions table even if one is handed to it", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge, null);
  assert.equal(engine.compositions, undefined,
    "there is no table slot left to re-introduce hardcoded genre names through");
  assert.equal(typeof engine.compositionCandidates, "undefined");
});

test("the same evidence still reaches a composite -- through a listener naming it, not a table", () => {
  // The exact top-K the deleted rule keyed on. It produces nothing on its own...
  const bare = new GenreHypotheses.Engine({}, genreHierarchy).evaluate({
    classifierGenre: { primary: "Nu Disco", uncertain: false, semanticConfidence: 0.8, confidence: 0.8,
      topK: [{ label: "Nu Disco", confidence: 0.4 }, { label: "Vaporwave", confidence: 0.25 },
        { label: "City Pop", confidence: 0.2 }] },
    rhythmicGrammar: { fourOnFloor: 0.8 }, productionEvidence: { sampleBased: 0.75 },
    openWorldConcepts: []
  }, 0);
  assert.equal(bare.hypotheses.some((item) => item.genre === "Future Funk"), false);

  // ...and reaches the same name once Music Flamingo actually says it.
  const named = new GenreHypotheses.Engine({}, genreHierarchy).evaluate({
    classifierGenre: { primary: "Nu Disco", uncertain: false, semanticConfidence: 0.8, confidence: 0.8,
      topK: [{ label: "Nu Disco", confidence: 0.4 }, { label: "Vaporwave", confidence: 0.25 },
        { label: "City Pop", confidence: 0.2 }] },
    rhythmicGrammar: { fourOnFloor: 0.8 }, productionEvidence: { sampleBased: 0.75 },
    openWorldConcepts: [{ canonicalLabel: "Future Funk", conceptType: "genre", confidence: 0.68,
      status: "provisional", sources: ["directAudio"], temporalSupport: 2,
      relatedLabels: [{ label: "City Pop", type: "genre", relationType: "lineage", confidence: 0.6 },
        { label: "Nu Disco", type: "genre", relationType: "lineage", confidence: 0.6 }] }]
  }, 0);
  const composite = named.hypotheses.find((item) => item.genre === "Future Funk");
  assert.ok(composite);
  assert.equal(composite.kind, "composite");
  assert.deepEqual([...composite.independentEvidenceFamilies].sort(), ["deepListen", "genreModel"]);
});

test("an uncertain genre still yields no genre-IDENTITY claim, and no local aesthetic either", () => {
  // This used to assert the opposite half: that axis-based aesthetic candidates fired regardless
  // of genre confidence, so the open layer was never silent. That was the right instinct about
  // gating and the wrong source of words -- the phrases came from a 27-entry table keyed to axis
  // thresholds. The open layer is still ungated by genre; it is now filled by Music Flamingo.
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const uncertainState = {
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.3, uncertain: true },
    rhythmicGrammar: { fourOnFloor: 0.75 },
    productionEvidence: { sampleBased: 0.8, filterSweep: 0.75, stereoWidth: 0.7 },
    moodDimensions: { brightness: 0.8, warmth: 0.35, valence: 0.6, aggression: 0.2 },
    instruments: [], expressionFeatures: {}
  };
  const result = engine.evaluate(uncertainState);
  assert.equal(result.candidates.filter((item) => item.source === "aesthetic-axis").length, 0,
    "strong axis evidence is still evidence, and still not a phrase");
  assert.ok(!result.candidates.some((item) =>
    ["evidence-gated-prior", "genre-relation", "genre-composition"].includes(item.source)));
  // The measurement the axis engine exists for survives and is still exposed.
  assert.equal(typeof result.axisSignature, "string");
});

test("middle-layer candidates still require genre.confidence >= 0.75, unaffected by the removal", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const lowConfidence = nuDiscoState({ genre: { ...nuDiscoState().genre, confidence: 0.6, uncertain: false } });
  const result = engine.evaluate(lowConfidence);
  assert.ok(!result.candidates.some((item) =>
    ["evidence-gated-prior", "genre-relation"].includes(item.source)));
});
