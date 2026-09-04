const semanticSessionGuard = new SessionGuard();
let semanticSessionId = semanticSessionGuard.currentId;
let semanticState = null;
let semanticScheduler = null;
let musicModelBridge = null;
let genreTracker = null;
let noveltyDetector = null;
let temporalModelAggregator = null;
let genreFamilyLookup = new Map();
let genreAliasLookup = new Map();
let genreTaxonomyData = {};
let genreContextKnowledgeData = {};
let zeroShotClassifier = new ZeroShotGenre.Classifier();
let semanticRuntimeInitialized = false;
let semanticInferencePending = false;
let lastAppliedAnalysisWindowId = 0;
let lastZeroShotAt = 0;
let semanticPerformanceGovernor = null;
let semanticPerformanceLevel = null;
let trackCharacterEngine = null;
let semanticChangeDetector = null;
let remoteLanguageProvider = null;
let distinctiveTracker = null;
let phrasePoolEngine = null;
let latestRollingEmbedding = [];
let subgenreSearcher = new SubgenreSearch.Searcher();
let semanticEvidenceReady = false;
const expressionHistory = new MusicExpressionEngine.FeatureHistory();
let expressionWaveform = null;
let expressionSpectrum = null;
const instrumentationEventEngine = new InstrumentationEvents.Engine();
let genreContextEngine = new GenreContext.Engine();
let temporalEvidenceEngine = new TemporalEvidence.Engine();
const evidenceFusionEngine = new EvidenceFusion.Engine();
const arrangementEngine = new ArrangementEngine.Engine();
let aestheticAxisEngine = new AestheticAxisEngine.Engine();
let aestheticEvidenceEngine = new AestheticEvidence.Engine();
const mirEngine = new MIREngine.Engine();
const conceptEmbeddingEngine = new ConceptEmbeddingEngine.Engine();
let musicalIdiomEngine = new MusicalIdioms.Engine();
let currentModelInstruments = [];
let currentModelInstrumentsAt = 0;
const discogsParentFamily = {
  "blues": "Jazz / Soul",
  "brass & military": "Acoustic / Traditional",
  "children's": "Acoustic / Traditional",
  "classical": "Acoustic / Traditional",
  "electronic": "Electronic / Club",
  "folk, world, & country": "Acoustic / Traditional",
  "funk / soul": "Jazz / Soul",
  "hip hop": "Hip-Hop / Rap",
  "jazz": "Jazz / Soul",
  "latin": "Latin / Brazilian",
  "pop": "Pop / Internet",
  "reggae": "Acoustic / Traditional",
  "rock": "Rock / Metal",
  "stage & screen": "Ambient / Cinematic"
};

function createInitialSemanticState(sessionId = 0) {
  const localMood = { valence: 0.5, arousal: 0, tension: 0, warmth: 0.5, brightness: 0.5, spaciousness: 0.5 };
  const genre = {
    family: "Unknown",
    primary: "미확정 장르",
    secondary: [],
    topK: [],
    confidence: 0,
    rawConfidence: 0,
    entropy: 1,
    stability: 0,
    temporalAgreement: 0,
    certainty: "unknown",
    hybrid: false,
    related: [],
    displayLabel: "미확정 장르",
    uncertain: true
  };
  return {
    sessionId,
    status: "idle",
    genre,
    instruments: [],
    ...SemanticEvidence.sanitize({}),
    instrumentFacetCandidates: [], rhythmFacetCandidates: [], productionFacetCandidates: [],
    primitiveObservationCandidates: [],
    arrangementFacetCandidates: [], detectedIdioms: [], impressionConcepts: [], impressionFacetCandidates: [],
    knowledgeConsistency: null,
    primitives: MusicalPrimitives.empty(),
    mood: { local: localMood, ml: {}, fused: localMood },
    novelty: { score: 0, transitionDetected: false },
    audio: {
      bpm: 0,
      beatConfidence: 0,
      energy: 0,
      rms: 0,
      flux: 0,
      centroid: 0,
      bass: 0,
      mid: 0,
      high: 0,
      onsetRate: 0,
      tonalFocus: 0,
      flatness: 0,
      chroma: [],
      mfcc: []
    },
    ml: { ready: false, backend: "none", status: "idle", inferenceLatency: 0, inferenceActive: false, timings: {}, lastUpdated: 0, error: null },
    zeroShot: { available: false, active: false, candidates: [] },
    conceptEmbedding: { available: false, reason: "concept-text-embeddings-not-bundled", candidates: [] },
    mir: null, temporalEvidence: null, evidenceFusion: [], stateV2: null,
    trackCharacter: TrackCharacter.rawProfile(),
    distinctive: { basis: "absolute character only", genreRelativeAvailable: false, statements: [] },
    semanticEpoch: 0,
    semanticChange: { score: 0, changed: false, epoch: 0, components: {} },
    language: { status: "fallback", model: null, generationLatency: 0, phraseCount: 0 },
    words: [],
    visual: SemanticFusion.visualFromState(localMood, {}, genre),
    updatedAt: 0
  };
}

