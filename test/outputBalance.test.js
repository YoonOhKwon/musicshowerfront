const test = require("node:test");
const assert = require("node:assert/strict");
const Expressions = require("../js/semantic/musicExpressionEngine");
const Manager = require("../js/semantic/semanticFacetManager");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Critic = require("../js/semantic/languageCritic");
const Quality = require("../js/semantic/phraseQuality");
const Selection = require("../js/visual/phraseSelection");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { profile } = require("./fixtures/languageProfiles");

function measured(overrides = {}) {
  return { sampleCount: 10, audible: true, observationSeconds: 6, rms: 0.2, energy: 0.6,
    bass: 0.7, mid: 0.2, high: 0.1, centroid: 6500, transientDensity: 0.55,
    ...overrides };
}

test("static descriptors are FACT while thresholded deltas are LIVE with transition metadata", () => {
  const stable = Expressions.generate({ expressionFeatures: measured(), trackCharacter: { rhythm: { pulseRegularity: 0.8 },
    timbre: { brightness: 0.75 }, texture: {} }, moodDimensions: {} });
  for (const text of ["강한 저역", "밝은 음색", "반복되는 펄스"])
    assert.equal(stable.find(item => item.text === text)?.layer, "FACT", text);
  assert.equal(stable.some(item => item.layer === "LIVE"), false);

  const changed = Expressions.generate({ expressionFeatures: measured({ deltaRms: 0.08, deltaEnergy: -0.25,
    deltaLowEnergy: 0.2, dropScore: 0 }), trackCharacter: {}, moodDimensions: {} });
  for (const text of ["음압 상승", "급격한 하강", "저역 유입"]) {
    const item = changed.find(candidate => candidate.text === text);
    assert.equal(item?.layer, "LIVE", text);
    assert.ok(item.deltaSource && item.deltaMagnitude > 0, text);
    assert.ok(Number.isFinite(item.currentValue), text);
  }
});

test("a tiny low-end delta never becomes a LIVE entrance", () => {
  const words = Expressions.generate({ expressionFeatures: measured({ bass: 0.85, deltaLowEnergy: 0.01 }),
    trackCharacter: {}, moodDimensions: {} });
  assert.ok(words.some(item => item.text === "강한 저역" && item.layer === "FACT"));
  assert.ok(!words.some(item => item.text === "저역 유입"));
});

test("production-like fixtures run the shared high-resolution candidate pipeline", () => {
  const cases = {
    futurefunk: ["4/4 플로어", "사이드체인 펌핑", "샘플 기반"],
    ukgarage: ["2-Step", "스윙 필", "브레이크비트"],
    jazztrio: ["워킹 베이스", "스윙 필"],
    ambient: ["긴 서스테인", "적은 트랜지언트"]
  };
  for (const [name, expected] of Object.entries(cases)) {
    const state = profile(name), generated = Manager.base(state);
    const accepted = Critic.rank(generated, { context: { snapshot: Snapshot.serialize(state),
      eligibleTexts: generated.map(item => item.text) }, limit: 100 }).selected;
    for (const text of expected) assert.ok(accepted.some(item => item.text === text && item.layer === "FACT"), `${name}: ${text}`);
  }
});

test("walking bass remains absent when its dedicated performance evidence is weak", () => {
  const state = profile("jazztrio");
  state.performance = { ...state.performance, walkingBassLikelihood: 0.4 };
  Pipeline.populate(state);
  assert.ok(!state.instrumentFacetCandidates.some(item => item.text === "워킹 베이스"));
});

test("relation candidates carry runtime families and a stronger specific relation wins", () => {
  const relations = profile("futurefunk").genreContextEvidence.candidates.filter(item => item.relationFamily);
  assert.ok(relations.some(item => item.relationFamily === "PARENT"));
  assert.ok(relations.every(item => Number.isFinite(item.relationScore)));
  const french = { text: "French House 계열", category: "lineage", layer: "CONTEXT", relationFamily: "PARENT",
    relationScore: 0.91, confidence: 0.91, weight: 0.91, source: "genre-relation" };
  const house = { ...french, text: "House 계열", relationScore: 0.72, confidence: 0.72, weight: 0.72 };
  assert.ok(Selection.weight(french, [], { observationSeconds: 30 }) > Selection.weight(house, [], { observationSeconds: 30 }));
  assert.ok(Selection.weight(house, [french], { observationSeconds: 30 }) < Selection.weight(house, [], { observationSeconds: 30 }) * 0.6);
});

