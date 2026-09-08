const test = require("node:test");
const assert = require("node:assert/strict");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Temporal = require("../js/semantic/temporalEvidenceEngine");
const Manager = require("../js/semantic/semanticFacetManager");
const Selection = require("../js/visual/phraseSelection");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");

const idiomEngine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });

const FORBIDDEN_FACT = /Chicago|UK Garage|French House|시티팝|버블|80년대|일본|하우스 스타일|House-style|bebop|정글 브레이크/i;

function capabilityState(kind) {
  const base = {
    sessionId: 1, semanticEpoch: 1,
    genre: { primary: null, confidence: 0.2, uncertain: true },
    instruments: [],
    rhythmicGrammar: {},
    productionEvidence: {},
    performance: {},
    arrangement: { density: 0.5 },
    moodDimensions: { brightness: 0.5, warmth: 0.5, valence: 0.5, arousal: 0.5 },
    expressionFeatures: { audible: true, observationSeconds: 24, sampleCount: 80 },
    trackCharacter: {
      confidence: 0.8,
      rhythm: { bpm: 120, pulseRegularity: 0.7, onsetDensity: 0.5, rhythmicComplexity: 0.3, breakbeatLikelihood: 0.1 },
      harmony: { tonalness: 0.5, harmonicMotion: 0.3 },
      timbre: { brightness: 0.5, warmth: 0.5 },
      texture: { density: 0.5 },
      dynamics: { pumping: 0.2 },
      production: { subWeight: 0.5, saturation: 0.3 },
      structure: { repetition: 0.5 }
    }
  };
  if (kind === "house") {
    base.rhythmicGrammar = { fourOnFloor: 0.88, kickPeriodicity: 0.86, syncopation: 0.55, swing: 0.12, brokenBeat: 0.1, confidence: 0.84 };
    base.productionEvidence = { sidechain: 0.78, sampleBased: 0.2 };
    base.instruments = [
      { label: "Drums", confidence: 0.8, source: "ml" },
      { label: "Bass", confidence: 0.72, source: "ml" }
    ];
    base.performance = { bassKickInteraction: 0.8, bassPresence: 0.7 };
    base.trackCharacter.structure.repetition = 0.78;
    base.trackCharacter.harmony.harmonicMotion = 0.18;
    base.trackCharacter.dynamics.pumping = 0.74;
    base.trackCharacter.rhythm.bpm = 126;
  }
  if (kind === "jazz") {
    base.rhythmicGrammar = { fourOnFloor: 0.12, swing: 0.78, syncopation: 0.55, brokenBeat: 0.2, kickPeriodicity: 0.25, confidence: 0.8 };
    base.instruments = [
      { label: "Piano", confidence: 0.8, source: "ml" },
      { label: "Bass", confidence: 0.82, source: "ml" },
      { label: "Drums", confidence: 0.7, source: "ml" }
    ];
    base.performance = { walkingBassLikelihood: 0.86, bassFunction: "walking", bassPitchMotion: 0.7 };
    base.trackCharacter.rhythm = { bpm: 168, pulseRegularity: 0.62, onsetDensity: 0.45, rhythmicComplexity: 0.7, breakbeatLikelihood: 0.15 };
    base.trackCharacter.harmony.harmonicMotion = 0.7;
  }
  if (kind === "futurefunk") {
    base.rhythmicGrammar = { fourOnFloor: 0.86, kickPeriodicity: 0.84, syncopation: 0.48, swing: 0.12, brokenBeat: 0.08, confidence: 0.82 };
    base.productionEvidence = { sampleBased: 0.8, sidechain: 0.76, vocalChop: 0.74 };
    base.instruments = [
      { label: "Synthesizer", confidence: 0.75, source: "ml" },
      { label: "Bass", confidence: 0.68, source: "ml" },
      { label: "Voice", confidence: 0.7, source: "ml" }
    ];
    base.performance = { bassSyncopation: 0.72, bassPresence: 0.65 };
    base.trackCharacter.structure.repetition = 0.8;
    base.trackCharacter.harmony.harmonicMotion = 0.22;
  }
  if (kind === "ukg") {
    base.rhythmicGrammar = { fourOnFloor: 0.18, swing: 0.62, syncopation: 0.7, brokenBeat: 0.72, kickPeriodicity: 0.28, confidence: 0.8 };
    base.instruments = [{ label: "Bass", confidence: 0.78, source: "ml" }, { label: "Drums", confidence: 0.7, source: "ml" }];
    base.performance = { bassKickInteraction: 0.25, bassSyncopation: 0.7, bassPitchMotion: 0.62, bassPresence: 0.7 };
    base.trackCharacter.rhythm.breakbeatLikelihood = 0.7;
  }
  if (kind === "ballad") {
    base.rhythmicGrammar = { fourOnFloor: 0.08, swing: 0.15, syncopation: 0.12, brokenBeat: 0.05, kickPeriodicity: 0.2, confidence: 0.7 };
    base.instruments = [{ label: "Piano", confidence: 0.8, source: "ml" }, { label: "Voice", confidence: 0.72, source: "ml" }];
    base.trackCharacter.rhythm = { bpm: 68, pulseRegularity: 0.55, onsetDensity: 0.18, rhythmicComplexity: 0.2, breakbeatLikelihood: 0.05 };
    base.trackCharacter.harmony.harmonicMotion = 0.16;
    base.trackCharacter.texture.density = 0.28;
    base.arrangement.density = 0.26;
  }
  return base;
}