async function loadSemanticData() {
  const [taxonomyResponse, aliasResponse, embeddingResponse, neighborhoodResponse, contextResponse, lexiconResponse,
    coreTermsResponse, aestheticAxesResponse, aestheticRegionsResponse] = await Promise.all([
    fetch("./data/genreTaxonomy.json"),
    fetch("./data/genreAliases.json"),
    fetch("./data/genreEmbeddings.json"),
    fetch("./data/genreNeighborhoods.json"),
    fetch("./data/genreContextKnowledge.json"),
    fetch("./data/musicalLexicon.json"),
    fetch("./data/approvedCoreTerms.json"),
    fetch("./data/aestheticAxes.json"),
    fetch("./data/aestheticRegions.json")
  ]);
  if (coreTermsResponse.ok) SemanticFacets.setApprovedCoreTerms((await coreTermsResponse.json())?.entries);
  if (aestheticAxesResponse.ok && aestheticRegionsResponse.ok) {
    aestheticAxisEngine = new AestheticAxisEngine.Engine(await aestheticAxesResponse.json(), await aestheticRegionsResponse.json());
    aestheticEvidenceEngine = new AestheticEvidence.Engine(aestheticAxisEngine);
  }
  if (taxonomyResponse.ok) {
    const taxonomy = await taxonomyResponse.json();
    genreTaxonomyData = taxonomy;
    genreFamilyLookup = new Map();
    for (const [family, labels] of Object.entries(taxonomy)) {
      for (const label of labels) genreFamilyLookup.set(label.toLowerCase(), family);
    }
  }
  if (aliasResponse.ok) {
    genreAliasLookup = new Map(Object.entries(await aliasResponse.json()).map(([key, value]) => [key.toLowerCase(), value]));
  }
  if (embeddingResponse.ok) {
    const database = await embeddingResponse.json();
    zeroShotClassifier = new ZeroShotGenre.Classifier(database);
  }
  if (contextResponse.ok) {
    genreContextKnowledgeData = await contextResponse.json();
    genreContextEngine = new GenreContext.Engine(genreContextKnowledgeData, aestheticAxisEngine);
  }
  if (neighborhoodResponse.ok) subgenreSearcher = new SubgenreSearch.Searcher(await neighborhoodResponse.json());
  if (lexiconResponse.ok) musicalIdiomEngine.setLexicon(await lexiconResponse.json());
  musicalIdiomEngine.setContext({ primitiveSchema: MusicalPrimitives.schema(), genreTaxonomy: genreTaxonomyData });
  semanticState.knowledgeConsistency = KnowledgeConsistency.validate({
    lexicon: musicalIdiomEngine.lexicon,
    primitiveSchema: MusicalPrimitives.schema(),
    detectorRules: SemanticCandidatePipeline.productionRules,
    detectorCapabilities: RhythmicGrammar.detectorCapabilities,
    contextKnowledge: genreContextKnowledgeData,
    graph: musicalIdiomEngine.graph,
    directConsumerPaths: SemanticCandidatePipeline.primitiveConsumerPaths
  });
}

function canonicalGenre(label) {
  const clean = String(label || "").trim();
  const [parent, specific] = clean.includes("---") ? clean.split("---", 2) : ["", clean];
  const canonical = genreAliasLookup.get(specific.toLowerCase()) || specific;
  if (parent && !genreFamilyLookup.has(canonical.toLowerCase())) {
    genreFamilyLookup.set(canonical.toLowerCase(), discogsParentFamily[parent.toLowerCase()] || "Unknown");
  }
  return canonical;
}

function genreFamily(label) {
  return genreFamilyLookup.get(canonicalGenre(label).toLowerCase()) || "Unknown";
}