test("artist relations receive a stronger repeat penalty than ordinary context", () => {
  const artist = { text: "Daft Punk 연상", category: "association", layer: "CONTEXT", kind: "artist",
    relationFamily: "ARTIST", relationScore: 0.8, confidence: 0.8, weight: 1 };
  const era = { text: "2010년대 인터넷 스타일", category: "era", layer: "CONTEXT",
    relationFamily: "ERA", relationScore: 0.8, confidence: 0.8, weight: 1 };
  const artistRepeat = Selection.weight(artist, [artist], { observationSeconds: 30 }) / Selection.weight(artist, [], { observationSeconds: 30 });
  const eraRepeat = Selection.weight(era, [era], { observationSeconds: 30 }) / Selection.weight(era, [], { observationSeconds: 30 });
  assert.ok(artistRepeat < eraRepeat);
});

test("suffix-only variants dedupe, while developer genre/aesthetic aliases do not", () => {
  assert.equal(Quality.conceptKey("버블기 도시 미학"), Quality.conceptKey("버블기 도시 미학 연상"));
  assert.equal(Quality.conceptKey({ text: "재즈 클럽 문화", category: "culture", layer: "CONTEXT" }),
    Quality.conceptKey({ text: "재즈 클럽 문화 연관", category: "culture", layer: "CONTEXT" }));
  assert.equal(Quality.conceptKey({ text: "재즈 소편성 씬", category: "scene", layer: "CONTEXT" }),
    Quality.conceptKey({ text: "재즈 소편성 씬 연관", category: "scene", layer: "CONTEXT" }));
  assert.notEqual(Quality.conceptKey("Kawaii 미학"), Quality.conceptKey("카와이 미학"),
    "cross-script aesthetic aliases are not a runtime identity table");
  assert.notEqual(Quality.conceptKey({ text: "Future Funk", category: "genre", layer: "CONTEXT" }),
    Quality.conceptKey({ text: "퓨처펑크", category: "genre", layer: "CONTEXT" }),
    "genre romanization aliases are not a runtime identity table");
  assert.notEqual(Quality.conceptKey("House 계열"), Quality.conceptKey("House 문화"));
  const pool = [{ text: "버블기 도시 미학", category: "association", layer: "AESTHETIC", weight: 1 }];
  assert.equal(Selection.choose(pool, [], () => 0, { active: ["버블기 도시 미학 연상"], observationSeconds: 30 }), undefined);
  const literalAcrossFamilies = Manager.curate([
    { text: "Pirate Radio 문화", category: "scene", layer: "CONTEXT", relationFamily: "SCENE", confidence: .8 },
    { text: "Pirate Radio 문화", category: "culture", layer: "CONTEXT", relationFamily: "CULTURE", confidence: .79 }
  ]);
  assert.equal(literalAcrossFamilies.length, 1, "identical screen text is never repeated just because relation metadata differs");
});

test("critic diagnostics expose the actual evidence gates", () => {
  const snapshot = { rhythmicGrammar: { swing: 0.9 }, instrumentationEvidence: { bass: 0.9 },
    productionEvidence: { sidechain: 0.9 }, analysisWindow: { windowSeconds: 30 }, confidence: 0.8 };
  const axes = Critic.assess({ text: "스윙 필", category: "rhythm", layer: "FACT", source: "llm",
    confidence: 0.9, anchors: ["rhythmicGrammar.swing"] }, [], { snapshot });
  assert.equal(axes.diagnostics.rejectionReason, "insufficient-independent-axes");
  assert.equal(axes.diagnostics.gates.axesPass, false);
  const mismatch = Critic.assess({ text: "복합 리듬", category: "rhythm", layer: "FACT", source: "llm",
    confidence: 0.9, anchors: ["instrumentationEvidence.bass", "productionEvidence.sidechain"] }, [], { snapshot });
  assert.equal(mismatch.diagnostics.rejectionReason, "facet-evidence-group-mismatch");
  assert.equal(mismatch.diagnostics.gates.groupMatchPass, false);
  const fakeTransition = Critic.assess({ text: "저역 유입", category: "live", layer: "LIVE", source: "llm",
    confidence: .9, anchors: ["measurements.bass"] }, [], { snapshot });
  assert.equal(fakeTransition.diagnostics.rejectionReason, "live-transition-without-delta");
  assert.equal(fakeTransition.diagnostics.gates.liveDeltaPass, false);
});
