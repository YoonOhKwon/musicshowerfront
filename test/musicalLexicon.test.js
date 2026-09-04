const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Facets = require("../js/semantic/semanticFacets");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const lexicon = require("../data/musicalLexicon.json");
const engine = new Idioms.Engine(lexicon);
const read = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);

function profile() {
  const value = Primitives.empty();
  Object.assign(value.pulse, { pulsePresence: .86, pulseRegularity: .84, subdivisionRatio: 1, accentPeriodicity: 4,
    accentPlacement: .08, metricStability: .8, tempoClass: "moderate", densityPerPulse: 2 });
  Object.assign(value.texture, { voiceCount: 4, dominanceDispersion: .75, textureClass: "polyphonic", sustainRatio: .45 });
  Object.assign(value.role, { leadPresence: .42, leadTransitionRate: .28, accompanimentDensity: .55, bassFunction: "walking", foundationLayer: .76 });
  Object.assign(value.tonal, { tonalFocus: .78, pitchSetBreadth: 5, drone: .2 });
  Object.assign(value.articulation, { attackSharpness: .78, noteLengthRatio: .35, dynamicAccentRange: .7 });
  Object.assign(value.form, { repetitionDepth: .76, sectionNovelty: .3, buildupSlope: .2, releaseDepth: .2 });
  Object.assign(value.production, { spectralTilt: .25, saturationAmount: .7, compressionBehavior: .5, spatialDepth: .5, periodicDucking: .2 });
  return value;
}

test("lexicon schema always has neutral musical terminology and valid primitive anchors", () => {
  const empty = Primitives.empty();
  for (const entry of lexicon.entries) {
    assert.ok(entry.neutralText);
    for (const anchor of entry.anchors) assert.notEqual(read(empty, anchor), undefined, `${entry.id}:${anchor}`);
  }
});

test("neutral labels survive low genre confidence while specialization is gated", () => {
  const low = engine.evaluate(profile(), { primary: "Jazz", family: "Jazz", confidence: .4 });
  assert.ok(low.some(item => item.text === "다성적 짜임새" && item.neutral));
  assert.ok(!low.some(item => !item.neutral));
  const high = engine.evaluate(profile(), { primary: "Jazz", family: "Jazz", confidence: .75 });
  assert.ok(high.some(item => item.text === "집단 즉흥" && !item.neutral));
});

test("invalid primitive combinations do not leak specific idioms", () => {
  const value = profile();
  value.pulse.subdivisionRatio = 1.7;
  assert.ok(!engine.evaluate(value, { primary: "House", confidence: .8 }).some(item => item.text === "정박 4박" || item.text === "4/4 플로어"));
  value.texture.textureClass = "polyphonic"; value.role.leadPresence = .8;
  assert.ok(!engine.evaluate(value, { primary: "Jazz", confidence: .8 }).some(item => item.text === "집단 즉흥"));
  value.role.foundationLayer = null;
  assert.ok(!engine.evaluate(value, { primary: "Jazz", confidence: .8 }).some(item => /베이스/.test(item.text)));
  assert.equal(Facets.safeText("몽환코어", "genre"), false);
  assert.equal(Facets.safeText("브레이크코어", "genre"), true);
});

test("genre-neutral primitive coverage yields musical language across unrelated traditions", () => {
  const traditions = ["실내악", "바로크", "성가", "비밥", "딕시랜드", "하우스", "트랩", "블루그래스", "가믈란", "카나틱", "판소리", "앰비언트"];
  for (const tradition of traditions) {
    const items = engine.evaluate(profile(), { primary: tradition, confidence: .3 });
    assert.ok(items.length >= 3, tradition);
    assert.ok(items.filter(item => !/저역|음압|에너지/.test(item.text)).length >= 2, tradition);
    assert.ok(items.every(item => item.anchors.every(anchor => read({ primitives: profile() }, anchor) !== undefined)));
    assert.ok(items.every(item => item.neutral));
  }
});

test("app loads primitive extraction before idiom naming and fusion", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  assert.ok(html.indexOf("musicalPrimitiveEngine.js") < html.indexOf("musicalIdiomEngine.js"));
  assert.ok(html.indexOf("musicalIdiomEngine.js") < html.indexOf("evidenceFusionEngine.js"));
});
