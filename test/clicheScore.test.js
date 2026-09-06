const test = require("node:test");
const assert = require("node:assert/strict");
const ClicheScore = require("../js/semantic/clicheScore");
const Facets = require("../js/semantic/semanticFacets");
const Selection = require("../js/visual/phraseSelection");

test("safeText still hard-rejects the generic AI-poetry blocklist in strict/context facets", () => {
  assert.equal(Facets.safeText("과열된 긴장", "dynamics"), false);
  assert.equal(Facets.safeText("냉각된 긴장 계열", "lineage"), false);
  assert.equal(Facets.safeText("금속성 황홀", "rhythm"), false);
});

test("safeText no longer vetoes the same phrases in the open layer (mood/association)", () => {
  assert.ok(Facets.safeText("과열된 긴장", "mood"));
  assert.ok(Facets.safeText("금속성 황홀", "association"));
  assert.ok(Facets.safeText("저중력 부유감", "mood"));
});

test("safeText keeps identity hygiene while leaving open-world genre spelling available", () => {
  assert.equal(Facets.safeText("이 곡은 재즈입니다", "mood"), false);
  assert.ok(Facets.safeText("유리코어 감성", "association"));
  assert.ok(Facets.safeText("하드코어 감성", "association"));
});

test("open-layer word cap is looser than strict/context, but still bounded (no run-on narrative)", () => {
  const eightWords = "하나 둘 셋 넷 다섯 여섯 일곱 여덟";
  assert.equal(Facets.safeText(eightWords, "rhythm"), false, "strict layer keeps the 7-word cap");
  assert.ok(Facets.safeText(eightWords, "mood"), "open layer allows up to 10 words");
  const twelveWords = "하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나 열둘";
  assert.equal(Facets.safeText(twelveWords, "mood"), false, "open layer is still bounded, not unlimited");
});

test("clicheScore.score is 0 for ordinary text and >0 for the known cliche family", () => {
  assert.equal(ClicheScore.score("따뜻한 오후의 결"), 0);
  assert.ok(ClicheScore.score("과열된 긴장") > 0);
});

test("clicheScore.score compounds on literal recent repeats and on other cliche-family phrases seen recently", () => {
  const fresh = ClicheScore.score("금속성 황홀", []);
  const repeated = ClicheScore.score("금속성 황홀", [{ text: "금속성 황홀" }, { text: "금속성 황홀" }]);
  const familyPressure = ClicheScore.score("금속성 황홀", [{ text: "과열된 긴장" }, { text: "차가운 황홀" }]);
  assert.ok(repeated > fresh);
  assert.ok(familyPressure > fresh);
  assert.ok(ClicheScore.score("금속성 황홀", Array(20).fill({ text: "금속성 황홀" })) <= 1, "score is clamped, never exceeds 1");
});

test("phraseSelection.weight grades a cliche open-layer phrase down but never to zero, and grades it down further on reuse", () => {
  const cliche = { text: "과열된 긴장", category: "mood", layer: "IMPRESSION", weight: 0.7, relevance: 0.7,
    novelty: 0.6, specificity: 0.6, contrastiveness: 0.6, confidence: 0.7, source: "impression" };
  const fresh = { ...cliche, text: "따뜻한 오후의 결" };
  const w1 = Selection.weight(cliche, [], { observationSeconds: 30 });
  const w2 = Selection.weight(fresh, [], { observationSeconds: 30 });
  assert.ok(w1 > 0, "never discarded outright");
  assert.ok(w1 < w2, "a cliche phrase is scored below an equivalent fresh one");
  const w3 = Selection.weight(cliche, [{ text: "과열된 긴장" }, { text: "과열된 긴장" }], { observationSeconds: 30 });
  assert.ok(w3 < w1, "recent reuse pushes the score down further");
});

test("phraseSelection.weight leaves strict/context-layer phrases unaffected by clichePenalty", () => {
  const strict = { text: "과열된 긴장", category: "rhythm", layer: "FACT", weight: 0.7, relevance: 0.7,
    novelty: 0.6, specificity: 0.6, contrastiveness: 0.6, confidence: 0.7, source: "rhythm" };
  // FACT-layer weight() should be identical whether or not the text happens to look cliche --
  // the penalty only ever applies to AESTHETIC/IMPRESSION.
  const other = { ...strict, text: "평범한 문구" };
  assert.equal(Selection.weight(strict, [], { observationSeconds: 30 }), Selection.weight(other, [], { observationSeconds: 30 }));
});
