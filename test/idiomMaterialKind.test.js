const test = require("node:test");
const assert = require("node:assert/strict");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");

const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });

test("acoustic material idioms fire from audio evidence without a genre label", () => {
  const value = Primitives.empty();
  Object.assign(value.pulse, { kickPeriodicity: 0.8, offbeatActivity: 0.62, pulsePresence: 0.8 });
  const texts = engine.evaluate(value, {}).map(item => item.text);
  assert.ok(texts.includes("오프비트 하이햇"));
  assert.ok(!texts.includes("디스코 기반 하우스 그루브"));
});

test("two-step topology is local FACT while UK Garage naming stays contextual", () => {
  const value = Primitives.empty();
  Object.assign(value.pulse, { breakDensity: 0.72, shuffleStrength: 0.62, kickPeriodicity: 0.2, pulsePresence: 0.7 });
  const items = engine.evaluate(value, { primary: "UK Garage", confidence: 0.9 });
  const texts = items.map(item => item.text);
  assert.ok(texts.includes("킥-스네어가 엇갈린 펄스"));
  assert.ok(!texts.includes("2-Step 스윙"));
  assert.equal(lexicon.entries.find(entry => entry.id === "garage_two_step").kind, "CONTEXTUAL_INTERPRETATION");
  assert.equal(lexicon.entries.find(entry => entry.id === "rhythm.two_step_topology").kind, "ACOUSTIC_MATERIAL");
});

test("contextual interpretations stay gated even when the matching genre label is supplied", () => {
  const value = Primitives.empty();
  Object.assign(value.production, { brightness: 0.9 });
  const gated = { id: "gate-test", kind: "CONTEXTUAL_INTERPRETATION", facet: "production",
    neutralText: "가짜 신스웨이브 표현", required: [{ path: "production.brightness", min: 0.5 }],
    requiredContext: { genreFamilies: ["Synthwave"], minConfidence: 0.6 }, contextMode: "REQUIRED", minConfidence: 0.3 };
  const isolated = new Idioms.Engine({ version: 1, entries: [gated] },
    { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
  assert.equal(isolated.evaluate(value, { primary: "Synthwave", confidence: 0.9 }).length, 0);
});
