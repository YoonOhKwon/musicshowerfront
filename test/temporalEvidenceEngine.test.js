const test = require("node:test");
const assert = require("node:assert/strict");
const TemporalEvidence = require("../js/semantic/temporalEvidenceEngine");

const candidate = (text, category, confidence) => ({ text, category, confidence });
const findStable = (result, category) => result.stable.find(item => item.category === category);

test("a higher-confidence challenger does not immediately replace the stable musical-tier facet", () => {
  const engine = new TemporalEvidence.Engine();
  engine.update([candidate("4/4 킥", "rhythm", 0.7)], 0);
  let result = engine.update([candidate("4/4 킥", "rhythm", 0.7)], 100);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥");

  // Challenger clears the switch margin and becomes individually eligible, but must still persist.
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 300);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥");
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 400);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥", "not enough time has passed for the switch to commit");

  // Once the challenger has stayed the top pick for the required persistence window, it takes over.
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 1200);
  assert.equal(findStable(result, "rhythm")?.text, "2-Step");
});

test("fast-tier facets update immediately but never become stable track memory", () => {
  const engine = new TemporalEvidence.Engine();
  const result = engine.update([candidate("드럼 유입", "live", 0.85)], 0);
  assert.equal(result.liveEvents[0]?.text, "드럼 유입");
  assert.equal(findStable(result, "live"), undefined);
  assert.equal(result.trackMemory.some(item => item.category === "live"), false);
});

test("a live event expires by TTL and moves to historical diagnostics", () => {
  const engine = new TemporalEvidence.Engine({ liveTtlMs: 500 });
  engine.update([{ ...candidate("드롭 진입", "live", 0.9), ttlMs: 500 }], 0);
  const result = engine.update([], 501);
  assert.equal(result.liveEvents.length, 0);
  assert.equal(result.displayCandidates.some(item => item.text === "드롭 진입"), false);
  assert.equal(result.historicalEvents.at(-1)?.evidenceStatus, "expired");
});

test("context-tier facets need sustained observations across the context window", () => {
  const engine = new TemporalEvidence.Engine();
  let result;
  for (const at of [0, 2000, 4000]) {
    result = engine.update([candidate("UK 클럽 씬", "scene", 0.8)], at);
  }
  // Enough observations, but under the 5.5s context-tier minimum duration: not eligible yet.
  assert.equal(findStable(result, "scene"), undefined);
  result = engine.update([candidate("UK 클럽 씬", "scene", 0.8)], 6000);
  assert.equal(findStable(result, "scene")?.text, "UK 클럽 씬");
});

test("track memory retains a confirmed fact and expires it if never reconfirmed", () => {
  const engine = new TemporalEvidence.Engine();
  for (const at of [0, 2000, 4000, 6000]) {
    engine.update([candidate("UK 클럽 씬", "scene", 0.8)], at);
  }
  let memoryTexts = engine.update([], 6100).trackMemory.map(item => item.text);
  assert.ok(memoryTexts.includes("UK 클럽 씬"));

  // No reconfirmation for longer than the context window: the memory entry expires.
  memoryTexts = engine.update([], 6100 + 30001).trackMemory.map(item => item.text);
  assert.ok(!memoryTexts.includes("UK 클럽 씬"));
});

test("unsupported and contradicted claims are diagnosed instead of stabilized", () => {
  const engine = new TemporalEvidence.Engine();
  const result = engine.update([
    { ...candidate("브레이크비트", "rhythm", 0.9), supported: false },
    { ...candidate("사이드체인", "production", 0.9), evidenceStatus: "contradicted" }
  ], 0);
  assert.equal(result.evaluated.length, 0);
  assert.equal(result.suppressed.length, 2);
  assert.equal(result.contradictions.length, 1);
});

const materialFixture = () => ([
  { text: "4/4 킥", category: "rhythm", confidence: 0.82, source: "rhythm",
    anchors: ["rhythmicGrammar.fourOnFloor"] },
  { text: "오프비트 강세", category: "rhythm", confidence: 0.8, source: "rhythm",
    anchors: ["primitives.pulse.syncopation"] },
  { text: "촘촘한 하이햇", category: "rhythm", confidence: 0.78, source: "rhythm",
    anchors: ["primitives.pulse.onsetDensity"] },
  { text: "늘어진 스윙 비율", category: "rhythm", confidence: 0.76, source: "rhythm",
    anchors: ["primitives.pulse.swingRatio"] },
  { text: "순차 진행 베이스", category: "performance", confidence: 0.84, source: "idiom",
    concept: "walking_bass", anchors: ["primitives.bass.walkingLikelihood"] },
  { text: "반복 베이스 모티프", category: "performance", confidence: 0.8, source: "idiom",
    anchors: ["primitives.bass.repetition"] },
  { text: "킥-베이스 밀착", category: "performance", confidence: 0.81, source: "instrument",
    anchors: ["primitives.bass.bassKickInteraction", "rhythmicGrammar.fourOnFloor"] },
  { text: "상행 선율", category: "performance", confidence: 0.8, source: "primitive-observation",
    anchors: ["primitives.melody.melodicContour"] },
  { text: "반복되는 모티프", category: "arrangement", confidence: 0.79, source: "idiom",
    anchors: ["primitives.melody.motifRecurrence"] },
  { text: "주고받는 프레이징", category: "performance", confidence: 0.77, source: "primitive-observation",
    anchors: ["primitives.melody.callResponseLikelihood"] },
  { text: "컴핑", category: "performance", confidence: 0.76, source: "idiom",
    concept: "comping", anchors: ["primitives.role.compingLikelihood"] },
  { text: "느린 화성 이동", category: "arrangement", confidence: 0.8, source: "idiom",
    anchors: ["primitives.harmony.chordChangeRate"] },
  { text: "명확한 조성 중심", category: "arrangement", confidence: 0.78, source: "idiom",
    anchors: ["primitives.harmony.tonalCenter"] },
  { text: "사이드체인 펌핑", category: "production", confidence: 0.83, source: "production",
    anchors: ["productionEvidence.sidechain"] },
  { text: "샘플 반복", category: "production", confidence: 0.8, source: "production",
    anchors: ["productionEvidence.sampleBased", "trackCharacter.structure.repetition"] }
]);

