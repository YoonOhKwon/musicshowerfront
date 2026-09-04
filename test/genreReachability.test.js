const test = require("node:test");
const assert = require("node:assert/strict");
const GenreContext = require("../js/semantic/genreContextEngine");
const contextKnowledge = require("../data/genreContextKnowledge.json");
const genreAliases = require("../data/genreAliases.json");
const discogsModel = require("../models/music-shower/assets/discogs-effnet-bsdynamic-1.json");

// Section-0 regression line (58% -> 90%+): a knowledge entry that the real classifier can never
// name is permanently silent, no matter how good its candidates are. This mirrors exactly what
// scripts/knowledge-coverage.cjs reports, using the SAME resolveGenreEntry() the live lookup
// uses, so `npm run check` and that report can never silently disagree.
function canonicalLabelsFromModel() {
  const aliasLookup = new Map(Object.entries(genreAliases).map(([key, value]) => [key.toLowerCase(), value]));
  return (discogsModel.classes || []).map(rawClass => {
    const specific = rawClass.includes("---") ? rawClass.split("---", 2)[1] : rawClass;
    return aliasLookup.get(specific.toLowerCase()) || specific;
  });
}

function reachabilityReport() {
  const canonicalLabels = canonicalLabelsFromModel();
  const genreKeys = Object.keys(contextKnowledge.genres || {});
  const reachable = new Set();
  for (const label of canonicalLabels) {
    const found = GenreContext.resolveGenreEntry(contextKnowledge, label);
    if (found) reachable.add(found);
  }
  return { genreKeys, reachable, unreachable: genreKeys.filter(key => !reachable.has(key)) };
}

test("at least 90% of genreContextKnowledge.json's genre entries are reachable from the real 400-class model", () => {
  const { genreKeys, reachable, unreachable } = reachabilityReport();
  const ratio = reachable.size / genreKeys.length;
  assert.ok(ratio >= 0.9, `reachability ratio ${ratio.toFixed(3)} (${reachable.size}/${genreKeys.length}); unreachable: ${unreachable.join(", ")}`);
});

test("a raw hyphenated classifier label reaches the same knowledge entry as its space-spelled key, through the real canonicalization pipeline", () => {
  // Mirrors semanticEngine.js's canonicalGenre(): genreAliases.json normalizes the raw label
  // FIRST, and only the result is ever compared against genreContextKnowledge.json.
  const aliasLookup = new Map(Object.entries(genreAliases).map(([key, value]) => [key.toLowerCase(), value]));
  const canonicalize = raw => aliasLookup.get(raw.toLowerCase()) || raw;
  for (const [raw, expectedKey] of [["Nu-Disco", "Nu Disco"], ["Synth-pop", "Synthpop"],
    ["Jazz-Funk", "Jazz Funk"], ["Fusion", "Jazz Fusion"], ["Juke", "Footwork"], ["Drum n Bass", "Drum & Bass"]]) {
    assert.equal(GenreContext.resolveGenreEntry(contextKnowledge, canonicalize(raw)), expectedKey, raw);
  }
});

test("a specific metal subgenre label reaches the generic Metal knowledge entry", () => {
  for (const label of ["Heavy Metal", "Black Metal", "Death Metal", "Doom Metal", "Metalcore"])
    assert.equal(GenreContext.resolveGenreEntry(contextKnowledge, label), "Metal", label);
});

test("normalizeGenreLabel folds only punctuation/connector spelling, never merges genuinely different genres", () => {
  const { normalizeGenreLabel } = GenreContext;
  assert.equal(normalizeGenreLabel("Nu-Disco"), normalizeGenreLabel("Nu Disco"));
  assert.notEqual(normalizeGenreLabel("Disco"), normalizeGenreLabel("Nu-Disco"));
  assert.notEqual(normalizeGenreLabel("Nu-Disco"), normalizeGenreLabel("Italo-Disco"));
  assert.equal(normalizeGenreLabel("Drum n Bass"), normalizeGenreLabel("Drum & Bass"));
});

test("Future Funk and French House remain genuinely unreachable from the 400-class model (open genre naming is section 4's job, not an alias patch)", () => {
  const { unreachable } = reachabilityReport();
  assert.ok(unreachable.includes("Future Funk"));
  assert.ok(unreachable.includes("French House"));
});

test("resolveGenreEntry stays honestly null for a label with no matching entry at all", () => {
  assert.equal(GenreContext.resolveGenreEntry(contextKnowledge, "Totally Unknown Genre"), null);
});
