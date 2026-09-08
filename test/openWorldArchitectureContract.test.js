const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Idioms = require("../js/semantic/musicalIdiomEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const lexicon = require("../data/musicalLexicon.json");
const FlamingoWordReservoir = require("../js/semantic/flamingoWordReservoir");
const DirectAudioRealizer = require("../js/semantic/directAudioRealizer");
const { reviewCaption, toObservations, calibrateStructuredPacket } = require("../lib/directAudioReview");
const OpenWorld = require("../js/semantic/openWorldConceptRegistry");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const GenreEvidenceHistory = require("../js/semantic/genreEvidenceHistory");
const DeepListen = require("../js/semantic/deepListenWindowScheduler");
const ConfidenceCalibration = require("../js/ml/confidenceCalibrator");
const ProgressiveListening = require("../js/semantic/progressiveListeningEngine");
const GenreAdvisory = require("../js/semantic/genreAdvisory");
const hierarchy = require("../data/genreHierarchy.json");

const flamingoSource = fs.readFileSync(path.resolve(__dirname, "../scripts/flamingo_server.py"), "utf8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../js/main.js"), "utf8");
const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
const engineSource = fs.readFileSync(path.resolve(__dirname, "../js/semantic/semanticEngine.js"), "utf8");
const composeEndpoint = serverSource.split('app.post("/api/compose-genre"')[1].split("app.post(")[0];

function idiomTexts(primitives, genre) {
  return new Idioms.Engine(lexicon).evaluate(primitives, genre).map(item => item.text).sort();
}

function walkingBass() {
  const value = Primitives.empty();
  Object.assign(value.pulse, {
    pulsePresence: 0.86, pulseRegularity: 0.84, subdivisionRatio: 1, accentPeriodicity: 4,
    accentPlacement: 0.08, metricStability: 0.8, tempoClass: "moderate", densityPerPulse: 2
  });
  Object.assign(value.texture, { voiceCount: 4, dominanceDispersion: 0.75, textureClass: "polyphonic", sustainRatio: 0.45 });
  Object.assign(value.role, { leadPresence: 0.42, leadTransitionRate: 0.28, accompanimentDensity: 0.55, bassFunction: "walking", foundationLayer: 0.76 });
  Object.assign(value.tonal, { tonalFocus: 0.78, pitchSetBreadth: 5, drone: 0.2 });
  Object.assign(value.articulation, { attackSharpness: 0.78, noteLengthRatio: 0.35, dynamicAccentRange: 0.7 });
  Object.assign(value.form, { repetitionDepth: 0.76, sectionNovelty: 0.3, buildupSlope: 0.2, releaseDepth: 0.2 });
  Object.assign(value.production, { spectralTilt: 0.25, saturationAmount: 0.7, compressionBehavior: 0.5, spatialDepth: 0.5, periodicDucking: 0.2 });
  return value;
}

test("Test 1 — same local primitives produce identical FACT under different genre labels", () => {
  const primitives = walkingBass();
  assert.deepEqual(
    idiomTexts(primitives, { primary: "Jazz", family: "Jazz", confidence: 0.92 }),
    idiomTexts(primitives, { primary: "House", family: "Electronic", confidence: 0.92 })
  );
});

test("Test 2 — blind Flamingo requests carry no local/fused/previous genre or aesthetic", () => {
  const upload = mainSource.slice(
    mainSource.indexOf("const deepAnalysisHeaders"),
    mainSource.indexOf("fetch(\"/api/deep-analysis\"")
  );
  assert.match(upload, /Content-Type": "audio\/wav"/);
  assert.doesNotMatch(upload, /X-Music-Shower-Genre-Advisory/);
  assert.doesNotMatch(upload, /classifierGenre|fusedGenre|previousGenre|previousAesthetic|previousImpression/);
  assert.doesNotMatch(flamingoSource, /LOCAL CLASSIFIER ADVISORY/);
  assert.doesNotMatch(flamingoSource, /developer taxonomy|genre whitelist/i);
  assert.match(flamingoSource, /independent_listen = True/);
  assert.match(flamingoSource, /"listeningMode": "independent"/);
  assert.match(flamingoSource, /"genreAdvisoryUsed": False/);
  for (const capture of [1, 2, 3, 8]) assert.equal(GenreAdvisory.shouldAssist(capture), false);
});

test("Test 3 — assisted Flamingo output does not increment independent evidence", () => {
  const history = new GenreEvidenceHistory.History();
  history.recordFlamingo({
    hypotheses: [{ label: "House", confidence: 0.8 }],
    listeningMode: "assisted",
    independent: false,
    observationId: "assisted-1"
  });
  assert.equal(history.independentFlamingoCount("House"), 0);
  assert.equal(history.snapshot().independentFlamingoHearings, 0);
  assert.equal(history.snapshot().assistedFlamingoHearings, 1);

  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    audibleObservations: [{ text: "four on the floor kick", category: "rhythm", confidence: 0.8 }],
    genreHypotheses: [{ label: "House", confidence: 0.8 }]
  }, { trackEpoch: 1, observationId: "assisted-1", listeningMode: "assisted", independent: false });
  const inspect = reservoir.inspect();
  assert.equal(inspect.independentlySupportedConceptCount, 0);
  const fact = [...reservoir.conceptRegistry.values()].find(item => item.layer === "FACT");
  assert.equal(fact.independentObservationIds.size, 0);
  assert.equal(reservoir.getCandidates().some(item => item.layer === "FACT"), false);
});