test("independent musical concepts survive even when they share a broad category", () => {
  const engine = new TemporalEvidence.Engine();
  const materials = materialFixture();
  let result;
  result = engine.update(materials, 0);
  const before = result.debug.stableAfter;
  result = engine.update(materials, 200);
  console.log("[TemporalEvidence debug]", {
    incoming: result.debug.incoming,
    stableBefore: result.debug.stableBefore,
    stableAfter: result.debug.stableAfter,
    byDomain: result.debug.byDomain,
    evicted: result.debug.evicted
  });
  assert.ok(result.debug.stableAfter >= 10, `expected >= 10 stable concepts, got ${result.debug.stableAfter}`);
  assert.ok(result.debug.stableAfter > before, "second tick should stabilize FACT concepts");
  const texts = result.stable.map(item => item.text);
  for (const needed of ["4/4 킥", "오프비트 강세", "순차 진행 베이스", "반복 베이스 모티프",
    "킥-베이스 밀착", "상행 선율", "사이드체인 펌핑"]) {
    assert.ok(texts.includes(needed), `missing ${needed} in ${texts.join(", ")}`);
  }
  const performance = result.stable.filter(item => item.category === "performance");
  assert.ok(performance.length >= 4, `performance must keep multiple concepts, got ${performance.length}`);
  const conceptIds = result.stable.map(item => item.conceptId);
  assert.equal(new Set(conceptIds).size, conceptIds.length, "duplicate conceptId must not be stored");
  assert.ok(result.debug, "debug instrumentation is part of the public update result");
});

test("only mutually exclusive states compete; ostinato and walking can coexist", () => {
  const engine = new TemporalEvidence.Engine();
  const walking = { text: "순차 진행 베이스", category: "performance", confidence: 0.84, source: "idiom",
    anchors: ["primitives.bass.walkingLikelihood"] };
  const ostinato = { text: "반복 베이스 모티프", category: "performance", confidence: 0.82, source: "idiom",
    anchors: ["primitives.bass.repetition"] };
  let result;
  for (const at of [0, 200]) result = engine.update([walking, ostinato], at);
  const texts = result.stable.map(item => item.text);
  assert.ok(texts.includes("순차 진행 베이스"));
  assert.ok(texts.includes("반복 베이스 모티프"));
});

test("stale local-state evidence decays on the musical window", () => {
  const engine = new TemporalEvidence.Engine({ musicalMs: 800 });
  const item = { text: "오프비트 강세", category: "rhythm", confidence: 0.8, source: "rhythm",
    anchors: ["primitives.pulse.syncopation"] };
  engine.update([item], 0);
  engine.update([item], 200);
  let result = engine.update([], 400);
  assert.ok(result.stable.some(entry => entry.text === "오프비트 강세"));
  result = engine.update([], 1200);
  assert.equal(result.stable.some(entry => entry.text === "오프비트 강세"), false);
  assert.ok(result.debug.evicted.some(entry => entry.reason === "stale-decay"));
});

test("transient LIVE events expire faster than track traits", () => {
  const engine = new TemporalEvidence.Engine({ liveTtlMs: 400, traitMinimumMs: 400, contextMs: 4000 });
  const live = { text: "필터 변화", category: "live", confidence: 0.9, ttlMs: 400 };
  const trait = { text: "샘플 기반", category: "production", confidence: 0.82, source: "production",
    anchors: ["productionEvidence.sampleBased", "trackCharacter.structure.repetition"] };
  for (const at of [0, 200, 400, 600]) engine.update([live, trait], at);
  let result = engine.update([trait], 1001);
  assert.equal(result.liveEvents.some(item => item.text === "필터 변화"), false);
  assert.ok(result.trackTraits.some(item => item.text === "샘플 기반" && item.temporalScope === "TRACK_TRAIT"));
  result = engine.update([], 1200);
  assert.equal(result.trackTraits.find(item => item.text === "샘플 기반")?.evidenceStatus, "stale");
  result = engine.update([], 1200 + 4001);
  assert.equal(result.trackTraits.some(item => item.text === "샘플 기반"), false);
});

test("promoted track traits retain auditable provenance and become stale without self-renewal", () => {
  const engine = new TemporalEvidence.Engine({ traitMinimumMs: 1000, contextMs: 5000 });
  const fact = { ...candidate("샘플 기반", "production", 0.82), source: "production",
    anchors: ["productionEvidence.sampleBased", "trackCharacter.structure.repetition"] };
  let result;
  for (const at of [0, 500, 1000, 1500]) result = engine.update([fact], at);
  const promoted = result.trackTraits.find(item => item.text === "샘플 기반");
  assert.ok(promoted);
  assert.deepEqual(promoted.provenance.path, ["productionEvidence.sampleBased", "trackCharacter.structure.repetition"]);
  result = engine.update([], 2000);
  assert.equal(result.trackTraits.find(item => item.text === "샘플 기반")?.evidenceStatus, "stale");
  assert.equal(result.displayCandidates.some(item => item.text === "샘플 기반"), false);
});
