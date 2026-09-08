const test = require("node:test");
const assert = require("node:assert/strict");
const GenreLabels = require("../js/semantic/genreLabelShape");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");

test("open-world genre admission accepts unknown names without consulting a catalog", () => {
  for (const label of ["Mallsoft", "Singeli", "아직등록되지않은코어", "New Wave of British Heavy Metal", "Atmospheric Drum and Bass"]) {
    assert.equal(GenreLabels.isPlausibleGenreLabel(label), true, label);
  }
});

test("a Flamingo listening sentence is not a genre label", () => {
  const sentence = "Lush atmospheric synth pads provide harmonic support";
  assert.equal(GenreLabels.isPlausibleGenreLabel(sentence), false);
  assert.equal(GenreLabels.fallbackCategory(sentence), null,
    "an unknown shape must be quarantined, not remapped onto an existing FACT category");
});

test("a malformed open-world record cannot take over the primary genre downstream", () => {
  const sentence = "Lush atmospheric synth pads provide harmonic support";
  const result = new GenreHypotheses.Engine().evaluate({
    classifierGenre: { primary: "Ambient", confidence: 0.62, uncertain: false,
      topK: [{ label: "Ambient", confidence: 0.62 }] },
    openWorldConcepts: [{ canonicalLabel: sentence, conceptType: "genre", confidence: 0.9,
      sources: ["directAudio"], status: "stable" }]
  }, 1000);
  assert.equal(result.primary.genre, "Ambient");
  assert.ok(!result.hypotheses.some(item => item.genre === sentence));
});
