#!/usr/bin/env node
// Regenerates data/approvedCoreTerms.json's classifier-derived entries from the REAL 400-class
// Discogs-EffNet genre list this project's ML model recognizes
// (models/music-shower/assets/discogs-effnet-bsdynamic-1.json). The output is a compatibility
// index for Korean aliases, family hints and diagnostics -- never an admission whitelist or the
// ceiling of what Flamingo/the language system may discover and express.
//
// This does NOT invent transliterations at runtime: KOREAN_TRANSLITERATION below is a fixed,
// human-verified map from each real classifier "-core" class to its standard Korean rendering.
// A classifier class this map doesn't yet cover is reported and skipped, never guessed.
//
// Usage: node scripts/generate-core-terms.cjs [--write]
// Without --write, prints what would change (dry run) and exits 0. Never runs automatically as
// part of npm run check; run it when the classifier manifest changes.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "models/music-shower/assets/discogs-effnet-bsdynamic-1.json");
const approvedPath = path.join(root, "data/approvedCoreTerms.json");

// Standard Korean renderings for every "-core" class this project's classifier can recognize.
// Add an entry here (never guess one at runtime) when the classifier model is updated and this
// script reports an "unmapped classifier core genre" below.
const KOREAN_TRANSLITERATION = {
  "Breakcore": "브레이크코어",
  "Hardcore": "하드코어",
  "Happy Hardcore": "해피 하드코어",
  "Speedcore": "스피드코어",
  "Britcore": "브릿코어",
  "Horrorcore": "호러코어",
  "Deathcore": "데스코어",
  "Grindcore": "그라인드코어",
  "Melodic Hardcore": "멜로딕 하드코어",
  "Metalcore": "메탈코어",
  "Noisecore": "노이즈코어",
  "Post-Hardcore": "포스트 하드코어"
};

function classifierCoreGenres() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return [...new Set(manifest.classes
    .map(label => label.split("---").pop().trim())
    .filter(name => /core$/i.test(name) && name.toLowerCase() !== "score"))];
}

function main() {
  const write = process.argv.includes("--write");
  const approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
  const existingTerms = new Set(approved.entries.map(entry => entry.term));
  const existingAliases = new Set(approved.entries.flatMap(entry => entry.aliases || []).map(a => a.toLowerCase()));

  const additions = [];
  const unmapped = [];
  for (const genre of classifierCoreGenres()) {
    if (existingAliases.has(genre.toLowerCase())) continue; // already covered by a hand-curated entry
    const term = KOREAN_TRANSLITERATION[genre];
    if (!term) { unmapped.push(genre); continue; }
    if (existingTerms.has(term)) continue;
    additions.push({ term, aliases: [genre.toLowerCase()], genreFamily: genre, source: "classifier" });
  }

  console.log(`classifier-recognized "-core" genres: ${classifierCoreGenres().length}`);
  console.log(`already covered: ${classifierCoreGenres().length - additions.length - unmapped.length}`);
  console.log(`new entries to add: ${additions.length}`);
  for (const entry of additions) console.log("  +", entry.term, `(${entry.genreFamily})`);
  if (unmapped.length) {
    console.log(`unmapped classifier core genres (add to KOREAN_TRANSLITERATION by hand, never guessed): ${unmapped.join(", ")}`);
  }

  if (!write) { console.log("\nDry run -- pass --write to update data/approvedCoreTerms.json."); return; }
  if (!additions.length) { console.log("\nNothing to write."); return; }
  approved.entries.push(...additions);
  fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2) + "\n");
  console.log(`\nWrote ${additions.length} new entries to ${path.relative(root, approvedPath)}.`);
}

if (require.main === module) main();
module.exports = { classifierCoreGenres, KOREAN_TRANSLITERATION };
