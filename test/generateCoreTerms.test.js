const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { classifierCoreGenres, KOREAN_TRANSLITERATION } = require("../scripts/generate-core-terms.cjs");
const Facets = require("../js/semantic/semanticFacets");

test("classifierCoreGenres reads real '-core' genres from the classifier manifest, excluding the false positive 'Score'", () => {
  const genres = classifierCoreGenres();
  assert.ok(genres.includes("Metalcore"));
  assert.ok(genres.includes("Breakcore"));
  assert.ok(!genres.some(name => name.toLowerCase() === "score"),
    "Stage & Screen---Score must not be mistaken for a '-core' neologism");
});

test("every classifier-recognized core genre has a known, human-verified Korean transliteration (or is explicitly reported as unmapped, never guessed)", () => {
  const unmapped = classifierCoreGenres().filter(name => !KOREAN_TRANSLITERATION[name]);
  assert.deepEqual(unmapped, [], `add these to KOREAN_TRANSLITERATION in scripts/generate-core-terms.cjs: ${unmapped.join(", ")}`);
});

// Regression coverage for the project-transformation ask: -코어 expressiveness should track what
// the classifier genuinely recognizes (400-class Discogs-EffNet manifest), not only whatever a
// human remembered to hand-curate into data/approvedCoreTerms.json.
test("a classifier-derived core term (e.g. 메탈코어/Metalcore) is now accepted by safeText(), not just the original 11 hand-curated ones", () => {
  assert.equal(Facets.safeText("메탈코어 질감", "association"), true);
  assert.equal(Facets.safeText("그라인드코어 리듬", "association"), true);
  // A genuinely-unlisted, invented "-코어" coinage must still be rejected -- this expands the
  // ceiling to real classifier vocabulary, it does not remove the gate against fabrication.
  assert.equal(Facets.safeText("헬로키티코어", "association"), false);
});