test("Test 4 — local A plus assisted Flamingo A is not two-independent-system agreement", () => {
  assert.match(composeEndpoint, /Never assume two readings are independent systems/);
  assert.match(composeEndpoint, /never treat a fixed-label classifier as well calibrated/);
  assert.match(composeEndpoint, /must not be counted as a second independent vote/);
  assert.doesNotMatch(composeEndpoint, /is well calibrated|are well calibrated/);
  assert.doesNotMatch(composeEndpoint, /two independent systems/);

  const result = new GenreHypotheses.Engine({}, hierarchy).evaluate({
    classifierGenre: {
      primary: "House", uncertain: false, confidence: 0.7, semanticConfidence: 0.7,
      topK: [{ label: "House", confidence: 0.7 }]
    },
    openWorldConcepts: [{
      canonicalLabel: "House", conceptType: "genre", confidence: 0.72,
      sources: ["directAudio"], conditionedOnClassifier: true, hasIndependentDeepListen: false,
      temporalSupport: 1, status: "provisional"
    }]
  }, 0);
  const flamingo = result.hypotheses.find(item => item.openWorld && item.genre === "House");
  assert.ok(flamingo);
  assert.equal(flamingo.independentEvidenceCount, 1);
  assert.deepEqual(flamingo.independentEvidenceFamilies, ["assistedFusion"]);
  assert.equal(flamingo.kind, "open-world");
});

test("Test 5 — an unregistered synthetic genre is stored when model provenance is valid", () => {
  const label = "Xyphotic Pulsecore 9k";
  const registry = new OpenWorld.Registry();
  const concept = registry.propose({
    label, conceptType: "genre", source: "directAudio", sourceFamily: "directAudio",
    sourceModel: "music-flamingo", confidence: 0.66, observationId: "ow-1"
  });
  assert.ok(concept);
  assert.equal(concept.canonicalLabel, label);
  assert.equal(concept.openWorld, true);

  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({ genreHypotheses: [{ label, confidence: 0.66 }] }, {
    trackEpoch: 1, observationId: "ow-1", listeningMode: "independent"
  });
  assert.ok([...reservoir.conceptRegistry.values()].some(item => item.canonicalText === label));
});

test("Test 6 — malformed Flamingo packets do not invent developer AESTHETIC or IMPRESSION", () => {
  assert.deepEqual(toObservations(reviewCaption({
    caption: "vaporwave city pop anime Y2K nostalgic dreamy bubble economy"
  })), []);
  assert.deepEqual(toObservations(reviewCaption({
    structuredPacket: { genreHypotheses: [{ label: "Lush pads provide harmonic support", confidence: 0.9 }] }
  })), []);
  assert.deepEqual(toObservations(reviewCaption({
    structuredPacket: { aestheticConcepts: "not-an-array", impressions: null }
  })), []);
  assert.deepEqual(DirectAudioRealizer.realize("melancholic propulsion", "impression"), ["melancholic propulsion"]);
  assert.deepEqual(DirectAudioRealizer.realize("nocturnal atmosphere", "aesthetic"), ["nocturnal atmosphere"]);
});

test("Test 7 — one canonical concept with six Korean surfaces is still one semantic concept", () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    aestheticConcepts: [{ text: "digital nostalgia", confidence: 0.7 }]
  }, { trackEpoch: 1, observationId: "c1", listeningMode: "independent" });
  reservoir.applyRealization("digital nostalgia", [
    "디지털 향수", "전자적 향수", "온라인 시대의 그리움",
    "디지털 노스탤지어", "전자 향수", "네트워크의 그리움"
  ], "association");
  const inspect = reservoir.inspect();
  assert.equal(inspect.canonicalConceptCount, 1);
  assert.equal(inspect.surfacePhraseCount, 6);
  assert.ok(inspect.semanticClusterCount <= inspect.canonicalConceptCount);
});

