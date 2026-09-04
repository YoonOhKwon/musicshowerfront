const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Facets = require("../js/semantic/semanticFacets");
const Evidence = require("../js/semantic/semanticEvidence");
const Instruments = require("../js/semantic/instrumentationEventEngine");
const Rhythmic = require("../js/semantic/rhythmicGrammar");
const Context = require("../js/semantic/genreContextEngine");
const Critic = require("../js/semantic/languageCritic");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Mapping = require("../js/visual/backgroundAudioMapper");
const { languageSchema } = require("../lib/languageService");
const knowledge = require("../data/genreContextKnowledge.json");

function state(primary, extra = {}) {
  return {
    genre: { primary, family: "Electronic / Club", confidence: 0.9, uncertain: false, secondary: [] },
    expressionFeatures: { audible: true, bass: 0.6, tempoStability: 0.85, bpm: 128, onsetRate: 4,
      transientDensity: 0.65, harmonicMovement: 0.7, sampleCount: 50, observationSeconds: 25 },
    rhythmicGrammar: { fourOnFloor: 0.86, swing: 0.8, syncopation: 0.78, brokenBeat: 0.82, confidence: 0.9, onsetCount: 24 },
    productionEvidence: { sampleBased: 0.82, filterSweep: null, sidechain: null, sourceSeparation: false },
    instruments: [{ label: "piano", confidence: 0.82, source: "ml" }, { label: "bass", confidence: 0.79, source: "ml" },
      { label: "synthesizer", confidence: 0.76, source: "ml" }, { label: "drums", confidence: 0.75, source: "ml" }],
    moodDimensions: { warmth: 0.75, brightness: 0.7 }, ...extra
  };
}

test("open schema exposes fourteen facets without adjective enums", () => {
  assert.deepEqual(Object.keys(languageSchema.properties), Facets.names);
  assert.equal(languageSchema.properties.mood.items.properties.text.enum, undefined);
  assert.equal(languageSchema.required.length, 14);
});

test("Future Funk, City Pop and UK Garage priors are evidence-gated", () => {
  const engine = new Context.Engine(knowledge);
  const future = engine.evaluate(state("Future Funk"));
  assert(future.matchedPriors.includes("French House 계열"));
  assert(future.matchedPriors.includes("Disco 계열"));
  assert.equal(future.matchedPriors.some(x => /마법소녀|Kawaii/.test(x)), false);
  const city = engine.evaluate(state("City Pop"));
  assert(city.matchedPriors.includes("AOR 계열"));
  assert(city.matchedPriors.includes("Jazz Funk 계열"));
  const uk = engine.evaluate(state("UK Garage"));
  assert(uk.matchedPriors.includes("2-Step 계열"));
  assert(uk.matchedPriors.includes("Pirate Radio 문화"));
});

test("weak genre or missing sonic evidence produces no historical or cultural context", () => {
  const engine = new Context.Engine(knowledge);
  assert.deepEqual(engine.evaluate(state("City Pop", { genre: { primary: "City Pop", confidence: 0.6, uncertain: false } })).candidates, []);
  assert.deepEqual(engine.evaluate(state("UK Garage", { rhythmicGrammar: {}, instruments: [], expressionFeatures: { audible: true } })).candidates, []);
});

test("an unlisted future genre can use the same open grounded critic path", () => {
  const snapshot = { primaryGenre: "Gqom", confidence: 0.9, genreEvidence: [{ label: "Gqom", confidence: 0.9 }],
    genreContextEvidence: { aestheticEvidence: {} }, rhythm: { onsetDensity: "high" },
    production: { subWeight: "very high" }, analysisWindow: { windowSeconds: 30 } };
  const item = { text: "Durban 클럽 미학", category: "association", kind: "style", role: "none", confidence: 0.86,
    anchors: ["primaryGenre", "rhythm.onsetDensity", "production.subWeight"] };
  assert.equal(Critic.assess(item, [], { snapshot, eligibleTexts: [] }).valid, true);
});

test("instrument histories require correlated change for solo and never infer ensemble size", () => {
  const engine = new Instruments.Engine({ eventTtlMs: 5000 });
  for (let i = 0; i < 5; i++) engine.update([{ label: "piano", confidence: 0.3, source: "ml" },
    { label: "bass", confidence: 0.28, source: "ml" }], { accompanimentDensity: 0.75, onsetActivity: 0.5 }, i * 500);
  let result = engine.update([{ label: "piano", confidence: 0.91, source: "ml" },
    { label: "bass", confidence: 0.3, source: "ml" }], { accompanimentDensity: 0.35, onsetActivity: 0.82 }, 3000);
  assert.equal(result.performance.soloLikelihood, 0);
  result = engine.update([{ label: "piano", confidence: 0.94, source: "ml" },
    { label: "bass", confidence: 0.25, source: "ml" }], { accompanimentDensity: 0.25, onsetActivity: 0.86,
      melodicActivity: 0.9, pitchActivity: 0.88 }, 3500);
  assert(result.performance.soloLikelihood >= 0.8);
  assert(result.instrumentEvents.some(x => x.text === "피아노 등장"));
  assert.equal(result.arrangement.verifiedEnsembleSize, null);
});