async function initializeSemanticRuntime() {
  if (semanticRuntimeInitialized) return;
  semanticRuntimeInitialized = true;
  RuntimePerformance.start();
  semanticState = createInitialSemanticState(semanticSessionId);
  genreTracker = new GenreTracking.GenreTracker(CONFIG.ml.genre);
  noveltyDetector = new NoveltyDetector.Detector();
  temporalModelAggregator = new TemporalModelAggregation.Aggregator(CONFIG.ml.windows);
  trackCharacterEngine = new TrackCharacter.Engine();
  semanticChangeDetector = new SemanticChange.Detector();
  distinctiveTracker = new SemanticSnapshot.DistinctivenessTracker();
  remoteLanguageProvider = new PhraseProviders.RemoteGenerativeProvider(CONFIG.language.remote);
  phrasePoolEngine = new PhrasePool.Engine({
    provider: remoteLanguageProvider,
    fallbackProvider: new PhraseProviders.StructuredFallbackProvider(),
    ranker: new PhraseProviders.WorkerCritic(),
    poolSize: CONFIG.language.poolSize,
    minimumIntervalMs: CONFIG.language.minimumIntervalMs,
    stableDelayMs: CONFIG.language.stableDelayMs,
    lowWatermark: CONFIG.language.regenerationFloor,
    cacheSize: CONFIG.language.cacheSize
  });
  semanticScheduler = new MultiRateScheduler();
  const initialPerformanceLevel = CONFIG.ml.quality === "performance" ? "low"
    : CONFIG.ml.quality === "balanced" ? "medium" : "high";
  semanticPerformanceGovernor = new BackgroundPerformance.Governor(initialPerformanceLevel);
  semanticPerformanceLevel = initialPerformanceLevel;
  semanticScheduler.add("mood", CONFIG.semantic.localMoodInterval, refreshLocalSemanticState);
  semanticScheduler.add("instruments", CONFIG.semantic.instrumentInterval, refreshLocalInstruments);
  semanticScheduler.add("semantic", CONFIG.semantic.stateInterval, refreshSlowSemanticState);
  semanticScheduler.add("expressions", 500, refreshRealtimeExpressions);
  semanticScheduler.add("model", CONFIG.ml.inferenceInterval, requestMusicModelInference);
  // The expression job refreshes words; do not duplicate the same work each tick.

  await Promise.allSettled([
    loadSemanticData(),
    conceptEmbeddingEngine.initialize("./data/musicConceptBank.json")
  ]);

  if (CONFIG.ml.enabled) {
    musicModelBridge = new MusicModelBridge({
      manifestUrl: CONFIG.ml.manifestUrl,
      workerUrl: CONFIG.ml.workerUrl,
      backendPreference: CONFIG.ml.backendPreference
    });
    await musicModelBridge.initialize();
    if (mlAudioWindow?.shared) musicModelBridge.attachSharedRing(mlAudioWindow.descriptor());
  }
  syncMLState();
  refreshSemanticWords();
}

function beginSemanticSession(inputMode = "unknown") {
  expressionHistory.reset();
  instrumentationEventEngine.reset();
  currentModelInstruments = []; currentModelInstrumentsAt = 0;
  semanticSessionId = semanticSessionGuard.next();
  RuntimePerformance.reset();
  genreTracker?.reset();
  noveltyDetector?.reset();
  temporalModelAggregator?.reset();
  trackCharacterEngine?.reset();
  distinctiveTracker?.reset();
  semanticChangeDetector?.reset();
  temporalEvidenceEngine?.reset();
  mirEngine.reset();
  musicModelBridge?.resetSession();
  semanticInferencePending = false;
  lastAppliedAnalysisWindowId = 0;
  lastZeroShotAt = 0;
  latestRollingEmbedding = [];
  semanticEvidenceReady = false;
  semanticState = createInitialSemanticState(semanticSessionId);
  phrasePoolEngine?.reset(semanticSessionId);
  semanticState.status = "collecting";
  semanticState.inputMode = inputMode;
  semanticScheduler?.reset();
  if (typeof resetFloatingSemanticVisuals === "function") resetFloatingSemanticVisuals();
  syncMLState();
  refreshSemanticWords();
  return semanticSessionId;
}

function endSemanticSession() {
  expressionHistory.reset();
  instrumentationEventEngine.reset();
  currentModelInstruments = []; currentModelInstrumentsAt = 0;
  semanticSessionId = semanticSessionGuard.next();
  semanticInferencePending = false;
  lastAppliedAnalysisWindowId = 0;
  lastZeroShotAt = 0;
  genreTracker?.reset();
  noveltyDetector?.reset();
  temporalModelAggregator?.reset();
  trackCharacterEngine?.reset();
  distinctiveTracker?.reset();
  semanticChangeDetector?.reset();
  temporalEvidenceEngine?.reset();
  mirEngine.reset();
  musicModelBridge?.resetSession();
  latestRollingEmbedding = [];
  semanticEvidenceReady = false;
  semanticState = createInitialSemanticState(semanticSessionId);
  phrasePoolEngine?.reset(semanticSessionId);
  if (typeof resetFloatingSemanticVisuals === "function") resetFloatingSemanticVisuals();
}

function updateSemanticRuntime(now = performance.now()) {
  if (!semanticRuntimeInitialized || !semanticScheduler || !audioStarted) return;
  updateSemanticPerformanceGovernor();
  semanticScheduler.tick(now);
  syncMLState();
}

