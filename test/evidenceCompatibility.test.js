const test = require("node:test");
const assert = require("node:assert/strict");
const Compatibility = require("../js/semantic/evidenceCompatibility");
const Layers = require("../js/semantic/languageLayerPolicy");
const Quality = require("../js/semantic/phraseQuality");

const read = (object, path) => String(path).split(".")
  .reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, object);

const brightTrack = {
  confidence: 0.9, primaryGenre: "Future Funk",
  moodDimensions: { brightness: 0.86, valence: 0.72, arousal: 0.8 },
  timbre: { brightness: "very high", warmth: "low" },
  texture: { density: "high" }, measurements: { energy: 0.82, bpm: 128 },
  rhythmicGrammar: { fourOnFloor: 0.9 }, productionEvidence: { sampleBased: 0.85 }
};

test("a claim is supported when the measurement points the same way, contradicted when it does not", () => {
  const agrees = Compatibility.assess("밝고 투명한 신스", brightTrack);
  const opposes = Compatibility.assess("어두운 저역 중심", brightTrack);
  assert.ok(agrees.support > 0.7, `expected support for a bright claim on bright music, got ${agrees.support}`);
  assert.equal(agrees.contradiction, 0);
  assert.ok(opposes.contradiction > 0.4, `expected a contradiction for a dark claim on bright music, got ${opposes.contradiction}`);
});

test("a phrase with no direction claim is neither supported nor contradicted", () => {
  const neutral = Compatibility.assess("피아노 트리오", brightTrack);
  assert.equal(neutral.checked, 0);
  assert.equal(neutral.contradiction, 0);
});

test("level words and raw numbers are both read as measurements", () => {
  assert.equal(Compatibility.normalize("very high"), 0.88);
  assert.equal(Compatibility.normalize(true), 1);
  assert.ok(Math.abs(Compatibility.normalize(128, 200) - 0.64) < 1e-9);
  assert.equal(Compatibility.normalize("unknown"), null);
});

test("extremeness alone is no longer evidence: direction decides the score", () => {
  const anchors = ["timbre.brightness", "productionEvidence.sampleBased"];
  const agrees = Layers.evidenceScore({ text: "밝고 투명한 신스", category: "production", confidence: 0.8, anchors }, brightTrack, read);
  const opposes = Layers.evidenceScore({ text: "어두운 저역 중심", category: "production", confidence: 0.8, anchors }, brightTrack, read);
  assert.ok(agrees.score > opposes.score + 0.25,
    `identical anchors must not score the same in both directions (${agrees.score} vs ${opposes.score})`);
  assert.ok(opposes.contradiction > 0.4);
});

test("independent evidence axes raise the score more than piling anchors on one object", () => {
  const spread = Layers.evidenceScore({ text: "정박 4박", category: "rhythm", confidence: 0.8,
    anchors: ["rhythmicGrammar.fourOnFloor", "productionEvidence.sampleBased", "primaryGenre"] }, brightTrack, read);
  const narrow = Layers.evidenceScore({ text: "정박 4박", category: "rhythm", confidence: 0.8,
    anchors: ["rhythmicGrammar.fourOnFloor"] }, brightTrack, read);
  assert.ok(spread.axes.length >= 3, `expected several axes, got ${spread.axes}`);
  assert.ok(spread.score > narrow.score);
});

test("specificity separates a synthesised phrase from a bare descriptor", () => {
  const synthesised = Quality.specificity({ text: "샘플의 향수", category: "mood" }, brightTrack);
  const primitive = Quality.specificity({ text: "밝음", category: "mood" }, brightTrack);
  const generic = Quality.specificity({ text: "몽환적", category: "mood" }, brightTrack);
  assert.ok(synthesised > primitive, `${synthesised} should beat a raw descriptor ${primitive}`);
  assert.ok(synthesised > generic, `${synthesised} should beat a generic term ${generic}`);
});

test("novelty falls for a concept the screen just showed, even when the wording differs", () => {
  const fresh = Quality.novelty({ text: "달콤한 향수" }, ["4/4 플로어", "신스 리드"]);
  const echoed = Quality.novelty({ text: "달콤한 회고" }, ["달콤한 향수", "4/4 플로어"]);
  assert.ok(fresh > 0.9);
  assert.ok(echoed < fresh - 0.2, `a synonym of a recent phrase must not read as new (${echoed} vs ${fresh})`);
});

test("contrastiveness ranks a named style above a phrase that fits any track", () => {
  const named = Quality.contrastiveness({ text: "French House 계열", category: "lineage" }, brightTrack);
  const anywhere = Quality.contrastiveness({ text: "강렬함", category: "mood" }, brightTrack);
  assert.ok(named > anywhere + 0.2, `${named} vs ${anywhere}`);
});

test("raw descriptors are recognised so display can limit them without deleting them", () => {
  assert.equal(Quality.isPrimitive("높은 밀도"), true);
  assert.equal(Quality.isPrimitive("차가움"), true);
  assert.equal(Quality.isPrimitive("French House 계열"), false);
  assert.equal(Quality.isPrimitive("샘플의 향수"), false);
});