test("walking bass and synth lead stay absent without source-specific pitch evidence", () => {
  const bass = Instruments.performance([{ id: "bass", label: "베이스", confidence: 0.9 }], [], { onsetActivity: 0.8 });
  assert.equal(bass.walkingBassLikelihood, null);
  const supported = Instruments.performance([{ id: "bass", label: "베이스", confidence: 0.9 }], [],
    { onsetActivity: 0.8, bassPitchMotion: 0.9, bassOnsetRegularity: 0.9 });
  assert(supported.walkingBassLikelihood >= 0.8);
  const synth = Instruments.performance([{ id: "synthesizer", label: "신스", confidence: 0.9 }], [],
    { onsetActivity: 0.8, melodicActivity: 0.9 });
  assert.equal(synth.leadLikelihood, null);
});

test("vocal entrance and synth lead require temporal change, with lead pitch evidence", () => {
  const vocal = new Instruments.Engine({ eventTtlMs: 5000 });
  for (let i = 0; i < 4; i++) vocal.update([{ label: "vocal", confidence: 0.15, source: "ml" }],
    { accompanimentDensity: 0.6, onsetActivity: 0.4 }, i * 500);
  vocal.update([{ label: "vocal", confidence: 0.82, source: "ml" }],
    { accompanimentDensity: 0.6, onsetActivity: 0.6 }, 2200);
  const entered = vocal.update([{ label: "vocal", confidence: 0.86, source: "ml" }],
    { accompanimentDensity: 0.6, onsetActivity: 0.6 }, 2700);
  assert(entered.instrumentEvents.some(x => x.text === "보컬 유입"));

  const synth = new Instruments.Engine({ eventTtlMs: 5000 });
  for (let i = 0; i < 4; i++) synth.update([{ label: "synthesizer", confidence: 0.2, source: "ml" }],
    { accompanimentDensity: 0.7, onsetActivity: 0.4 }, i * 500);
  const lead = synth.update([{ label: "synthesizer", confidence: 0.9, source: "ml" }],
    { accompanimentDensity: 0.5, onsetActivity: 0.8, melodicActivity: 0.9, pitchActivity: 0.9 }, 2200);
  assert(lead.instrumentEvents.some(x => x.text === "신스 리드 유입"));
});

test("rhythmic grammar labels four-on-floor only from repeated low impacts", () => {
  const events = Array.from({ length: 12 }, (_, i) => ({ at: i * 500, strength: 0.9, lowImpact: 0.9 }));
  const result = Rhythmic.analyze(events, 120, 0.9, 5600);
  assert(result.fourOnFloor >= 0.8);
  assert(result.candidates.some(x => x.text === "4/4 플로어"));
});

test("semantic snapshots carry bounded evidence and no imaginary pitch/source fields", () => {
  const serialized = Snapshot.serialize({ ...state("Future Funk"), instrumentation: { observed: [
    { id: "piano", label: "피아노", confidence: 0.9, dominance: 0.7, source: "ml" }] },
    instrumentEvents: [{ text: "피아노 등장", instrument: "piano", kind: "entrance", confidence: 0.9, at: 100 }],
    performance: { soloLikelihood: 0, pitchActivity: null }, arrangement: { verifiedEnsembleSize: null },
    genreContextEvidence: { matchedPriors: ["Disco 계열"], confidence: 0.8 },
    trackCharacter: {}, mood: { fused: {} }, novelty: {} });
  assert.equal(serialized.instrumentation.observed[0].label, "피아노");
  assert.equal(serialized.performance.pitchActivity, null);
  assert.equal(JSON.stringify(serialized).includes("audioBuffer"), false);
});

test("main rendering has no orb, waveform, or foreground particle call and kick increases field deformation", () => {
  const main = fs.readFileSync(path.join(__dirname, "../js/main.js"), "utf8");
  const drawBody = main.match(/function draw\(\) \{([\s\S]*?)\n\}/)[1];
  for (const name of ["drawOrb(", "drawWaveform(", "createBeatParticles("]) assert.equal(drawBody.includes(name), false);
  const shader = fs.readFileSync(path.join(__dirname, "../js/visual/background.js"), "utf8");
  assert.equal(shader.includes("beatRipple"), false);
  assert.equal(shader.includes("viscousImpact"), true);
  assert(Mapping.target({ bass: 0.5, beat: 1 }).deformation > Mapping.target({ bass: 0.5, beat: 0 }).deformation);
  const mapper = new Mapping.Mapper(), attacked = mapper.update({ beat: 1 }, 16).impact;
  assert(attacked > 0.35);
  assert(mapper.update({ beat: 0 }, 16).impact > attacked * 0.85);
});