function updateSemanticPerformanceGovernor() {
  if (!semanticPerformanceGovernor) return;
  const performanceState = RuntimePerformance.snapshot();
  const profile = semanticPerformanceGovernor.observe({
    fps: typeof frameRate === "function" ? frameRate() : 60,
    inferenceLatency: semanticState?.ml?.inferenceLatency || 0,
    longTaskMs: performanceState.longTaskP90Ms,
    backgroundMs: performanceState.backgroundP90Ms
  });
  if (profile.level === semanticPerformanceLevel) return;
  semanticPerformanceLevel = profile.level;
  semanticScheduler.setInterval("model", CONFIG.ml.inferenceInterval * profile.mlMultiplier);
  semanticScheduler.setInterval("semantic", CONFIG.semantic.stateInterval * Math.min(1.35, profile.mlMultiplier));
}

function syncMLState() {
  if (!semanticState) return;
  const modelState = musicModelBridge?.state || { status: CONFIG.ml.enabled ? "loading" : "disabled", backend: "none" };
  semanticState.ml = {
    ...semanticState.ml,
    ready: modelState.status === "ready",
    backend: modelState.backend || "none",
    status: modelState.status,
    inferenceLatency: modelState.latencyMs || 0,
    inferenceActive: Boolean(musicModelBridge?.inFlight),
    timings: modelState.timings || {},
    error: modelState.error || null,
    performanceLevel: semanticPerformanceLevel || "high",
    bundledModelMB: musicModelBridge?.manifest?.bundledModelBytes
      ? musicModelBridge.manifest.bundledModelBytes / (1024 * 1024) : null
  };
  semanticState.zeroShot.available = zeroShotClassifier.available;
  semanticState.conceptEmbedding = {
    ...conceptEmbeddingEngine.status,
    candidates: semanticState.conceptEmbedding?.candidates || []
  };
  semanticState.language = {
    ...phrasePoolEngine?.state,
    status: phrasePoolEngine?.state?.status || "fallback",
    model: phrasePoolEngine?.state?.model || null,
    generationLatency: phrasePoolEngine?.state?.latencyMs || 0,
    phraseCount: phrasePoolEngine?.state?.phraseCount || 0,
    error: phrasePoolEngine?.state?.error || null,
    semanticEpoch: semanticState.semanticEpoch
  };
}

function refreshLocalSemanticState() {
  if (!semanticState || !audioStarted) return;
  const mood = getLocalMoodProfile(true);
  const rhythm = getRhythmProfile();
  const rms = getFeatureStats(audioAnalysis.rmsList);
  const flatness = getFeatureStats(audioAnalysis.flatnessList);
  const chroma = getChromaProfile();
  const mfcc = getMFCCProfile();
  const bands = realtimeAudioFeatures.bands;
  semanticState.audio = {
    bpm: rhythm.bpm,
    beatConfidence: rhythm.confidence,
    energy: realtimeAudioFeatures.energy,
    rms: latestMeasuredFeatures.rms ?? rms.mean,
    flux: realtimeAudioFeatures.spectralFlux,
    centroid: realtimeAudioFeatures.spectralCentroid,
    bass: bands.subBass + bands.bass,
    mid: bands.lowMid + bands.mid,
    high: bands.highMid + bands.brilliance + bands.air,
    onsetRate: rhythm.onsetRate,
    tonalFocus: chroma.confidence,
    flatness: latestMeasuredFeatures.flatness ?? flatness.mean,
    chroma: chroma.vector,
    mfcc: mfcc.mean
  };
  semanticState.mood.local = { ...mood };
  semanticState.mood.fused = SemanticFusion.fuseMood(mood, semanticState.mood.ml, semanticState.ml.ready);
  semanticState.visual = SemanticFusion.visualFromState(
    semanticState.mood.fused,
    semanticState.audio,
    semanticState.genre
  );
  semanticState.updatedAt = Date.now();
  semanticState.status = audioAnalysis.samples < CONFIG.ai.minimumSamples
    ? "collecting"
    : semanticState.ml.ready ? "interpreting" : "fallback";
}

