const test = require("node:test");
const assert = require("node:assert/strict");
const Surface = require("../js/semantic/localSurfaceRealizer");
const PhraseSelection = require("../js/visual/phraseSelection");

test("one concept keeps several FACT surfaces and never adds genre or aesthetic claims", () => {
  const engine = new Surface.Engine();
  const forms = engine.formsFor({ conceptId: "bass.syncopated" });
  const texts = forms.map(item => item.text);
  assert.ok(texts.includes("싱코페이션 베이스"));
  assert.ok(texts.includes("엇박을 타는 베이스"));
  assert.ok(texts.includes("박 사이를 파고드는 베이스"));
  assert.ok(forms.some(item => item.style === "technical"));
  assert.ok(forms.some(item => item.style === "natural"));
  assert.ok(forms.some(item => item.style === "descriptive"));
  assert.equal(texts.some(text => Surface.FORBIDDEN.test(text) || /펑키|Garage|년대/.test(text)), false);
});

test("grammar templates only emit allowed pairs and require vocal evidence for vocal-sample wording", () => {
  const engine = new Surface.Engine();
  const withoutVocal = engine.formsFor({ conceptId: "sample.cell.repeat" }, { licensed: new Set() });
  assert.ok(withoutVocal.some(item => item.text.includes("샘플 셀")));
  assert.equal(withoutVocal.some(item => item.text.includes("보컬")), false);
  const withVocal = engine.formsFor({ conceptId: "sample.cell.repeat" }, { licensed: new Set(["vocal_chop"]) });
  assert.ok(withVocal.some(item => item.text === "반복되는 보컬 조각" || item.text === "잘게 끊긴 보컬 샘플"));
});

test("repetition is keyed by conceptId, so alternate wording does not count as a new fact", () => {
  const engine = new Surface.Engine({ cooldownMs: 5000 });
  const first = engine.choose({ conceptId: "bass.syncopated" }, { now: 1000 });
  const held = engine.choose({ conceptId: "bass.syncopated" }, {
    now: 1500,
    recent: [first]
  });
  assert.equal(held.conceptId, "bass.syncopated");
  assert.equal(held.cooldown, true);
  assert.equal(held.text, first.text);
  const later = engine.choose({ conceptId: "bass.syncopated" }, { now: 8000 });
  assert.equal(later.cooldown, false);
  assert.equal(later.conceptId, "bass.syncopated");
  assert.notEqual(later.text, first.text);
});

test("phrase selection treats two surfaces of the same concept as one concept", () => {
  const a = { text: "싱코페이션 베이스", conceptId: "bass.syncopated", category: "performance", layer: "FACT", source: "idiom", confidence: 0.8 };
  const b = { text: "엇박을 타는 베이스", conceptId: "bass.syncopated", category: "performance", layer: "FACT", source: "idiom", confidence: 0.8 };
  const other = { text: "상행 선율", conceptId: "melody.contour", category: "performance", layer: "FACT", source: "idiom", confidence: 0.8 };
  const Quality = require("../js/semantic/phraseQuality");
  assert.equal(Quality.sameConcept(a, b), true);
  const chosen = PhraseSelection.choose([b, other], [a], () => 0.01, { observationSeconds: 20, now: 1000 });
  assert.ok(chosen);
  assert.notEqual(chosen.conceptId, "bass.syncopated");
});

test("surface realizer refuses to realize an aesthetic or genre gloss of a bass fact", () => {
  const engine = new Surface.Engine();
  const forms = engine.formsFor({ conceptId: "bass.syncopated" });
  assert.equal(forms.some(item => /펑키|UK|Garage|90년대/.test(item.text)), false);
  const chosen = engine.choose({ conceptId: "bass.syncopated", text: "싱코페이션 베이스" }, { now: 1 });
  assert.equal(chosen.canonicalText, "싱코페이션 베이스");
  assert.match(chosen.text, /베이스/);
});
