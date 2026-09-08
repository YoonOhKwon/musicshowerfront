const test = require("node:test");
const assert = require("node:assert/strict");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const hierarchy = require("../data/genreHierarchy.json");

// There is no rule table any more. data/compositeGenreRules.json held six hand-written composite
// genres -- Future Funk, French House, Nu Disco, Jazz Rap, Electro Swing, Liquid DnB -- each with
// its own acoustic thresholds, and it existed only because the Discogs classifier is trained on a
// fixed 400 styles and cannot say those names at all. That patched exactly six holes and left
// every other composite in music unreachable. Genre names now come from the two things that
// actually listen: the classifier model, and Music Flamingo through the open-world registry.
function state({ primary = "J-pop", topK = [["J-pop", 0.08]], confidence = 0.72,
  fourOnFloor = null, swing = null, brokenBeat = null, sampleBased = null,
  sidechain = null, filterSweep = null, instruments = {}, mood = {},
  openWorldConcepts = [] } = {}) {
  return {
    classifierGenre: { primary, uncertain: false, semanticConfidence: confidence, confidence,
      topK: topK.map(([label, value]) => ({ label, confidence: value })) },
    rhythmicGrammar: { fourOnFloor, swing, brokenBeat },
    productionEvidence: { sampleBased, sidechain, filterSweep },
    instrumentationEvidence: instruments,
    moodDimensions: mood,
    trackCharacter: { space: { spaciousness: mood.spaciousness ?? null } },
    openWorldConcepts
  };
}

// What Music Flamingo contributes, as the registry stores it: an open-vocabulary name plus
// whatever the runtime concept expansion managed to learn about it.
function heard(label, { confidence = 0.66, lineage = [], conceptType = "genre",
  status = "provisional", sources = ["directAudio"] } = {}) {
  return { canonicalLabel: label, conceptType, confidence, status, sources, temporalSupport: 2,
    relatedLabels: lineage.map((name) => ({ label: name, type: "genre", relationType: "lineage",
      confidence: 0.6 })) };
}

const engine = (options) => new GenreHypotheses.Engine({}, hierarchy, options);

test("no listener named it, so it does not exist -- evidence cannot manufacture a genre", () => {
  const result = engine().evaluate(state(), 0);
  assert.equal(result.primary.genre, "J-pop");
  assert.equal(result.hypotheses.some((item) => item.genre === "Future Funk"), false);
});

test("acoustic evidence alone never manufactures a name, however strong it is", () => {
  // Precisely the fixture the deleted Future Funk rule used to fire on.
  const result = engine().evaluate(state({
    topK: [["J-pop", 0.08], ["Nu Disco", 0.074], ["Disco", 0.065]],
    fourOnFloor: 0.88, sampleBased: 0.82, sidechain: 0.76,
    instruments: { synthesizer: 0.72 }, mood: { brightness: 0.75 }
  }), 0);
  assert.equal(result.hypotheses.some((item) => item.genre === "Future Funk"), false,
    "four-on-the-floor plus sampling is not a genre name; only a listener can supply one");
});

test("a name absent from every local file becomes a composite when two independent listeners agree", () => {
  const result = engine().evaluate(state({
    topK: [["J-pop", 0.08], ["Nu Disco", 0.074], ["City Pop", 0.07]],
    openWorldConcepts: [heard("Future Funk", { lineage: ["City Pop", "Nu Disco", "Vaporwave"] })]
  }), 0);
  const future = result.hypotheses.find((item) => item.genre === "Future Funk");
  assert.ok(future, "Flamingo named it and the classifier's own top-K corroborates its lineage");
  assert.equal(future.kind, "composite");
  assert.deepEqual([...future.independentEvidenceFamilies].sort(), ["deepListen", "genreModel"]);
  assert.ok(future.compositeOf.includes("Nu Disco") || future.compositeOf.includes("City Pop"));
  assert.ok(future.supportingEvidence.some((item) => item.path === "classifierGenre.topK"));
});