function measure(kind) {
  const state = capabilityState(kind);
  Pipeline.populate(state, { idiomEngine });
  const temporal = new Temporal.Engine();
  const fused = [
    ...(state.detectedIdioms || []),
    ...(state.rhythmFacetCandidates || []),
    ...(state.productionFacetCandidates || []),
    ...(state.composedFactCandidates || []),
    ...(state.primitiveObservationCandidates || [])
  ];
  let temporalResult;
  for (const at of [0, 200, 400]) temporalResult = temporal.update(fused, at);
  const admitted = Manager.local(state);
  const recent = [];
  const displayed = [];
  for (let i = 0; i < 12; i++) {
    const pick = Selection.choose(admitted, recent, () => 0.2 + i * 0.03, { observationSeconds: 24, now: 1000 + i * 800 });
    if (pick) {
      displayed.push(pick);
      recent.push(pick);
    }
  }
  const verified = new Set((state.verifiedClaims?.items || []).map(item => item.concept));
  const stable = new Set((temporalResult.stable || []).map(item => item.conceptId || item.text));
  const admittedConcepts = new Set(admitted.map(item => item.conceptId || item.text));
  const displayedConcepts = new Set(displayed.map(item => item.conceptId || item.text));
  const localStable = [...stable].filter(Boolean);
  const localDisplayed = [...displayedConcepts].filter(key =>
    displayed.some(item => (item.conceptId || item.text) === key && ["FACT", "LIVE"].includes(item.layer)));
  const texts = displayed.map(item => item.text);
  const unsupported = texts.filter(text => FORBIDDEN_FACT.test(text)).length;
  return {
    kind,
    rawDetected: fused.length,
    verified: verified.size,
    temporallyStable: stable.size,
    wordPoolAdmitted: admittedConcepts.size,
    displayedUnique: displayedConcepts.size,
    uniqueSurfaces: new Set(texts).size,
    repetitionRate: displayed.length ? 1 - (new Set(texts).size / displayed.length) : 0,
    domainCoverage: new Set(displayed.map(item => item.category || item.domain)).size,
    unsupportedClaimRate: displayed.length ? unsupported / displayed.length : 0,
    candidateSurvivalRatio: verified.size ? admittedConcepts.size / Math.max(1, verified.size) : 0,
    materialUtilizationRatio: localStable.length ? localDisplayed.length / localStable.length : 0,
    texts,
    idiomTexts: (state.detectedIdioms || []).map(item => item.text)
  };
}

test("capability fixtures keep acoustic materials and refuse unproven genre FACT", () => {
  const house = measure("house");
  const jazz = measure("jazz");
  const funk = measure("futurefunk");
  const ukg = measure("ukg");
  const ballad = measure("ballad");
  console.log("[material utilization]", {
    house, jazz, futurefunk: funk, ukg, ballad
  });
  assert.ok(house.idiomTexts.includes("오프비트 하이햇") || house.texts.some(text => /킥|4\/4|하이햇|펌핑|사이드체인/.test(text)));
  assert.equal(house.texts.some(text => /Chicago|하우스 스타일/.test(text)), false);
  assert.ok(jazz.idiomTexts.some(text => /순차 진행 베이스|스윙/.test(text)) || jazz.texts.some(text => /베이스|스윙/.test(text)));
  assert.equal(jazz.texts.some(text => /bebop|비밥/.test(text)), false);
  assert.ok(funk.texts.some(text => /샘플|사이드체인|4\/4|킥/.test(text)) || funk.idiomTexts.length);
  assert.equal(funk.texts.some(text => /80년대|버블|일본/.test(text)), false);
  assert.ok(ukg.idiomTexts.includes("킥-스네어가 엇갈린 펄스") || ukg.texts.some(text => /싱코|엇|브레이크|2-Step/.test(text)));
  assert.equal(ukg.texts.some(text => /UK Garage/.test(text)), false);
  assert.equal(ballad.texts.some(text => /사이드체인|보컬 찹|브레이크비트/.test(text)), false);
  for (const report of [house, jazz, funk, ukg, ballad]) {
    assert.ok(report.unsupportedClaimRate === 0, `${report.kind} leaked a genre FACT`);
    assert.ok(report.displayedUnique >= 1);
  }
});