function refreshLocalInstruments() {
  if (!semanticState || !audioStarted) return;
  const evidence = getInstrumentEvidenceProfile(true);
  const local = evidence.candidates
    .filter(candidate => candidate.score >= 0.42)
    .slice(0, 5)
    .map(candidate => ({ label: candidate.label, confidence: candidate.score, source: "dsp" }));
  const ml = Date.now() - currentModelInstrumentsAt < 7000 ? currentModelInstruments : [];
  const fused = new Map();
  for (const item of [...local, ...ml]) {
    const previous = fused.get(item.label);
    if (!previous || item.confidence > previous.confidence) fused.set(item.label, item);
  }
  semanticState.instruments = [...fused.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}

function refreshRealtimeExpressions() {
  if (!semanticState || !audioStarted || !analyser || !audioAnalysis.realtimeSamples) return;
  const semanticStartedAt = performance.now();
  if (!expressionWaveform || expressionWaveform.length !== analyser.fftSize) expressionWaveform = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(expressionWaveform);
  const measurement = MusicExpressionEngine.measure(expressionWaveform);
  if (!expressionSpectrum || expressionSpectrum.length !== analyser.frequencyBinCount) expressionSpectrum = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(expressionSpectrum);
  const spectrum = MusicExpressionEngine.measureSpectrum(expressionSpectrum, audioContext.sampleRate, analyser.fftSize);
  const rhythm = getRhythmProfile();
  const recentOnsets = beatTimestamps.values().filter(at => performance.now() - at <= 2500).length / 2.5;
  const features = expressionHistory.update({
    ...semanticState.audio, ...latestMeasuredFeatures, ...measurement, ...spectrum,
    energy: SignalMath.clamp(measurement.rms * 2 + SignalMath.clamp(recentOnsets / 4.2) * 0.15),
    tempoStability: rhythm.stability, onsetRate: recentOnsets,
    transientDensity: SignalMath.clamp(recentOnsets / 4.2),
    harmonicMovement: semanticState.trackCharacter?.harmony?.harmonicMotion || 0,
    pumping: semanticState.trackCharacter?.dynamics?.pumping || 0
  });
  semanticState.expressionFeatures = features;
  semanticState.analysisWindow = expressionHistory.summary();
  semanticState.moodDimensions = {
    ...semanticState.mood.fused,
    arousal: SignalMath.clamp(measurement.rms * 3.2 + features.energy * 1.35),
    brightness: SignalMath.clamp(features.centroid / 8000),
    warmth: SignalMath.clamp(0.5 + (features.bass + features.mid - features.high) * 0.45),
    weight: SignalMath.clamp(features.bass / Math.max(0.001, features.bass + features.mid + features.high)),
    aggression: SignalMath.clamp((semanticState.trackCharacter?.timbre?.roughness || 0) * 0.5 + features.transientDensity * 0.5)
  };
  const instrumentEvidenceProfile = getInstrumentEvidenceProfile(true);
  const bassOnsets = onsetEvents.values().filter(x => x.lowImpact >= 0.55).map(x => x.at);
  const bassProfile = getBassPitchProfile(bassOnsets);
  const instrumentState = instrumentationEventEngine.update(semanticState.instruments, {
    accompanimentDensity: semanticState.trackCharacter?.texture?.density,
    onsetActivity: features.transientDensity,
    // Reused from the existing instrument-evidence descriptors (chroma vector motion / tonal
    // confidence) rather than a new pitch model — an honest proxy, not exact note tracking.
    melodicActivity: instrumentEvidenceProfile.descriptors.chromaMotion,
    pitchActivity: instrumentEvidenceProfile.descriptors.tonalFocus,
    bassPitchMotion: bassProfile.bassPitchMotion,
    bassOnsetRegularity: bassProfile.bassOnsetRegularity,
    bassPatternRepetition: bassProfile.bassRepetition
  });
  if (instrumentState) Object.assign(semanticState, instrumentState);
  semanticState.instrumentationEvidence = GenreContext.instrumentEvidence(semanticState);
  const grammar = RhythmicGrammar.analyze(onsetEvents.values(), rhythm.bpm, rhythm.confidence, performance.now());
  semanticState.rhythmicGrammar = grammar;
  semanticState.productionEvidence = RhythmicGrammar.production(features, expressionHistory.frames, {
    envelope: getBassEnergyEnvelope(),
    beatTimestamps: beatTimestamps.values(),
    beatConfidence: rhythm.confidence,
    repetition: semanticState.trackCharacter?.structure?.repetition,
    masterBrightness: semanticState.trackCharacter?.production?.masterBrightness,
    voiceConfidence: semanticState.instrumentationEvidence?.voice,
    onsetRate: recentOnsets
  });
  semanticState.aestheticEvidence = aestheticEvidenceEngine.evaluate(semanticState);
  semanticState.genreContextEvidence = genreContextEngine.evaluate(semanticState);
  const mirStartedAt = performance.now();
  semanticState.mir = mirEngine.update({
    bpm: rhythm.bpm,
    beatConfidence: rhythm.confidence,
    chroma: semanticState.audio.chroma,
    tonalFocus: semanticState.audio.tonalFocus,
    rhythmicGrammar: grammar
  });
  // Harmony and melody read the SEQUENCES the audio stage already keeps (chroma history, melodic
  // peak trajectory) rather than adding a new model: how fast harmony moves and what shape the
  // lead line traces are both visible there (sections 4-6).
  try {
    semanticState.harmonicMotion = (typeof HarmonicMotion !== "undefined" ? HarmonicMotion : null)?.analyze({
      chromaFrames: getChromaSequence(),
      frameIntervalMs: CONFIG.audio.meydaBufferSize / 44.1,
      bpm: rhythm.bpm,
      tonalFocus: semanticState.audio.tonalFocus
    }) || { reason: "unavailable" };
  } catch (error) {
    semanticState.harmonicMotion = { reason: "error", message: String(error.message || error).slice(0, 80) };
  }
  try {
    semanticState.pitchEvidence = (typeof MelodyContour !== "undefined" ? MelodyContour : null)?.analyze({
      samples: getMelodyPitchTrajectory(20000),
      bpm: rhythm.bpm
    }) || { reason: "unavailable" };
  } catch (error) {
    semanticState.pitchEvidence = { reason: "error", message: String(error.message || error).slice(0, 80) };
  }
  RuntimePerformance.recordMIR(performance.now() - mirStartedAt);
  SemanticCandidatePipeline.populate(semanticState, { arrangementEngine, idiomEngine: musicalIdiomEngine });
  updateTemporalEvidence();
  refreshSemanticWords();
  RuntimePerformance.recordSemantic(performance.now() - semanticStartedAt);
}

function updateTemporalEvidence() {
  const now = Date.now();
  const local = SemanticFacetManager.base(semanticState);
  const genreModel = semanticState.genre?.uncertain ? [] : (semanticState.genre.topK || []).slice(0, 4).map((item, index) =>
    SemanticFacets.token(item.label, "genre", index === 0 ? semanticState.genre.confidence : item.confidence,
      ["genreEvidence", "rhythmicGrammar", "trackCharacter.timbre"], { role: index === 0 ? "primary" : "secondary" }));
  const embedding = [
    ...(semanticState.zeroShot?.candidates || []).map(item => SemanticFacets.token(item.label, "genre", item.confidence,
      ["genreEvidence", "trackCharacter.timbre", "trackCharacter.rhythm"], { role: "adjacent" })),
    ...(semanticState.conceptEmbedding?.candidates || [])
  ];
  const candidates = evidenceFusionEngine.fuse({ local, genreModel, embedding }, now);
  semanticState.evidenceFusion = candidates;
  const temporal = temporalEvidenceEngine.update(candidates, now);
  semanticState.temporalEvidence = temporal;
  const byKey = new Map(temporal.evaluated.map(item => [`${item.category}:${String(item.text).toLowerCase()}`, item]));
  const restabilize = list => (list || []).map(item => {
    const stabilized = byKey.get(`${item.category}:${String(item.text).toLowerCase()}`);
    return stabilized ? { ...item, confidence: stabilized.confidence, weight: stabilized.confidence } : item;
  });
  semanticState.rhythmFacetCandidates = restabilize(semanticState.rhythmFacetCandidates);
  semanticState.productionFacetCandidates = restabilize(semanticState.productionFacetCandidates);
  semanticState.instrumentFacetCandidates = restabilize(semanticState.instrumentFacetCandidates);
  semanticState.arrangementFacetCandidates = restabilize(semanticState.arrangementFacetCandidates);
  if (semanticState.genreContextEvidence) {
    const stabilizedContext = restabilize(semanticState.genreContextEvidence.candidates)
      .sort((a, b) => b.confidence - a.confidence);
    semanticState.genreContextEvidence = {
      ...semanticState.genreContextEvidence,
      candidates: stabilizedContext,
      matchedPriors: stabilizedContext.map(item => item.text)
    };
  }
  const present = new Set(candidates.map(item => `${item.category}:${String(item.text).toLowerCase()}`));
  const remembered = temporal.trackMemory.filter(item => !present.has(`${item.category}:${String(item.text).toLowerCase()}`));
  for (const item of remembered) {
    const memoryToken = { ...item, source: "track-memory" };
    if (SemanticFacets.contextual.has(item.category) && semanticState.genreContextEvidence) {
      semanticState.genreContextEvidence.candidates = [...semanticState.genreContextEvidence.candidates, memoryToken];
      semanticState.genreContextEvidence.matchedPriors = [...semanticState.genreContextEvidence.matchedPriors, memoryToken.text];
    } else if (item.category === "arrangement") {
      semanticState.arrangementFacetCandidates = [...semanticState.arrangementFacetCandidates, memoryToken];
    } else if (item.category === "rhythm") {
      semanticState.rhythmFacetCandidates = [...semanticState.rhythmFacetCandidates, memoryToken];
    } else if (item.category === "production") {
      semanticState.productionFacetCandidates = [...semanticState.productionFacetCandidates, memoryToken];
    } else if (item.category === "instrumentation" || item.category === "performance" || item.category === "live") {
      semanticState.instrumentFacetCandidates = [...(semanticState.instrumentFacetCandidates || []), memoryToken];
    }
  }
  semanticState.stateV2 = SemanticStateV2.build({
    fusion: temporal.evaluated,
    temporal,
    mir: semanticState.mir || null,
    layers: {
      realtimeDSP: true,
      mir: Boolean(semanticState.mir),
      genreModel: semanticState.ml?.ready,
      embedding: semanticState.zeroShot?.available ? "active" : "unavailable",
      language: semanticState.language?.status || "fallback"
    }
  }, now);
}

function refreshSlowSemanticState() {
  if (!semanticState || !audioStarted) return;
  semanticState.novelty = noveltyDetector.update(semanticState.audio);
  updateTrackCharacterAndEpoch();
}

function updateTrackCharacterAndEpoch(embedding = latestRollingEmbedding, diagnostics = semanticState.ml?.diagnostics || {}) {
  if (!semanticState || !trackCharacterEngine || !semanticChangeDetector) return;
  const advanced = getAdvancedAudioProfile();
  const rhythm = getRhythmProfile();
  semanticState.trackCharacter = trackCharacterEngine.update({
    audio: { ...semanticState.audio, ...semanticState.expressionFeatures },
    advanced,
    rhythm,
    temporal: diagnostics,
    novelty: semanticState.novelty
  });
  semanticState.distinctive = distinctiveTracker.observe(semanticState.trackCharacter);
  semanticState.genre.fineCandidates = subgenreSearcher.search({
    topK: semanticState.genre.topK,
    character: semanticState.trackCharacter
  });
  if (!semanticEvidenceReady && semanticState.trackCharacter.confidence > 0.12) {
    semanticEvidenceReady = true;
    semanticState.semanticEpoch = semanticChangeDetector.advance();
    refreshSemanticWords(true);
  }
  const change = semanticChangeDetector.update({
    embedding,
    genre: semanticState.genre?.topK || [],
    character: semanticState.trackCharacter,
    novelty: semanticState.novelty?.score || 0,
    sectionTransition: semanticState.novelty?.transitionDetected
  });
  semanticState.semanticChange = change;
  if (change.changed) {
    semanticState.semanticEpoch = change.epoch;
    refreshSemanticWords(true);
  }
}

function requestMusicModelInference() {
  if (!semanticState || !audioStarted) return;
  const sessionId = semanticState.sessionId;
  if (!semanticState.ml.ready || semanticInferencePending || audioAnalysis.samples < CONFIG.ai.minimumSamples) return;
  const manifest = musicModelBridge.manifest;
  const seconds = manifest.preprocessing?.patchSeconds || 2.048;
  const shared = Boolean(mlAudioWindow?.shared);
  const analysisWindowId = semanticState.temporalEvidence?.revision || Math.floor(Date.now() / 1000);
  const audio = shared ? null : (typeof getMLAudioWindow === "function" ? getMLAudioWindow(seconds) : new Float32Array());
  if (!shared && !audio.length) return;
  semanticInferencePending = true;
  const inference = shared
    ? musicModelBridge.inferShared(seconds, sessionId, audioContext?.sampleRate || manifest.sampleRate, analysisWindowId)
    : musicModelBridge.infer(audio, sessionId, audioContext?.sampleRate || manifest.sampleRate, analysisWindowId);
  return inference.then(result => {
    if (!result || !semanticSessionGuard.isCurrent(result.sessionId) || result.error) return;
    if (Number(result.analysisWindowId) < lastAppliedAnalysisWindowId) return;
    lastAppliedAnalysisWindowId = Number(result.analysisWindowId) || lastAppliedAnalysisWindowId;
    applyMusicModelResult(result, manifest);
  }).finally(() => {
    semanticInferencePending = false;
  });
}

function applyMusicModelResult(result, manifest) {
  const currentOutputs = result.outputs || {};
  semanticState.novelty = noveltyDetector.update(semanticState.audio, currentOutputs.embedding);
  const outputs = temporalModelAggregator.add(currentOutputs);
  latestRollingEmbedding = outputs.embedding || [];
  semanticState.ml.diagnostics = outputs.diagnostics;
  semanticState.ml.trackEmbedding = {
    variance: outputs.trackEmbedding?.variance || 0,
    sectionCount: outputs.trackEmbedding?.sections?.length || 0
  };
  semanticState.ml.windows = Object.fromEntries(
    Object.entries(outputs.scales).map(([name, scale]) => [name, scale.count])
  );
  const genreOutput = outputs.genre;
  const predictions = GenreClassifier.classify(genreOutput, manifest.labels.genre, {
    topK: CONFIG.ml.genre.topK,
    activation: manifest.activations?.genre || "sigmoid"
  }).map(item => ({ ...item, label: canonicalGenre(item.label) }));
  if (predictions.length) {
    semanticState.genre = createCalibratedGenreState(predictions, outputs.diagnostics);
  }
  const embedding = outputs.embedding;
  semanticState.conceptEmbedding = {
    ...conceptEmbeddingEngine.status,
    candidates: conceptEmbeddingEngine.classify(embedding)
  };
  const now = Date.now();
  const zeroShotTriggered =
    semanticState.genre.confidence < CONFIG.ml.zeroShot.confidenceTrigger ||
    semanticState.genre.entropy > CONFIG.ml.zeroShot.entropyTrigger;
  const shouldUseZeroShot =
    CONFIG.ml.zeroShot.enabled &&
    zeroShotClassifier.available &&
    semanticPerformanceGovernor.profile().zeroShotAllowed &&
    embedding?.length &&
    zeroShotTriggered &&
    now - lastZeroShotAt >= CONFIG.ml.zeroShot.cooldown;
  semanticState.zeroShot.active = Boolean(shouldUseZeroShot);
  semanticState.zeroShot.candidates = shouldUseZeroShot
    ? zeroShotClassifier.classify(embedding, CONFIG.ml.genre.topK)
    : [];
  if (shouldUseZeroShot) lastZeroShotAt = now;
  if (semanticState.zeroShot.candidates.length) {
    const fused = evidenceFusionEngine.fuse({
      genreModel: predictions.map(item => ({ text: item.label, category: "genre", confidence: item.confidence })),
      embedding: semanticState.zeroShot.candidates.map(item => ({ text: item.label, category: "genre", confidence: item.confidence }))
    });
    semanticState.genre = createCalibratedGenreState(
      fused.map(item => ({ label: item.text, confidence: item.confidence })),
      outputs.diagnostics
    );
  }
  // Instrument events use current short-window output, not the long genre average.
  const instrumentOutput = currentOutputs.instrument || [];
  const mlInstruments = InstrumentClassifier.classify(instrumentOutput, manifest.labels.instrument, {
    activation: manifest.activations?.instrument || "identity"
  })
    .map(item => ({ ...item, source: "ml" }));
  currentModelInstruments = mlInstruments;
  currentModelInstrumentsAt = Date.now();
  refreshLocalInstruments();
  const moodOutput = outputs.mood;
  const mood = MoodClassifier.classify(moodOutput, manifest.labels.mood, {
    activation: manifest.activations?.mood || "sigmoid"
  });
  semanticState.mood.ml = mood.dimensions;
  semanticState.mood.labels = mood.tags;
  semanticState.mood.fused = SemanticFusion.fuseMood(semanticState.mood.local, mood.dimensions, true);
  semanticState.ml.lastUpdated = Date.now();
  semanticState.ml.inferenceLatency = result.latencyMs;
  RuntimePerformance.recordWorker(result.timings?.totalMs || result.latencyMs || 0);
  semanticState.status = semanticState.genre.uncertain ? "uncertain" : "ready";
  updateTrackCharacterAndEpoch(embedding, outputs.diagnostics);
  refreshSemanticWords();
}

function createCalibratedGenreState(predictions, diagnostics = {}) {
  const tracked = genreTracker.update(predictions, {
    novelty: semanticState.novelty.score,
    familyFor: genreFamily
  });
  const calibrated = ConfidenceCalibration.calibrate({
    predictions: tracked.topK,
    stability: tracked.stability,
    temporalAgreement: diagnostics.genreAgreement || 0,
    familyFor: genreFamily
  });
  const runnerUp = tracked.topK.find(item => item.label !== tracked.primary);
  const displayLabel = calibrated.unknown
    ? "미확정 장르"
    : calibrated.hybrid && runnerUp
      ? `${tracked.primary} / ${runnerUp.label}`
      : calibrated.uncertain && tracked.family !== "Unknown"
        ? `${tracked.family} 계열`
        : tracked.primary;
  return {
    ...tracked,
    ...calibrated,
    displayLabel,
    rawEntropy: tracked.entropy,
    observations: diagnostics.observations || 0,
    contextSeconds: diagnostics.contextSeconds || 0
  };
}

function refreshSemanticWords(force = false) {
  if (!semanticState || !phrasePoolEngine) return;
  const sessionId = semanticState.sessionId;
  const epoch = semanticState.semanticEpoch;
  const semanticTokens = []; // Legacy poetic dictionary is not a display-language source.
  const generation = phrasePoolEngine.regenerate({
    state: semanticState,
    semanticTokens,
    sessionId,
    epoch,
    force
  });
  semanticState.words = phrasePoolEngine.snapshot();
  syncMLState();
  generation.then(words => {
    if (!semanticSessionGuard.isCurrent(sessionId) || semanticState.semanticEpoch !== epoch) return;
    semanticState.words = words;
    syncMLState();
  });
}

function noteSemanticPhraseUsed(text) {
  phrasePoolEngine?.noteUsed(text);
  if (semanticState) semanticState.words = phrasePoolEngine?.snapshot() || [];
}

function getLanguageInspectionState() {
  return phrasePoolEngine?.inspection() || { state: {}, snapshot: null, artDirection: [], candidates: [], selected: [] };
}

function getSemanticState() {
  return semanticState || createInitialSemanticState();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createInitialSemanticState };
}
