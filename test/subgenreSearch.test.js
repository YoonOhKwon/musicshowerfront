const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const SubgenreSearch = require("../js/ml/subgenreSearch");

const neighborhoods = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/genreNeighborhoods.json"), "utf8"));

test("coarse-to-fine search returns data-driven microgenre neighbors", () => {
  const searcher = new SubgenreSearch.Searcher(neighborhoods);
  const candidates = searcher.search({
    topK: [{ label: "Jungle", confidence: 0.1 }, { label: "Drum & Bass", confidence: 0.08 }],
    character: { rhythm: { bpm: 172, pulseRegularity: 0.38, breakbeatLikelihood: 0.86 }, timbre: { roughness: 0.5 }, space: { spaciousness: 0.6 } }
  });
  assert.ok(candidates.some(item => item.label === "Atmospheric DnB"));
  assert.ok(candidates.some(item => item.label === "Juke"));
  assert.ok(candidates.every(item => item.source === "coarse-to-fine"));
});
