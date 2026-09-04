const test = require("node:test");
const assert = require("node:assert/strict");
const Selection = require("../js/visual/phraseSelection");
const GenreContext = require("../js/semantic/genreContextEngine");
const Critic = require("../js/semantic/languageCritic");
const knowledge = require("../data/genreContextKnowledge.json");

const futureFunkState = (overrides = {}) => ({
  genre: { primary: "Future Funk", family: "Pop / Internet", confidence: 0.88, uncertain: false },
  rhythmicGrammar: { fourOnFloor: 0.9, swing: 0.15 },
  expressionFeatures: { audible: true, bass: 0.6 },
  productionEvidence: { sampleBased: 0.85 },
  instruments: [{ label: "Synthesizer", confidence: 0.72, source: "ml" }, { label: "Bass", confidence: 0.63, source: "ml" }],
  moodDimensions: { brightness: 0.8, warmth: 0.7 },
  ...overrides
});

test("relation graph expresses distance in language: parents assert, adjacency only suggests", () => {
  const engine = new GenreContext.Engine(knowledge);
  const relations = engine.evaluate(futureFunkState()).candidates.filter(item => item.source === "genre-relation");
  const parent = relations.find(item => item.text === "French House 계열" || item.text === "Nu Disco 계열");
  const adjacent = relations.find(item => /인접성$/.test(item.text));
  assert.ok(parent, "a parent style should be offered as a 계열 claim");
  assert.ok(adjacent, "an adjacent style should be offered as 인접성");
  assert.ok(parent.confidence > adjacent.confidence,
    `parent (${parent.confidence}) must outrank adjacency (${adjacent.confidence})`);
  assert.ok(relations.some(item => item.category === "era"));
  assert.ok(relations.some(item => item.category === "scene"));
});

test("a style's history needs two independent sonic families, not one loud measurement", () => {
  const engine = new GenreContext.Engine(knowledge);
  // Production evidence only: no rhythm, no instruments.
  const thin = engine.evaluate(futureFunkState({ rhythmicGrammar: {}, instruments: [] }));
  assert.equal(thin.candidates.filter(item => item.source === "genre-relation").length, 0);
});

test("artist references stay locked behind the strongest genre confidence", () => {
  const engine = new GenreContext.Engine(knowledge);
  const strong = engine.evaluate(futureFunkState()).candidates;
  const weaker = engine.evaluate(futureFunkState({
    genre: { primary: "Future Funk", family: "Pop / Internet", confidence: 0.76, uncertain: false }
  })).candidates;
  assert.ok(strong.some(item => item.kind === "artist" && /연상$/.test(item.text)));
  assert.equal(weaker.some(item => item.kind === "artist"), false);
});

test("relation edges are evidence-differentiated: which edge opens depends on which specific evidence the track has", () => {
  const engine = new GenreContext.Engine(knowledge);
  const hasText = (state, text) => engine.evaluate(state).candidates.some(item => item.text === text);
  // Sidechain-heavy, no melodic instruments: French House lineage, no City Pop adjacency.
  const sidechainTrack = futureFunkState({
    rhythmicGrammar: { fourOnFloor: 0.9, swing: 0.1 },
    productionEvidence: { sidechain: 0.8, sampleBased: 0.4 },
    instruments: [{ label: "Synthesizer", confidence: 0.7, source: "ml" }]
  });
  // Piano+bass, no sidechain: City Pop adjacency should open where sidechain-only did not.
  const pianoTrack = futureFunkState({
    rhythmicGrammar: { fourOnFloor: 0.9, swing: 0.1 },
    productionEvidence: { sampleBased: 0.7 },
    instruments: [{ label: "Piano", confidence: 0.7, source: "ml" }, { label: "Bass", confidence: 0.6, source: "ml" }]
  });
  assert.equal(hasText(sidechainTrack, "City Pop 인접성"), false, "no piano/bass evidence for a City Pop adjacency claim");
  assert.equal(hasText(pianoTrack, "City Pop 인접성"), true, "piano+bass evidence should open the City Pop adjacency edge");
});