test("the mechanism is general -- it works for names no one wrote down anywhere", () => {
  // None of these are in the Discogs 400, and none were ever in a rule file.
  const cases = [
    ["Mallsoft", ["Vaporwave"], [["Vaporwave", 0.09], ["Ambient", 0.06]]],
    ["Jersey Club", ["House", "Hip-Hop"], [["House", 0.1], ["Hip-Hop", 0.07]]],
    ["Liquid Drum and Bass", ["Drum & Bass"], [["Drum & Bass", 0.11], ["Jungle", 0.05]]],
    ["Shibuya-kei", ["J-pop", "Bossa Nova"], [["J-pop", 0.1], ["Bossa Nova", 0.06]]],
    ["Hyperpop", ["Pop", "Electronic"], [["Pop", 0.1], ["Electronic", 0.08]]]
  ];
  for (const [label, lineage, topK] of cases) {
    const result = engine().evaluate(state({ primary: topK[0][0], topK,
      openWorldConcepts: [heard(label, { lineage })] }), 0);
    const found = result.hypotheses.find((item) => item.genre === label);
    assert.ok(found, `${label} must be reachable without any rule naming it`);
    assert.equal(found.kind, "composite", label);
  }
});

test("one classifier's adjacent labels are still ONE independent family", () => {
  // City Pop + Vaporwave + Nu Disco all from the same model head. Nothing else named anything,
  // so no composite exists at all -- the old engine at least produced it as a rejected rule.
  const result = engine().evaluate(state({
    primary: "J-pop", confidence: 0.78,
    topK: [["J-pop", 0.1], ["City Pop", 0.09], ["Vaporwave", 0.08], ["Nu Disco", 0.07]]
  }), 0);
  assert.equal(result.hypotheses.some((item) => item.genre === "Future Funk"), false);
  for (const item of result.hypotheses) {
    assert.deepEqual(item.independentEvidenceFamilies, ["genreModel"],
      `${item.genre} came from one model head and must claim exactly one family`);
  }
});

test("a name only Flamingo said, with nothing corroborating it, stays a single-family hypothesis", () => {
  const result = engine().evaluate(state({
    topK: [["J-pop", 0.08]],
    openWorldConcepts: [heard("Sea Shanty Drill", { lineage: ["Nothing The Classifier Knows"] })]
  }), 0);
  const solo = result.hypotheses.find((item) => item.genre === "Sea Shanty Drill");
  assert.ok(solo, "an uncorroborated open-world name is still a hypothesis -- absence is not rejection");
  assert.equal(solo.kind, "open-world");
  assert.equal(solo.independentEvidenceCount, 1);
  assert.ok(solo.semanticConfidence <= 0.72,
    "one listener alone cannot become near-certain, whichever listener it is");
});

test("a one-off low-confidence genre stays inspectable but cannot become primary", () => {
  const result = engine().evaluate(state({
    primary: null, confidence: 0.2, topK: [],
    openWorldConcepts: [{
      canonicalLabel: "Uncatalogued Pulse", conceptType: "genre", confidence: 0.40,
      status: "emerging", sources: ["directAudio"], temporalSupport: 1
    }]
  }), 0);
  assert.equal(result.primary, null);
  assert.ok(result.hypotheses.some(item => item.genre === "Uncatalogued Pulse"));
});

test("a repeated label-agnostic hypothesis can cross the low-confidence promotion gate", () => {
  const result = engine().evaluate(state({
    primary: null, confidence: 0.2, topK: [],
    openWorldConcepts: [{
      canonicalLabel: "Uncatalogued Pulse", conceptType: "genre", confidence: 0.44,
      status: "provisional", sources: ["directAudio"], temporalSupport: 2
    }]
  }), 0);
  assert.equal(result.primary.genre, "Uncatalogued Pulse");
});

