const test = require("node:test");
const assert = require("node:assert/strict");
const GenreContext = require("../js/semantic/genreContextEngine");
const knowledge = require("../data/genreContextKnowledge.json");

// Real Discogs-EffNet jazz labels are specific children ("Bop", "Swing", "Fusion", ...),
// never the literal string "Jazz" — genre.family carries the "Jazz / Soul" umbrella they all
// resolve to (see discogsParentFamily in js/semantic/semanticEngine.js). Context priors for
// jazz therefore live under data.families["Jazz / Soul"], not data.genres["Jazz"].
function jazzState(overrides = {}) {
  return {
    genre: { primary: "Bop", family: "Jazz / Soul", confidence: 0.8, uncertain: false },
    rhythmicGrammar: { swing: 0.75 },
    expressionFeatures: { tonalFocus: 0.6, harmonicMovement: 0.6 },
    productionEvidence: {},
    instruments: [
      { label: "Piano", confidence: 0.6, source: "ml" },
      { label: "Saxophone", confidence: 0.55, source: "ml" }
    ],
    moodDimensions: {},
    ...overrides
  };
}

test("Jazz / Soul family context surfaces swing lineage and scene with real supporting evidence", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate(jazzState());
  const texts = result.candidates.map(item => item.text);
  assert.ok(texts.includes("Swing 계열"));
  assert.ok(texts.includes("Bebop 계열"));
  assert.ok(texts.includes("재즈 소편성 씬"));
  assert.ok(texts.includes("재즈 클럽 문화"));
});

test("Jazz / Soul context stays empty below the genre confidence gate", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate(jazzState({ genre: { primary: "Bop", family: "Jazz / Soul", confidence: 0.4, uncertain: false } }));
  assert.equal(result.candidates.length, 0);
});

test("Jazz / Soul context stays empty without swing evidence", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate(jazzState({ rhythmicGrammar: { swing: 0.1 } }));
  assert.equal(result.candidates.length, 0);
});

test("Electronic / Club family surfaces dance scene and club culture with four-on-the-floor + sidechain", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate({
    genre: { primary: "Techno", family: "Electronic / Club", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.85 },
    expressionFeatures: { tempoStability: 0.8 },
    productionEvidence: { sidechain: 0.7 },
    instruments: [], moodDimensions: {}
  });
  const texts = result.candidates.map(item => item.text);
  assert.ok(texts.includes("댄스 씬 계열"));
  assert.ok(texts.includes("일렉트로닉 클럽 문화"));
});

test("Hip-Hop / Rap family distinguishes boom bap swing from trap broken-beat sub bass", () => {
  const engine = new GenreContext.Engine(knowledge);
  const boomBap = engine.evaluate({
    genre: { primary: "Boom Bap", family: "Hip-Hop / Rap", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { swing: 0.65 },
    expressionFeatures: { bass: 0.3 },
    productionEvidence: {},
    instruments: [{ label: "Bass", confidence: 0.5, source: "ml" }, { label: "Voice", confidence: 0.5, source: "ml" }],
    moodDimensions: {}
  });
  assert.ok(boomBap.candidates.map(item => item.text).includes("붐뱁 계열"));
  const trap = engine.evaluate({
    genre: { primary: "Trap", family: "Hip-Hop / Rap", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { brokenBeat: 0.55, swing: 0.1 },
    expressionFeatures: { bass: 0.6 },
    productionEvidence: {},
    instruments: [], moodDimensions: {}
  });
  assert.ok(trap.candidates.map(item => item.text).includes("트랩 계열"));
  assert.ok(!trap.candidates.map(item => item.text).includes("붐뱁 계열"));
});

test("Ambient / Cinematic family requires both spaciousness and a genuinely sparse onset rate", () => {
  const engine = new GenreContext.Engine(knowledge);
  const spacious = engine.evaluate({
    genre: { primary: "Ambient", family: "Ambient / Cinematic", confidence: 0.85, uncertain: false },
    rhythmicGrammar: {}, expressionFeatures: { onsetRate: 0.05 },
    productionEvidence: {}, instruments: [], moodDimensions: { spaciousness: 0.8 }
  });
  assert.ok(spacious.candidates.map(item => item.text).includes("앰비언트 계열"));
  const busy = engine.evaluate({
    genre: { primary: "Ambient", family: "Ambient / Cinematic", confidence: 0.85, uncertain: false },
    rhythmicGrammar: {}, expressionFeatures: { onsetRate: 3 },
    productionEvidence: {}, instruments: [], moodDimensions: { spaciousness: 0.8 }
  });
  assert.ok(!busy.candidates.map(item => item.text).includes("앰비언트 계열"));
});

// Project-transformation ask: a genre outside the 24 hand-curated data.genres entries must not go
// silent just because it isn't individually curated -- as long as its FAMILY (which the classifier
// assigns to all 400 real classes via discogsParentFamily, semanticEngine.js) has a families entry,
// real evidence can still ground a lineage claim. Blues/Classical/Folk/Reggae/Children's all map to
// "Acoustic / Traditional"; Pop maps to "Pop / Internet" -- neither had a families entry before.
test("Acoustic / Traditional family (blues/classical/folk/reggae -- none individually curated) surfaces a lineage claim from real evidence", () => {
  const engine = new GenreContext.Engine(knowledge);
  const grounded = engine.evaluate({
    genre: { primary: "Delta Blues", family: "Acoustic / Traditional", confidence: 0.8, uncertain: false },
    rhythmicGrammar: {}, expressionFeatures: { tonalFocus: 0.65 },
    productionEvidence: {}, instruments: [], moodDimensions: { warmth: 0.6 }
  });
  assert.ok(grounded.candidates.map(item => item.text).includes("어쿠스틱 전통 계열"));
  const ungrounded = engine.evaluate({
    genre: { primary: "Delta Blues", family: "Acoustic / Traditional", confidence: 0.8, uncertain: false },
    rhythmicGrammar: {}, expressionFeatures: { tonalFocus: 0.2 },
    productionEvidence: {}, instruments: [], moodDimensions: { warmth: 0.6 }
  });
  assert.ok(!ungrounded.candidates.map(item => item.text).includes("어쿠스틱 전통 계열"),
    "low tonal focus must not still claim an acoustic lineage");
});

test("Pop / Internet family surfaces a lineage claim from real evidence", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate({
    genre: { primary: "Europop", family: "Pop / Internet", confidence: 0.8, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.6 }, expressionFeatures: {},
    productionEvidence: {}, instruments: [], moodDimensions: { brightness: 0.6 }
  });
  assert.ok(result.candidates.map(item => item.text).includes("팝 계열"));
});

test("a genre whose family the classifier cannot map to any curated family (e.g. 'Unknown') stays honestly silent, not fabricated", () => {
  const engine = new GenreContext.Engine(knowledge);
  const result = engine.evaluate({
    genre: { primary: "Some Untabled Genre", family: "Unknown", confidence: 0.9, uncertain: false },
    rhythmicGrammar: { swing: 0.9, fourOnFloor: 0.9 }, expressionFeatures: { tonalFocus: 0.9 },
    productionEvidence: {}, instruments: [], moodDimensions: { warmth: 0.9, brightness: 0.9 }
  });
  assert.equal(result.candidates.length, 0);
});