test("AESTHETIC accepts a strong genre-grounded claim (Route A)", () => {
  const snapshot = { confidence: 0.85, primaryGenre: "Future Funk", genreEvidence: [{ label: "Future Funk", confidence: 0.85 }],
    productionEvidence: { sampleBased: 0.8 }, moodDimensions: { brightness: 0.8 } };
  const result = Critic.assess({ text: "마법소녀 미학", category: "association", confidence: 0.75, kind: "aesthetic", role: "none",
    anchors: ["primaryGenre", "productionEvidence.sampleBased"] }, [], { snapshot });
  assert.equal(result.valid, true);
});

test("AESTHETIC also accepts a strong feature-grounded claim without a confident genre (Route B)", () => {
  const snapshot = { confidence: 0.3, primaryGenre: null,
    timbre: { brightness: "very high" }, moodDimensions: { brightness: 0.85, warmth: 0.7 },
    productionEvidence: { sampleBased: 0.8 }, instrumentationEvidence: { synthesizer: 0.7 } };
  const result = Critic.assess({ text: "글로시 신스 미학", category: "association", confidence: 0.7, kind: "aesthetic", role: "none",
    anchors: ["timbre.brightness", "productionEvidence.sampleBased", "instrumentationEvidence.synthesizer"] }, [], { snapshot });
  assert.equal(result.valid, true, `expected Route B to accept a 3-axis feature-grounded aesthetic, got ${result.diagnostics.rejectionReason}`);
});

test("a weak AESTHETIC claim is rejected on both routes: no confident genre AND no converging feature evidence", () => {
  const snapshot = { confidence: 0.3, primaryGenre: null, moodDimensions: { warmth: 0.6 } };
  const result = Critic.assess({ text: "몽환적 감성", category: "association", confidence: 0.6, kind: "aesthetic", role: "none",
    anchors: ["moodDimensions.warmth"] }, [], { snapshot });
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.rejectionReason, "genre-confidence-low");
});

test("artist association demands more than a generic relation: both instrumentation and production must resolve", () => {
  const engine = new GenreContext.Engine(knowledge);
  const strongOnBoth = futureFunkState({
    productionEvidence: { sampleBased: 0.8, sidechain: 0.75 },
    instruments: [{ label: "Synthesizer", confidence: 0.7, source: "ml" }, { label: "Bass", confidence: 0.6, source: "ml" }]
  });
  const productionOnly = futureFunkState({
    productionEvidence: { sampleBased: 0.8, sidechain: 0.75 },
    instruments: []
  });
  const hasArtist = state => engine.evaluate(state).candidates.some(item => item.kind === "artist");
  assert.equal(hasArtist(strongOnBoth), true);
  assert.equal(hasArtist(productionOnly), false, "production evidence alone must not unlock an artist association");
});

test("raw descriptors carry the opening seconds but lose the screen once analysis exists", () => {
  const pool = [
    { text: "높은 밀도", category: "dynamics", weight: 1, primitive: true },
    { text: "강한 저역", category: "dynamics", weight: 1, primitive: true },
    { text: "사이드체인 펌핑", category: "production", weight: 1 }
  ];
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  // Recent screen is already saturated with raw descriptors.
  const recent = Array.from({ length: 8 }, () => ({ text: "높은 밀도", category: "dynamics", primitive: true }));
  const settled = Array.from({ length: 40 }, () =>
    Selection.choose(pool, recent, random, { observationSeconds: 45 }).text);
  assert.ok(!settled.includes("높은 밀도") && !settled.includes("강한 저역"),
    "an over-used raw descriptor must yield to synthesised language once the track is understood");
  // In the first seconds, with nothing shown yet, the same primitives are still available.
  const opening = Array.from({ length: 40 }, () =>
    Selection.choose(pool, [], random, { observationSeconds: 3 }).text);
  assert.ok(opening.some(text => text === "높은 밀도" || text === "강한 저역"),
    "primitives must remain available before real analysis exists");
});