test("corroboration raises confidence above what either listener claimed alone", () => {
  const alone = engine().evaluate(state({ topK: [["J-pop", 0.08]],
    openWorldConcepts: [heard("Future Funk", { lineage: ["City Pop"] })] }), 0)
    .hypotheses.find((item) => item.genre === "Future Funk");
  const corroborated = engine().evaluate(state({
    topK: [["J-pop", 0.08], ["City Pop", 0.09], ["Nu Disco", 0.075]],
    openWorldConcepts: [heard("Future Funk", { lineage: ["City Pop", "Nu Disco"] })] }), 0)
    .hypotheses.find((item) => item.genre === "Future Funk");
  assert.ok(corroborated.semanticConfidence > alone.semanticConfidence);
  assert.ok(corroborated.independentEvidenceCount > alone.independentEvidenceCount);
});

test("an aesthetic concept is not a genre, however genre-shaped its label looks", () => {
  const result = engine().evaluate(state({
    openWorldConcepts: [heard("Ethereal Soundscapes", { conceptType: "aesthetic", lineage: ["Ambient"] })]
  }), 0);
  assert.equal(result.hypotheses.some((item) => item.genre === "Ethereal Soundscapes"), false,
    "all({compact:true}) returns every concept type; only genre-shaped ones may name a genre");
});

test("temporal stability rises without changing semantic confidence", () => {
  const shared = engine();
  const input = state({ primary: "House", topK: [["House", 0.09], ["Techno", 0.04]], confidence: 0.74 });
  const first = shared.evaluate(input, 0).primary;
  const later = shared.evaluate(input, 6000).primary;
  assert.equal(later.semanticConfidence, first.semanticConfidence);
  assert.ok(later.temporalStability > first.temporalStability);
});

test("a challenger needs margin, independent evidence and persistence before takeover", () => {
  const shared = engine({ switchMargin: 0.04, takeoverMs: 2000 });
  shared.evaluate(state({ confidence: 0.7 }), 0);
  const composite = state({ confidence: 0.68,
    topK: [["J-pop", 0.07], ["Nu Disco", 0.068], ["City Pop", 0.066]],
    openWorldConcepts: [heard("Future Funk", { confidence: 0.72, lineage: ["City Pop", "Nu Disco"] })] });
  let result = shared.evaluate(composite, 1000);
  assert.equal(result.primary.genre, "J-pop");
  assert.equal(result.pendingChallenger.genre, "Future Funk");
  result = shared.evaluate(composite, 2500);
  assert.equal(result.primary.genre, "J-pop");
  result = shared.evaluate(composite, 3100);
  assert.equal(result.primary.genre, "Future Funk");
  assert.equal(result.takeover.from, "J-pop");
});

test("a one-window composite spike remains a challenger and cannot take over", () => {
  const shared = engine({ switchMargin: 0.04, takeoverMs: 2000 });
  shared.evaluate(state({ confidence: 0.7 }), 0);
  const spike = state({ confidence: 0.68,
    topK: [["J-pop", 0.07], ["Nu Disco", 0.068], ["City Pop", 0.066]],
    openWorldConcepts: [heard("Future Funk", { confidence: 0.72, lineage: ["City Pop", "Nu Disco"] })] });
  assert.equal(shared.evaluate(spike, 1000).primary.genre, "J-pop");
  const after = shared.evaluate(state({ confidence: 0.7 }), 1600);
  assert.equal(after.primary.genre, "J-pop");
  assert.equal(after.takeover, null);
});

test("taxonomy children and merely related alternatives are separate", () => {
  const result = engine().evaluate(state({ primary: "House", confidence: 0.8,
    topK: [["House", 0.1], ["Deep House", 0.08], ["Techno", 0.07]] }), 0);
  assert.ok(result.actualSubgenres.some((item) => item.label === "Deep House"));
  assert.ok(result.relatedGenres.some((item) => item.label === "Techno"));
  assert.equal(result.actualSubgenres.some((item) => item.label === "Techno"), false);
});
