const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));

test("semantic dictionary has a fallback vocabulary for every broad genre family", () => {
  const dictionary = readJson("data/semanticDictionary.json");
  const taxonomy = readJson("data/genreTaxonomy.json");

  assert.deepEqual(
    Object.keys(dictionary.family).sort(),
    Object.keys(taxonomy).sort()
  );

  for (const family of Object.keys(taxonomy)) {
    assert.ok(dictionary.family[family].length >= 3, `${family} needs useful fallback words`);
  }
});

test("semantic dictionary covers every installed instrument and mood label", () => {
  const dictionary = readJson("data/semanticDictionary.json");
  const instruments = readJson("models/music-shower/assets/mtg_jamendo_instrument-discogs-effnet-1.json").classes;
  const moods = readJson("models/music-shower/assets/mtg_jamendo_moodtheme-discogs-effnet-1.json").classes;

  const groupedInstruments = new Set(Object.values(dictionary.instrumentGroups).flatMap(group => group.labels));
  const groupedMoods = new Set(Object.values(dictionary.moodTagGroups).flatMap(group => group.labels));

  assert.deepEqual(instruments.filter(label => !groupedInstruments.has(label)), []);
  assert.deepEqual(moods.filter(label => !groupedMoods.has(label)), []);
});