test("Test 8 — a new track epoch clears genre, aesthetic, signatures and pending windows", () => {
  const history = new GenreEvidenceHistory.History();
  const scheduler = new DeepListen.Scheduler({ trackEpoch: 1 });
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  history.recordLocalPatch({ topK: [{ label: "House", score: 0.2 }], rawTopScore: 0.2, margin: 0.05, entropy: 0.4 });
  history.recordFlamingo({
    hypotheses: [{ label: "House" }],
    signatureRelations: [{ id: "s1", text: "kick locks to bass" }],
    listeningMode: "independent"
  });
  scheduler.beginUpload();
  scheduler.enqueuePending({ trackEpoch: 1, requestGeneration: scheduler.requestGeneration });
  reservoir.ingestPacket({
    aestheticConcepts: [{ text: "porous night", confidence: 0.6 }],
    impressions: [{ text: "restless warmth", confidence: 0.55 }]
  }, { trackEpoch: 1, observationId: "old" });

  history.reset();
  scheduler.reset(2);
  reservoir.reset(2);

  const snapshot = history.snapshot();
  assert.equal(snapshot.localGenreHistory.length, 0);
  assert.equal(snapshot.blindFlamingoGenreHistory.length, 0);
  assert.equal(snapshot.signatureRelationHistory.length, 0);
  assert.equal(scheduler.inspect().pendingCount, 0);
  assert.equal(scheduler.inspect().trackEpoch, 2);
  assert.equal(reservoir.inspect().canonicalConceptCount, 0);
  assert.match(engineSource, /flamingoWordReservoir\?\.reset/);
  assert.match(engineSource, /genreEvidenceHistory\?\.reset/);
  assert.match(mainSource, /deepListenScheduler\?\.reset/);
});

test("Test 9 — a slow Flamingo inference still preserves one pending audio window", () => {
  const scheduler = new DeepListen.Scheduler({ trackEpoch: 1, maxPending: 1 });
  scheduler.markTriggered(12000);
  scheduler.beginUpload();
  assert.equal(scheduler.enqueuePending({
    trackEpoch: 1, requestGeneration: scheduler.requestGeneration, pcm: [1, 2, 3]
  }), true);
  assert.equal(scheduler.inspect().pendingCount, 1);
  assert.equal(scheduler.inspect().uploadInFlight, true);
  scheduler.enqueuePending({ trackEpoch: 1, requestGeneration: scheduler.requestGeneration, pcm: [9] });
  assert.equal(scheduler.inspect().pendingCount, 1, "the pending queue stays bounded");
  scheduler.endUpload();
  const pending = scheduler.takePending();
  assert.ok(pending);
  assert.deepEqual(pending.pcm, [9]);
  assert.match(mainSource, /enqueuePending/);
  assert.match(mainSource, /takePending\(\)/);
});

test("Test 10 — raw score, entropy, margin and patch agreement remain beside semantic confidence", () => {
  const calibrated = ConfidenceCalibration.calibrate({
    predictions: [
      { label: "House", confidence: 0.09 },
      { label: "Techno", confidence: 0.04 },
      { label: "Jazz", confidence: 0.02 }
    ],
    familyFor: () => "Electronic"
  });
  assert.equal(calibrated.rawTopScore, 0.09);
  assert.ok(calibrated.semanticConfidence > calibrated.rawTopScore);
  assert.ok(Number.isFinite(calibrated.entropy));
  assert.ok(Number.isFinite(calibrated.margin));
  assert.ok(Number.isFinite(calibrated.normalizedMargin));
  assert.equal(calibrated.reliability, calibrated.semanticConfidence);

  const history = new GenreEvidenceHistory.History();
  history.recordLocalPatch({
    topK: [{ label: "House", score: 0.09 }, { label: "Techno", score: 0.04 }],
    rawTopScore: 0.09, runnerUpScore: 0.04, margin: 0.05, entropy: 0.61, sectionId: 0
  });
  history.recordLocalPatch({
    topK: [{ label: "Disco", score: 0.08 }, { label: "House", score: 0.07 }],
    rawTopScore: 0.08, runnerUpScore: 0.07, margin: 0.01, entropy: 0.8, sectionId: 1
  });
  const snapshot = history.snapshot();
  assert.equal(snapshot.independentPatchCount, 2);
  assert.equal(snapshot.conflictingSectionCount, 1);
  assert.equal(snapshot.localGenreHistory[0].rawTopScore, 0.09);
  assert.match(engineSource, /rawTopScore: calibrated\.rawTopScore/);
  assert.match(engineSource, /independentPatchCount: history\.independentPatchCount/);
});

test("first-impression genre stays provisional and cannot outrun the 0.48 cap", () => {
  const packet = calibrateStructuredPacket({
    genreHypotheses: [{ label: "Open Genre", confidence: 0.99 }]
  }, { listeningMode: "independent", listenDepth: "first-impression" });
  assert.equal(packet.genreHypotheses[0].confidence, 0.48);
  assert.equal(packet.genreHypotheses[0].provisional, true);
  assert.match(flamingoSource, /item\["provisional"\] = True/);
});

test("local mood or genre confidence cannot open AESTHETIC or IMPRESSION", () => {
  const engine = new ProgressiveListening.Engine();
  const readiness = engine.update({
    state: {
      audio: { bpm: 128, beatConfidence: 0.9 },
      genre: { confidence: 0.95, uncertain: false, entropy: 0.1, margin: 0.5 },
      mood: { fused: { arousal: 0.9, valence: 0.8, warmth: 0.7 } }
    },
    observationSeconds: 40
  });
  assert.equal(readiness.aesthetic, 0);
  assert.equal(readiness.impression, 0);
});
