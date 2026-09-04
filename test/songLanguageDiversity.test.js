const test = require("node:test");
const assert = require("node:assert/strict");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Impressions = require("../js/semantic/impressionSynthesizer");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Manager = require("../js/semantic/semanticFacetManager");
const Critic = require("../js/semantic/languageCritic");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Quality = require("../js/semantic/phraseQuality");
const Selection = require("../js/visual/phraseSelection");
const Evidence = require("../js/semantic/evidenceReservoir");
const SongProfile = require("../js/semantic/songLanguageProfile");
const Metrics = require("../js/semantic/languageDiversityMetrics");
const Grammar = require("../js/semantic/rhythmicGrammar");
const { createLanguageRequest } = require("../lib/languageService");
const { profile, RICH_KINDS } = require("./fixtures/languageProfiles");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => ((value = (value * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function selectedStream(kind, seed = 1, count = 24) {
  const state = profile(kind);
  state.expressionFeatures.observationSeconds = 35;
  const generated = Manager.base(state);
  const context = { snapshot: Snapshot.serialize(state), eligibleTexts: generated.map(item => item.text) };
  const grounded = Critic.rank(generated, { context, limit: 120 }).selected;
  const evidence = new Evidence.Reservoir();
  const song = new SongProfile.Profile();
  evidence.clear(seed); song.reset(seed);
  evidence.observe(grounded, { sessionId: seed, epoch: 1, at: 1000, observationSeconds: 35 });
  song.observe(state, evidence.snapshot({ at: 1000 }), { sessionId: seed, at: 1000 });
  const recent = [], random = seeded(seed);
  for (let index = 0; index < count; index++) {
    const now = 1000 + index * 2000;
    const candidates = song.annotate(evidence.snapshot({ at: now }), now);
    const item = Selection.choose(candidates, recent.slice(-12), random,
      { observationSeconds: 35, explorationRate: .3, now });
    if (!item) break;
    recent.push(item); evidence.noteDisplayed(item, now); song.noteUsed(item, now);
  }
  return recent;
}

test("all produced primitive fields have a language consumer; only declared capabilities remain orphaned", () => {
  const samples = [...RICH_KINDS, "cold", "warm", "jazz"].map(kind => Primitives.analyze(profile(kind)));
  const classification = Validator.classifyPrimitives(Primitives.schema(), samples);
  const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
  const report = Validator.validate({ lexicon, primitiveSchema: Primitives.schema(), graph: engine.graph,
    detectorRules: Pipeline.productionRules, detectorCapabilities: Grammar.detectorCapabilities,
    primitiveClassification: classification, impressionRules: Impressions.RULES,
    directConsumerPaths: Pipeline.primitiveConsumerPaths });
  assert.equal(report.warningsByCode["unused-primitive"] || 0, 0);
  const coverage = Validator.coverageReport(engine.graph, lexicon, { impressionRules: Impressions.RULES,
    directConsumerPaths: Pipeline.primitiveConsumerPaths });
  assert.ok(coverage.orphanPrimitives.every(path => classification[path] === "DECLARED_ONLY"));
});

test("unused measured primitives now emit specific evidence-traced musical observations", () => {
  const jungle = profile("jungle").primitiveObservationCandidates;
  for (const text of ["초고속 템포", "늘어진 스윙 비율", "밀려난 악센트", "레이어 밀도 상승", "빠르게 변하는 스펙트럼"])
    assert.ok(jungle.some(item => item.text === text && item.anchors.every(path => path.startsWith("primitives."))), text);
  const ambient = profile("ambient").primitiveObservationCandidates;
  for (const text of ["성긴 반주층", "레가토 연결", "배음 중심 음색"])
    assert.ok(ambient.some(item => item.text === text), text);
});

test("song evidence reservoir records stability, salience, temporal reliability and display history", () => {
  const evidence = new Evidence.Reservoir({ capacity: 40 });
  const candidate = { text: "2-Step", category: "rhythm", layer: "FACT", confidence: .84,
    anchors: ["rhythmicGrammar.twoStep"], source: "rhythm" };
  evidence.observe([candidate], { sessionId: 7, epoch: 2, at: 1000, observationSeconds: 30 });
  evidence.observe([candidate], { sessionId: 7, epoch: 2, at: 2000, observationSeconds: 30 });
  evidence.noteDisplayed(candidate, 2100);
  const item = evidence.snapshot({ at: 2200 })[0];
  assert.equal(item.conceptKey, Quality.conceptKey(candidate));
  for (const field of ["confidence", "stability", "salience", "novelty", "temporalRelevance", "epistemicReliability", "reservoirScore"])
    assert.ok(Number.isFinite(item[field]), field);
  assert.equal(item.displayCount, 1);
  assert.equal(item.lastDisplayed, 2100);
});

test("song profile exhausts a repeated concept and clears it on a new song session", () => {
  const song = new SongProfile.Profile();
  const candidate = { text: "사이드체인 펌핑", category: "production", layer: "FACT", confidence: .85, source: "production" };
  song.observe(profile("futurefunk"), [candidate], { sessionId: 11, at: 1000 });
  for (let index = 0; index < 3; index++) song.noteUsed(candidate, 1200 + index * 100);
  assert.equal(song.annotate([candidate], 1600)[0].exhausted, true);
  assert.ok(song.snapshot([candidate], 1600).exhaustedConcepts.includes(Quality.conceptKey(candidate)));
  song.observe(profile("ukgarage"), [candidate], { sessionId: 12, at: 2000 });
  assert.equal(song.annotate([candidate], 2100)[0].songUsageCount, 0);
  assert.deepEqual(song.snapshot([candidate], 2100).recentConcepts, []);
});

test("selection prioritizes specific concepts, explores unused evidence and rotates batch facets", () => {
  const generic = { text: "dreamy", category: "mood", layer: "IMPRESSION", confidence: .8, weight: .8 };
  const specific = { text: "워킹 베이스", category: "performance", layer: "FACT", confidence: .8, weight: .8,
    source: "idiom", anchors: ["performance.walkingBassLikelihood"] };
  assert.ok(Selection.weight(specific, [], { observationSeconds: 35 }) >
    Selection.weight(generic, [], { observationSeconds: 35 }) * 4);
  const candidates = [
    { ...specific, songUsageCount: 5, unexplored: false, facetNeed: .4 },
    { text: "스윙 필", category: "rhythm", layer: "FACT", confidence: .72, weight: .72,
      source: "rhythm", songUsageCount: 0, unexplored: true, facetNeed: 1 },
    { text: "넓은 스테레오", category: "production", layer: "FACT", confidence: .7, weight: .7,
      source: "production", songUsageCount: 0, unexplored: true, facetNeed: 1 }
  ];
  const explored = Selection.choose(candidates, [], () => 0, { observationSeconds: 35, explorationRate: 1 });
  assert.equal(explored.songUsageCount, 0);
  const rotated = Selection.choose(candidates, [], () => 0, { observationSeconds: 35,
    avoidFacets: [Quality.musicalFacet(explored)] });
  assert.notEqual(Quality.musicalFacet(rotated), Quality.musicalFacet(explored));
  assert.ok(Selection.treatment({ ...specific, layer: "LIVE" }).speed >
    Selection.treatment({ ...specific, layer: "CONTEXT" }).speed,
  "momentary LIVE language crosses the viewport faster than stable identity context");
});

test("final selected language streams stay diverse, grounded and separated by song", () => {
  const kinds = ["futurefunk", "citypop", "ukgarage", "jungle", "techno", "jazztrio", "shoegaze", "ambient"];
  const streams = kinds.map((kind, index) => ({ kind, items: selectedStream(kind, index + 1) }));
  for (const stream of streams) {
    const metrics = Metrics.evaluate(stream.items);
    assert.ok(metrics.intraSongUniqueConceptRatio >= .5, `${stream.kind} unique ${metrics.intraSongUniqueConceptRatio}`);
    assert.ok(metrics.facetCoverage.count >= 6, `${stream.kind} facets ${metrics.facetCoverage.count}`);
    assert.ok(metrics.specificityRatio >= .55, `${stream.kind} specificity ${metrics.specificityRatio}`);
    assert.equal(metrics.groundingRate, 1, `${stream.kind} grounding`);
    assert.ok(metrics.repetitionRate <= .4, `${stream.kind} repetition ${metrics.repetitionRate}`);
  }
  const overlaps = [];
  for (let left = 0; left < streams.length; left++) for (let right = left + 1; right < streams.length; right++)
    overlaps.push(Metrics.jaccard(streams[left].items, streams[right].items));
  assert.ok(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length < .15);
  assert.ok(Math.max(...overlaps) < .35);
});

test("LLM request includes song memory and requires the concept-aware output schema", () => {
  const state = profile("futurefunk");
  const request = createLanguageRequest({ snapshot: Snapshot.serialize(state),
    songLanguageProfile: { alreadyUsedConcepts: ["sample_loop|NONE|FACT"],
      exhaustedConcepts: ["sidechain|NONE|FACT"], unexploredConcepts: ["octave_bass|NONE|FACT"],
      underrepresentedFacets: ["HARMONY", "ARRANGEMENT"] } });
  const payload = JSON.parse(request.input[1].content);
  assert.deepEqual(payload.songLanguageProfile.underrepresentedFacets, ["HARMONY", "ARRANGEMENT"]);
  const itemSchema = request.text.format.schema.properties.rhythm.items;
  for (const field of ["conceptKey", "musicalFacet", "epistemicLayer", "evidenceRefs"])
    assert.ok(itemSchema.required.includes(field), field);
});

test("the real-MP3 smoke path still yields non-identical final concept pools without an AI provider", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const Expressions = require("../js/semantic/musicExpressionEngine");
  const Pool = require("../js/semantic/phrasePoolEngine");
  const { default: decode } = await import("audio-decode");
  const streams = [];
  for (const name of ["outfoxing", "horns", "drums"]) {
    const decoded = await decode(fs.readFileSync(path.join(__dirname, "fixtures/audio", name + ".mp3")));
    const samples = decoded.channelData[0], history = new Expressions.FeatureHistory(), engine = new Pool.Engine();
    const emitted = [];
    let observations = 0;
    for (let offset = 0; offset + 4096 < samples.length; offset += Math.floor(decoded.sampleRate / 2)) {
      const measured = Expressions.measure(samples.subarray(offset, offset + 4096));
      const features = history.update({ ...measured, energy: Math.min(1, measured.rms * 2) }, observations++ * 500);
      await engine.regenerate({ state: { expressionFeatures: features }, sessionId: streams.length + 1, epoch: 1 });
      emitted.push(...engine.snapshot());
    }
    streams.push(emitted);
  }
  assert.ok(streams.every(items => items.length > 0));
  assert.ok(Metrics.jaccard(streams[0], streams[1]) < 1 || Metrics.jaccard(streams[0], streams[2]) < 1,
    "at least one real recording must produce a different final concept set in the lightweight smoke path");
});
