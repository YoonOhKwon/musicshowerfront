const test = require("node:test");
const assert = require("node:assert/strict");
const GenreContext = require("../js/semantic/genreContextEngine");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const genreCompositions = require("../data/genreCompositions.json");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");
const aestheticAxes = require("../data/aestheticAxes.json");
const aestheticRegions = require("../data/aestheticRegions.json");

function nuDiscoState(overrides = {}) {
  return {
    genre: { primary: "Nu Disco", family: "Pop / Internet", confidence: 0.8, uncertain: false,
      topK: [{ label: "Nu Disco", confidence: 0.4 }, { label: "Vaporwave", confidence: 0.25 }, { label: "City Pop", confidence: 0.2 }] },
    rhythmicGrammar: { fourOnFloor: 0.8 },
    productionEvidence: { sampleBased: 0.75 },
    moodDimensions: {}, instruments: [], expressionFeatures: {},
    ...overrides
  };
}

test("400-class-absent genre (Future Funk) is inferred from a top-K label combination plus real evidence, not just genre.primary", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge, null, genreCompositions);
  const result = engine.evaluate(nuDiscoState());
  const composed = result.candidates.find(item => item.source === "genre-composition");
  assert.ok(composed, `expected a composition candidate; got ${JSON.stringify(result.candidates.map(c => c.text))}`);
  assert.equal(composed.text, "Future Funk 계열");
  assert.equal(composed.category, "lineage");
});

test("composition confidence is always capped well below the primary genre's own confidence (never overwrites the HUD genre)", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge, null, genreCompositions);
  const result = engine.evaluate(nuDiscoState());
  const composed = result.candidates.find(item => item.source === "genre-composition");
  assert.ok(composed.confidence < nuDiscoState().genre.confidence * 0.7);
});

test("composition rule needs minTopKCount matched labels, not just one incidental overlap", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge, null, genreCompositions);
  // Only one of Future Funk's three requiresTopK labels present (minTopKCount is 2).
  const result = engine.evaluate(nuDiscoState({ genre: { ...nuDiscoState().genre, topK: [{ label: "Nu Disco", confidence: 0.5 }] } }));
  assert.ok(!result.candidates.some(item => item.source === "genre-composition"));
});

test("composition rule still needs its own real audio evidence -- top-K overlap alone is not enough", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge, null, genreCompositions);
  const weakEvidence = nuDiscoState({ productionEvidence: {}, rhythmicGrammar: {} });
  const result = engine.evaluate(weakEvidence);
  assert.ok(!result.candidates.some(item => item.source === "genre-composition"));
});

test("without a wired compositions table, genreContextEngine behaves exactly as before", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge);
  const result = engine.evaluate(nuDiscoState());
  assert.ok(!result.candidates.some(item => item.source === "genre-composition"));
});

test("the open layer (aesthetic-axis candidates) fires even when genre is uncertain or below the 0.75 context gate", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine, genreCompositions);
  const uncertainState = {
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.3, uncertain: true },
    rhythmicGrammar: { fourOnFloor: 0.75 },
    productionEvidence: { sampleBased: 0.8, filterSweep: 0.75, stereoWidth: 0.7 },
    moodDimensions: { brightness: 0.8, warmth: 0.35, valence: 0.6, aggression: 0.2 },
    instruments: [], expressionFeatures: {}
  };
  const result = engine.evaluate(uncertainState);
  assert.ok(result.candidates.some(item => item.source === "aesthetic-axis"),
    `expected axis-based candidates despite uncertain genre; got ${JSON.stringify(result.candidates)}`);
  // But no genre-IDENTITY claim (lineage/era/scene/culture rule or relation) may appear --
  // those still require a confident, non-uncertain genre.
  assert.ok(!result.candidates.some(item => ["evidence-gated-prior", "genre-relation", "genre-composition"].includes(item.source)));
});

test("middle-layer candidates (rules/relations/compositions) still require genre.confidence >= 0.75, unaffected by the open-layer change", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine, genreCompositions);
  const lowConfidence = nuDiscoState({ genre: { ...nuDiscoState().genre, confidence: 0.6, uncertain: false } });
  const result = engine.evaluate(lowConfidence);
  assert.ok(!result.candidates.some(item => item.source === "genre-composition"));
});

test("validateGenreCompositions enforces the tentative 계열/경향 suffix and a reachable minTopKCount", () => {
  const good = Validator.validateGenreCompositions(genreCompositions, {});
  assert.deepEqual(good, []);
  const badSuffix = Validator.validateGenreCompositions({ rules: [{ text: "Future Funk", requiresTopK: ["Nu Disco"], minTopKCount: 1,
    requires: [{ path: "productionEvidence.sampleBased", min: 0.7 }, { path: "rhythmicGrammar.fourOnFloor", min: 0.7 }] }] }, {});
  assert.ok(badSuffix.some(item => item.code === "composition-text-not-tentative"));
  const badMinCount = Validator.validateGenreCompositions({ rules: [{ text: "Test 계열", requiresTopK: ["Nu Disco"], minTopKCount: 3,
    requires: [{ path: "productionEvidence.sampleBased", min: 0.7 }, { path: "rhythmicGrammar.fourOnFloor", min: 0.7 }] }] }, {});
  assert.ok(badMinCount.some(item => item.code === "composition-min-topk-unreachable"));
});
