const semanticSessionGuard = new SessionGuard();
let semanticSessionId = semanticSessionGuard.currentId;
let semanticState = null;
let semanticScheduler = null;
let musicModelBridge = null;
let genreTracker = null;
let noveltyDetector = null;
let temporalModelAggregator = null;
// Populated only from the currently loaded classifier model's own label metadata. No project
// taxonomy, alias table or developer-authored family mapping may name the genre.
let modelGenreFamilyLookup = new Map();
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
// Language has its own track lifetime.  A track boundary can happen without starting a new
// semantic session (and before the classifier has produced a new semantic epoch), so sessionId /
// semanticEpoch alone are not sufficient to keep late word-pool promises from Song A out of Song B.
let trackLanguageGeneration = 0;
const conceptExpansionControllers = new Map();
const MAX_CONCEPT_EXPANSIONS_IN_FLIGHT = 2;
let subgenreSearcher = new SubgenreSearch.Searcher();
let semanticEvidenceReady = false;
// Latest direct-audio-caption observations (js/main.js's periodic Flamingo capture, via
// lib/directAudioReview.js's toObservations()) -- a candidate array, same shape every other
// evidence source produces. Momentary FACT/LIVE observations follow the latest segment, while
// track-level genre/context/aesthetic/impression hypotheses can survive briefly with decaying
// confidence. Repetition across ticks keeps the same observation id, so temporalEvidenceEngine
// never mistakes memory for an independently re-heard claim.
let directAudioCandidates = [];
const expressionHistory = new MusicExpressionEngine.FeatureHistory();
let expressionWaveform = null;
let expressionSpectrum = null;
const instrumentationEventEngine = new InstrumentationEvents.Engine();
let genreContextEngine = new GenreContext.Engine();
let genreHypothesisEngine = new GenreHypotheses.Engine({}, {}, CONFIG.genreReasoning);
let temporalEvidenceEngine = new TemporalEvidence.Engine();
const evidenceFusionEngine = new EvidenceFusion.Engine();
const arrangementEngine = new ArrangementEngine.Engine();
let aestheticAxisEngine = new AestheticAxisEngine.Engine();
let aestheticEvidenceEngine = new AestheticEvidence.Engine();
const mirEngine = new MIREngine.Engine();
const conceptEmbeddingEngine = new ConceptEmbeddingEngine.Engine();
let musicalIdiomEngine = new MusicalIdioms.Engine();
const OpenWorld = typeof OpenWorldConceptRegistry !== "undefined" ? OpenWorldConceptRegistry : (() => {
  try { return require("./openWorldConceptRegistry"); } catch { return null; }
})();
const Progressive = typeof ProgressiveListening !== "undefined" ? ProgressiveListening : (() => {
  try { return require("./progressiveListeningEngine"); } catch { return null; }
})();
const TrackLifecycle = typeof TrackLifecycleEngine !== "undefined" ? TrackLifecycleEngine : (() => {
  try { return require("./trackLifecycleEngine"); } catch { return null; }
})();
const FlamingoReservoir = typeof FlamingoWordReservoir !== "undefined" ? FlamingoWordReservoir : (() => {
  try { return require("./flamingoWordReservoir"); } catch { return null; }
})();
const GenreHistory = typeof GenreEvidenceHistory !== "undefined" ? GenreEvidenceHistory : (() => {
  try { return require("./genreEvidenceHistory"); } catch { return null; }
})();
let openWorldRegistry = OpenWorld ? new OpenWorld.Registry() : null;
let progressiveListeningEngine = Progressive ? new Progressive.Engine() : null;
let trackLifecycleEngine = TrackLifecycle ? new TrackLifecycle.LifecycleEngine() : null;
let flamingoWordReservoir = FlamingoReservoir ? new FlamingoReservoir.Reservoir() : null;
let genreEvidenceHistory = GenreHistory ? new GenreHistory.History() : null;
// The T-panel's "reset just happened" banner (js/semantic/trackStatusInspector.js) needs to know
// WHAT was cleared, not just that a reset occurred -- captured here, right before the reservoir is
// actually wiped, since afterward there is nothing left to describe.
let lastFlamingoReset = null;
function captureFlamingoResetSummary(reason) {
  const concepts = flamingoWordReservoir?.conceptRegistry ? [...flamingoWordReservoir.conceptRegistry.values()] : [];
  lastFlamingoReset = {
    at: Date.now(),
    reason: reason || "unknown",
    clearedCount: concepts.length,
    sampleTexts: concepts.slice(0, 5).map(entry => entry.canonicalText)
  };
}

function cancelConceptExpansions() {
  for (const controller of conceptExpansionControllers.values()) controller.abort();
  conceptExpansionControllers.clear();
}

let lastPublishedWordPoolSignature = "";
let lastPublishedWordPoolAt = 0;
function publishLiveWordPool(words = [], force = false) {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const tokens = (Array.isArray(words) ? words : []).map(item => ({
    text: String(item?.text || "").trim(),
    layer: item?.layer || "FACT",
    type: item?.type || (String(item?.text || "").length > 20 ? "micro" : "fragment"),
    glow: Number(item?.glow) || 1
  })).filter(item => item.text);
  const signature = JSON.stringify(tokens);
  const now = Date.now();
  if (!force && signature === lastPublishedWordPoolSignature && now - lastPublishedWordPoolAt < 1500) return;

  lastPublishedWordPoolSignature = signature;
  lastPublishedWordPoolAt = now;
  fetch("/api/live-word-pool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokens,
      sessionId: semanticState?.sessionId ?? null,
      semanticEpoch: semanticState?.semanticEpoch || 0,
      trackEpoch: trackLifecycleEngine ? trackLifecycleEngine.getTrackEpoch() : (semanticState?.trackEpoch || 0)
    })
  }).catch(error => console.warn("[word-pool bridge] publish failed:", error.message || error));
}

function resetTrackLanguage(newEpoch, reason = "track_reset") {
  trackLanguageGeneration += 1;
  phrasePoolEngine?.reset(semanticSessionId);
  if (!semanticState) return;

  // Force a new language epoch at the same moment as the audio lifecycle epoch.  This prevents
  // the old genre/context card from surviving the gap before the local classifier has caught up.
  const semanticEpoch = (Number(semanticState.semanticEpoch) || 0) + 1;
  semanticState.semanticEpoch = semanticEpoch;
  semanticState.semanticChange = {
    score: 1,
    changed: true,
    epoch: semanticEpoch,
    reason,
    components: { trackBoundary: 1 }
  };
  semanticState.words = [];
  semanticState.trackEpoch = newEpoch;
  semanticState.language = {
    ...(semanticState.language || {}),
    status: "fallback",
    phraseCount: 0,
    remaining: 0,
    reason,
    semanticEpoch
  };
  publishLiveWordPool([], true);
  syncMLState();
}

if (trackLifecycleEngine) {
  trackLifecycleEngine.onResetTrack = (newEpoch, reason) => {
    cancelConceptExpansions();
    captureFlamingoResetSummary(reason);
    flamingoWordReservoir?.reset(newEpoch);
    genreEvidenceHistory?.reset();
    directAudioCandidates = [];
    resetTrackLanguage(newEpoch, reason || "track_changed");
    if (semanticState) {
      semanticState.directAudioCandidates = [];
      semanticState.flamingoReservoirCandidates = [];
      semanticState.flamingoIngestion = null;
      semanticState.trackEpoch = newEpoch;
      semanticState.lifecycleState = trackLifecycleEngine.getState();
    }
    progressiveListeningEngine?.reset();
    // Keep words already rendered on the canvas alive until their normal lifecycle expires. The
    // Flamingo reservoir and language pool are track-scoped data; clearing them must not erase
    // visual continuity for a word that was already visible before the boundary.
  };
  trackLifecycleEngine.onAudioRemoved = (reason) => {
    cancelConceptExpansions();
    captureFlamingoResetSummary(reason || "audio_removed");
    flamingoWordReservoir?.reset(trackLifecycleEngine.getTrackEpoch());
    genreEvidenceHistory?.reset();
    directAudioCandidates = [];
    resetTrackLanguage(trackLifecycleEngine.getTrackEpoch(), reason || "audio_removed");
    if (semanticState) {
      semanticState.directAudioCandidates = [];
      semanticState.flamingoReservoirCandidates = [];
      semanticState.flamingoIngestion = null;
      semanticState.lifecycleState = trackLifecycleEngine.getState();
    }
    progressiveListeningEngine?.reset();
    // Audio removal invalidates semantic candidates, but does not retroactively remove words
    // that are already in flight on screen. A fresh session still performs the full visual reset.
  };
}
const DirectContinuity = typeof DirectAudioContinuity !== "undefined" ? DirectAudioContinuity : (() => {
  try { return require("./directAudioContinuity"); } catch { return null; }
})();
const DirectGenreLabels = typeof GenreLabelShape !== "undefined" ? GenreLabelShape : (() => {
  try { return require("./genreLabelShape"); } catch { return null; }
})();
let currentModelInstruments = [];
let currentEventInstruments = [];
let currentModelInstrumentsAt = 0;
let currentInstrumentObservationId = null;
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
    classifierGenre: { ...genre, topK: [], secondary: [], related: [] },
    genreReasoning: { primary: null, challengers: [], alternatives: [], actualSubgenres: [],
      relatedGenres: [], relations: [], hypotheses: [], takeovers: [] },
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
    directAudioCandidates: [], directAudioObservationId: null, directAudioUncertainties: [],
    flamingoReservoirCandidates: [], flamingoIngestion: null,
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
  const [lexiconResponse, coreTermsResponse] = await Promise.all([
    fetch("./data/musicalLexicon.json"),
    fetch("./data/approvedCoreTerms.json")
  ]);
  if (coreTermsResponse.ok) SemanticFacets.setApprovedCoreTerms((await coreTermsResponse.json())?.entries);
  // The old taxonomy/alias/hierarchy/neighborhood/context/aesthetic JSON files remain available
  // for historical tests and migration, but are not runtime authorities. Genre names now enter
  // only through pretrained classifier metadata, Music Flamingo, or external model reasoning.
  genreHypothesisEngine.configure({}, {});
  if (lexiconResponse.ok) musicalIdiomEngine.setLexicon(await lexiconResponse.json());
  musicalIdiomEngine.setContext({ primitiveSchema: MusicalPrimitives.schema(), genreTaxonomy: {} });
  semanticState.knowledgeConsistency = KnowledgeConsistency.validate({
    lexicon: musicalIdiomEngine.lexicon,
    primitiveSchema: MusicalPrimitives.schema(),
    detectorRules: SemanticCandidatePipeline.productionRules,
    detectorCapabilities: RhythmicGrammar.detectorCapabilities,
    contextKnowledge: {},
    graph: musicalIdiomEngine.graph,
    directConsumerPaths: SemanticCandidatePipeline.primitiveConsumerPaths
  });
}

function canonicalGenre(label) {
  const clean = String(label || "").trim();
  const [parent, specific] = clean.includes("---") ? clean.split("---", 2) : ["", clean];
  if (parent && specific) modelGenreFamilyLookup.set(specific.toLowerCase(), parent.trim());
  return specific.trim();
}

function genreFamily(label) {
  return modelGenreFamilyLookup.get(canonicalGenre(label).toLowerCase()) || "Unknown";
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
  // Loading an idle embedded controls frame must not erase the word pool
  // produced by the active analyzer in another tab/window. A real audio
  // session publishes its own fresh pool from beginSemanticSession().
  if (typeof audioStarted !== "undefined" && audioStarted) refreshSemanticWords();
}

function beginSemanticSession(inputMode = "unknown") {
  expressionHistory.reset();
  instrumentationEventEngine.reset();
  currentModelInstruments = []; currentEventInstruments = []; currentModelInstrumentsAt = 0; currentInstrumentObservationId = null;
  semanticSessionId = semanticSessionGuard.next();
  RuntimePerformance.reset();
  genreTracker?.reset();
  noveltyDetector?.reset();
  temporalModelAggregator?.reset();
  trackCharacterEngine?.reset();
  distinctiveTracker?.reset();
  semanticChangeDetector?.reset();
  temporalEvidenceEngine?.reset();
  genreHypothesisEngine?.reset();
  mirEngine.reset();
  musicModelBridge?.resetSession();
  semanticInferencePending = false;
  lastAppliedAnalysisWindowId = 0;
  lastZeroShotAt = 0;
  latestRollingEmbedding = [];
  directAudioCandidates = [];
  cancelConceptExpansions();
  openWorldRegistry?.reset();
  progressiveListeningEngine?.reset();
  // A brand new audio source (not a mid-session track boundary) must never inherit the previous
  // source's trackEpoch, lifecycle state, or Flamingo reservoir -- those belong to session-level
  // reset (onResetTrack/onAudioRemoved handle the mid-session case already).
  trackLifecycleEngine?.resetAll(semanticSessionId);
  flamingoWordReservoir?.reset(1);
  genreEvidenceHistory?.reset();
  semanticEvidenceReady = false;
  semanticState = createInitialSemanticState(semanticSessionId);
  phrasePoolEngine?.reset(semanticSessionId);
  semanticState.status = "collecting";
  semanticState.inputMode = inputMode;
  semanticScheduler?.reset();
  if (typeof resetFloatingSemanticVisuals === "function") resetFloatingSemanticVisuals();
  if (typeof resetDeepListenRuntime === "function") resetDeepListenRuntime();
  syncMLState();
  refreshSemanticWords();
  return semanticSessionId;
}

function endSemanticSession() {
  expressionHistory.reset();
  instrumentationEventEngine.reset();
  currentModelInstruments = []; currentEventInstruments = []; currentModelInstrumentsAt = 0; currentInstrumentObservationId = null;
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
  genreHypothesisEngine?.reset();
  mirEngine.reset();
  musicModelBridge?.resetSession();
  latestRollingEmbedding = [];
  directAudioCandidates = [];
  cancelConceptExpansions();
  openWorldRegistry?.reset();
  progressiveListeningEngine?.reset();
  // A brand new audio source (not a mid-session track boundary) must never inherit the previous
  // source's trackEpoch, lifecycle state, or Flamingo reservoir -- those belong to session-level
  // reset (onResetTrack/onAudioRemoved handle the mid-session case already).
  trackLifecycleEngine?.resetAll(semanticSessionId);
  flamingoWordReservoir?.reset(1);
  genreEvidenceHistory?.reset();
  semanticEvidenceReady = false;
  semanticState = createInitialSemanticState(semanticSessionId);
  phrasePoolEngine?.reset(semanticSessionId);
  // Keep the last processed pool available to the 3D front after capture
  // stops. The next real audio session replaces it explicitly.
  if (typeof resetFloatingSemanticVisuals === "function") resetFloatingSemanticVisuals();
  if (typeof resetDeepListenRuntime === "function") resetDeepListenRuntime();
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
    flamingoPriority: typeof isDeepListenGpuBusy === "function" && isDeepListenGpuBusy(),
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

function updatePitchEvidence() {
  try {
    semanticState.pitchEvidence = (typeof MelodyContour !== "undefined" ? MelodyContour : null)?.analyze({
      samples: getMelodyPitchTrajectory(20000),
      bpm: semanticState.audio?.bpm || 0
    }) || { reason: "unavailable" };
  } catch (error) {
    semanticState.pitchEvidence = { reason: "error", message: String(error.message || error).slice(0, 80) };
  }
  return semanticState.pitchEvidence;
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
  const captureDebug = typeof getAudioCaptureDebugState === "function" ? getAudioCaptureDebugState() : null;
  const captureSignal = typeof hasCurrentAudioSignal === "function" && hasCurrentAudioSignal();
  const measurementWithCaptureFallback = captureSignal && measurement.rms < 0.001
    ? { ...measurement, rms: captureDebug?.rms || measurement.rms, peak: Math.max(measurement.peak || 0, captureDebug?.peak || 0) }
    : measurement;
  const features = expressionHistory.update({
    ...semanticState.audio, ...latestMeasuredFeatures, ...measurementWithCaptureFallback, ...spectrum,
    energy: SignalMath.clamp(measurementWithCaptureFallback.rms * 2 + SignalMath.clamp(recentOnsets / 4.2) * 0.15),
    tempoStability: rhythm.stability, onsetRate: recentOnsets,
    transientDensity: SignalMath.clamp(recentOnsets / 4.2),
    harmonicMovement: semanticState.trackCharacter?.harmony?.harmonicMotion || 0,
    pumping: semanticState.trackCharacter?.dynamics?.pumping || 0
  });
  if (captureSignal) features.audible = true;
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
  // The pitch trajectory is an actual melodic-register observation. Compute it before the
  // instrumentation event engine so solo/lead decisions can use it in the same semantic tick,
  // rather than relying on whole-mixture tonalFocus from the previous tick.
  const pitchEvidence = updatePitchEvidence();
  const pitchConfidence = Number.isFinite(pitchEvidence?.confidence) ? pitchEvidence.confidence : null;
  const instrumentEvidenceProfile = getInstrumentEvidenceProfile(true);
  const bassOnsets = onsetEvents.values().filter(x => x.lowImpact >= 0.55).map(x => x.at);
  const bassProfile = getBassPitchProfile(bassOnsets);
  const instrumentState = instrumentationEventEngine.update(semanticState.instruments, {
    eventInstruments: currentEventInstruments,
    observationId: currentInstrumentObservationId,
    accompanimentDensity: semanticState.trackCharacter?.texture?.density,
    onsetActivity: features.transientDensity,
    // Reused from the existing instrument-evidence descriptors (chroma vector motion / tonal
    // confidence) rather than a new pitch model — an honest proxy, not exact note tracking.
    melodicActivity: Math.max(instrumentEvidenceProfile.descriptors.chromaMotion || 0,
      pitchConfidence === null ? 0 : pitchConfidence * 0.9),
    pitchActivity: pitchConfidence === null ? instrumentEvidenceProfile.descriptors.tonalFocus : pitchConfidence,
    bassPitchMotion: bassProfile.bassPitchMotion,
    bassOnsetRegularity: bassProfile.bassOnsetRegularity,
    bassPatternRepetition: bassProfile.bassRepetition,
    walkingEvidence: bassProfile.walkingEvidence,
    bassStepwiseRatio: bassProfile.stepwiseRatio,
    bassPitchClassHistogram: bassProfile.pitchClassHistogram,
    dominantBassPitchClass: bassProfile.dominantPitchClass
  });
  if (instrumentState) Object.assign(semanticState, instrumentState);
  semanticState.instrumentationEvidence = GenreContext.instrumentEvidence(semanticState);
  const grammar = RhythmicGrammar.analyze(onsetEvents.values(), rhythm.bpm, rhythm.confidence, performance.now());
  semanticState.rhythmicGrammar = grammar;
  // Real evidence of synth/sampler/computer instrumentation -- not spectral brightness, which a
  // dark acoustic recording has just as often as an actual sample-based track for unrelated reasons.
  const electronicConfidence = Math.max(0,
    semanticState.instrumentationEvidence?.synthesizer || 0, semanticState.instrumentationEvidence?.synth || 0,
    semanticState.instrumentationEvidence?.sampler || 0, semanticState.instrumentationEvidence?.computer || 0);
  semanticState.productionEvidence = RhythmicGrammar.production(features, expressionHistory.frames, {
    envelope: getBassEnergyEnvelope(),
    beatTimestamps: beatTimestamps.values(),
    beatConfidence: rhythm.confidence,
    repetition: semanticState.trackCharacter?.structure?.repetition,
    electronicConfidence,
    voiceConfidence: semanticState.instrumentationEvidence?.voice,
    onsetRate: recentOnsets,
    stereo: features.stereo || (typeof getAudioCaptureDebugState === "function" ? getAudioCaptureDebugState()?.stereo : null)
  });
  applyGenreHypotheses();
  // Local measurements stop at FACT/LIVE. They are not converted into developer-authored mood,
  // aesthetic, scene, era or lineage language. Runtime-discovered external relations are merged
  // below when available.
  semanticState.aestheticEvidence = {};
  semanticState.genreContextEvidence = {
    genre: semanticState.genre?.uncertain ? null : semanticState.genre?.primary || null,
    confidence: 0,
    basis: "external model context only",
    matchedPriors: [],
    candidates: []
  };
  if (semanticState.genreReasoning?.relations?.length) {
    const combined = [...(semanticState.genreContextEvidence.candidates || []), ...semanticState.genreReasoning.relations];
    const best = new Map();
    for (const item of combined) {
      const key = `${item.category}:${String(item.text).toLowerCase()}`;
      if (!best.has(key) || best.get(key).confidence < item.confidence) best.set(key, item);
    }
    semanticState.genreContextEvidence.candidates = [...best.values()];
    semanticState.genreContextEvidence.matchedPriors = semanticState.genreContextEvidence.candidates.map(item => item.text);
    semanticState.genreContextEvidence.confidence = Math.max(semanticState.genreContextEvidence.confidence || 0,
      ...semanticState.genreReasoning.relations.map(item => item.confidence || 0));
  }
  const mirStartedAt = performance.now();
  semanticState.mir = mirEngine.update({
    bpm: rhythm.bpm,
    beatConfidence: rhythm.confidence,
    chroma: semanticState.audio.chroma,
    harmonicChroma: typeof getHarmonicChroma === "function" ? getHarmonicChroma() : null,
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
  RuntimePerformance.recordMIR(performance.now() - mirStartedAt);
  SemanticCandidatePipeline.populate(semanticState, { arrangementEngine, idiomEngine: musicalIdiomEngine });
  updateTemporalEvidence();
  refreshSemanticWords();
  RuntimePerformance.recordSemantic(performance.now() - semanticStartedAt);
}

function applyGenreHypotheses() {
  if (!semanticState || !genreHypothesisEngine) return;
  const reasoning = genreHypothesisEngine.evaluate(semanticState, Date.now());
  semanticState.genreReasoning = reasoning;
  const primary = reasoning.primary;
  if (!primary) return;
  const semanticConfidence = primary.semanticConfidence || 0;
  const uncertain = semanticConfidence < 0.34;
  const runnerUp = reasoning.challengers[0];
  const margin = Math.max(0, semanticConfidence - (runnerUp?.semanticConfidence || 0));
  const hypothesisScores = reasoning.hypotheses.slice(0, CONFIG.ml.genre.topK).map(item => item.semanticConfidence || 0);
  const scoreTotal = hypothesisScores.reduce((sum, value) => sum + value, 0);
  const entropy = scoreTotal > 0 && hypothesisScores.length > 1
    ? -hypothesisScores.reduce((sum, value) => {
      const probability = value / scoreTotal;
      return sum + (probability ? probability * Math.log(probability) : 0);
    }, 0) / Math.log(hypothesisScores.length)
    : 0;
  semanticState.genre = {
    ...(semanticState.classifierGenre || semanticState.genre),
    family: genreFamily(primary.genre),
    primary: primary.genre,
    displayLabel: uncertain && genreFamily(primary.genre) !== "Unknown"
      ? `${genreFamily(primary.genre)} 계열` : uncertain ? `${primary.genre} 가능성` : primary.genre,
    confidence: semanticConfidence,
    semanticConfidence,
    stability: primary.temporalStability || 0,
    temporalStability: primary.temporalStability || 0,
    rawConfidence: primary.classifierConfidence || 0,
    margin,
    entropy,
    topK: reasoning.hypotheses.slice(0, CONFIG.ml.genre.topK).map(item => ({
      label: item.genre, confidence: item.semanticConfidence, semanticConfidence: item.semanticConfidence,
      temporalStability: item.temporalStability, kind: item.kind, evidenceCoverage: item.evidenceCoverage
    })),
    secondary: reasoning.challengers.slice(0, CONFIG.ml.genre.topK - 1).map(item => ({
      label: item.genre, confidence: item.semanticConfidence, evidenceCoverage: item.evidenceCoverage
    })),
    related: reasoning.relatedGenres,
    alternativeHypotheses: reasoning.alternatives,
    fineCandidates: reasoning.actualSubgenres,
    uncertain,
    unknown: uncertain,
    hybrid: Boolean(runnerUp && Math.abs(semanticConfidence - runnerUp.semanticConfidence) < 0.08),
    certainty: uncertain ? "uncertain" : semanticConfidence >= 0.67 ? "certain" : "probable"
  };
  if (reasoning.takeover && semanticChangeDetector) {
    semanticState.semanticEpoch = semanticChangeDetector.accept({
      embedding: latestRollingEmbedding,
      genre: semanticState.genre.topK,
      character: semanticState.trackCharacter
    }, reasoning.takeover.at);
    semanticState.semanticChange = { score: 1, changed: true, epoch: semanticState.semanticEpoch,
      reason: "genre-hypothesis-takeover", components: { genreTakeover: 1 }, takeover: reasoning.takeover };
    refreshSemanticWords(true);
  }
}

function updateTemporalEvidence() {
  const now = Date.now();
  if (DirectContinuity) directAudioCandidates = DirectContinuity.active(directAudioCandidates, { now });
  if (semanticState) semanticState.directAudioCandidates = directAudioCandidates;
  // Direct-listening candidates have their own fusion group below. Excluding them from `local`
  // prevents one Flamingo hearing from masquerading as two independent evidence sources.
  const local = SemanticFacetManager.base(semanticState).filter(item =>
    item.source !== "directAudio" && item.sourceFamily !== "directAudio");
  const genreModel = semanticState.genre?.uncertain ? [] : (semanticState.genreReasoning?.hypotheses || []).slice(0, 5).map((item, index) =>
    SemanticFacets.token(item.genre, "genre", item.semanticConfidence,
      (item.supportingEvidence || []).map(evidence => evidence.path === "classifierGenre.topK" ? "genreEvidence" : evidence.path)
        .slice(0, 8).concat(index === 0 ? ["primaryGenre"] : []),
      { role: index === 0 ? "primary" : "challenger", semanticConfidence: item.semanticConfidence,
        temporalStability: item.temporalStability, evidenceCoverage: item.evidenceCoverage,
        independentEvidenceCount: item.independentEvidenceCount, hypothesisKind: item.kind }));
  const embedding = [
    ...(semanticState.zeroShot?.candidates || []).map(item => SemanticFacets.token(item.label, "genre", item.confidence,
      ["genreEvidence", "trackCharacter.timbre", "trackCharacter.rhythm"], { role: "adjacent" })),
    ...(semanticState.conceptEmbedding?.candidates || [])
  ];
  const candidates = evidenceFusionEngine.fuse({ local, genreModel, embedding, directAudio: directAudioCandidates }, now);
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
  if (openWorldRegistry) {
    openWorldRegistry.tick(now);
    semanticState.openWorldConcepts = openWorldRegistry.all({ compact: true });
  }
  if (progressiveListeningEngine) {
    const observationSeconds = semanticState.expressionFeatures?.observationSeconds ?? (temporal.elapsedMs || 0) / 1000;
    progressiveListeningEngine.update({
      state: semanticState,
      observationSeconds,
      semanticChange: Boolean(semanticState.semanticChange?.changed),
      sectionChange: Boolean(semanticState.novelty?.transitionDetected)
    }, now);
    semanticState.progressiveReadiness = progressiveListeningEngine.readiness;
  }
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
  // Neighborhood search produces alternatives, not taxonomic children. Keep it out of
  // `subgenreCandidates`; only GenreHypotheses' explicit hierarchy may populate that field.
  // Developer-authored neighborhood tables cannot propose genre names.
  semanticState.genre.relatedCandidates = [];
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
  // The local WebGPU models and Music Flamingo share one physical GPU. Preserve playback and
  // Flamingo headroom while a deep-listen request is active; the fixed audio ring keeps recording
  // and the next scheduled local pass catches up from the latest window after Flamingo returns.
  if (typeof isDeepListenGpuBusy === "function" && isDeepListenGpuBusy()) return;
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
  const patchPredictions = GenreClassifier.classify(currentOutputs.genre, manifest.labels.genre, {
    topK: CONFIG.ml.genre.topK,
    activation: manifest.activations?.genre || "sigmoid"
  }).map(item => ({ ...item, label: canonicalGenre(item.label) }));
  if (patchPredictions.length && genreEvidenceHistory) {
    const patchTop = patchPredictions[0]?.confidence || 0;
    const patchSecond = patchPredictions[1]?.confidence || 0;
    genreEvidenceHistory.recordLocalPatch({
      topK: patchPredictions.map(item => ({ label: item.label, score: item.confidence })),
      rawTopScore: patchTop,
      runnerUpScore: patchSecond,
      margin: Math.max(0, patchTop - patchSecond),
      entropy: ConfidenceCalibration.normalizedEntropy(patchPredictions),
      sectionId: outputs.diagnostics?.sectionCount || 0,
      embedding: currentOutputs.embedding
    });
  }
  if (predictions.length) {
    semanticState.classifierGenre = createCalibratedGenreState(predictions, outputs.diagnostics);
    semanticState.genre = { ...semanticState.classifierGenre };
    semanticState.genreEvidence = genreEvidenceHistory ? genreEvidenceHistory.snapshot() : null;
  }
  const embedding = outputs.embedding;
  semanticState.conceptEmbedding = {
    ...conceptEmbeddingEngine.status,
    candidates: conceptEmbeddingEngine.classify(embedding)
  };
  const now = Date.now();
  // The project-local zero-shot label database is not a pretrained listening model. Keep it out
  // of genre naming; the bundled classifier and Music Flamingo remain the two audio listeners.
  semanticState.zeroShot.active = false;
  semanticState.zeroShot.candidates = [];
  // Presence uses the fast temporal window, while entrances/exits/performance use the newest raw
  // inference. Holding one raw result between model runs must not count as multiple observations.
  const instrumentOutput = currentOutputs.instrument || [];
  const presenceOutput = outputs.scales?.fast?.instrument?.length ? outputs.scales.fast.instrument : instrumentOutput;
  const observedAt = Date.now();
  const observationId = result.analysisWindowId ?? result.id ?? observedAt;
  currentModelInstruments = InstrumentClassifier.classify(presenceOutput, manifest.labels.instrument, {
    activation: manifest.activations?.instrument || "identity"
  }).map(item => ({ ...item, source: "ml", observedAt, observationId }));
  currentEventInstruments = InstrumentClassifier.classify(instrumentOutput, manifest.labels.instrument, {
    activation: manifest.activations?.instrument || "identity"
  }).map(item => ({ ...item, source: "ml", observedAt, observationId }));
  currentModelInstrumentsAt = observedAt;
  currentInstrumentObservationId = observationId;
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
    predictions,
    stability: tracked.stability,
    temporalAgreement: diagnostics.genreAgreement || 0,
    familyFor: genreFamily
  });
  const currentTop = Math.max(0.0001, ...predictions.map(item => Number(item.confidence) || 0));
  const primaryRaw = predictions.find(item => item.label === tracked.primary)?.confidence || 0;
  const primarySupportRatio = Math.min(1, primaryRaw / currentTop);
  const semanticConfidence = calibrated.semanticConfidence * primarySupportRatio;
  const primaryUnknown = primaryRaw < 0.016 || semanticConfidence < 0.2;
  const runnerUp = tracked.topK.find(item => item.label !== tracked.primary);
  const displayLabel = primaryUnknown
    ? "미확정 장르"
    : calibrated.hybrid && runnerUp
      ? `${tracked.primary} / ${runnerUp.label}`
      : (primaryUnknown || semanticConfidence < 0.34) && tracked.family !== "Unknown"
        ? `${tracked.family} 계열`
        : tracked.primary;
  const history = genreEvidenceHistory ? genreEvidenceHistory.snapshot() : {};
  return {
    ...tracked,
    ...calibrated,
    confidence: semanticConfidence,
    semanticConfidence,
    reliability: calibrated.reliability ?? semanticConfidence,
    displayConfidence: semanticConfidence,
    rawTopScore: calibrated.rawTopScore ?? primaryRaw,
    runnerUpScore: calibrated.runnerUpScore ?? 0,
    normalizedMargin: calibrated.normalizedMargin ?? 0,
    independentPatchCount: history.independentPatchCount || 0,
    sectionAgreement: history.sectionAgreement || 0,
    conflictingSectionCount: history.conflictingSectionCount || 0,
    temporalStability: tracked.stability,
    unknown: primaryUnknown,
    uncertain: primaryUnknown || semanticConfidence < 0.34,
    displayLabel,
    rawEntropy: tracked.entropy,
    classifierRawTopK: predictions,
    observations: diagnostics.observations || 0,
    contextSeconds: diagnostics.contextSeconds || 0
  };
}

function refreshSemanticWords(force = false) {
  if (!semanticState || !phrasePoolEngine) return;
  // A surface family can rotate or be replaced by the Korean realizer without changing the
  // stabilized evidence in stateV2. Always project the live reservoir immediately before the
  // phrase pool is rebuilt so stateV2 cannot pin an older wording.
  semanticState.flamingoReservoirCandidates = flamingoWordReservoir ? flamingoWordReservoir.getCandidates() : [];
  const sessionId = semanticState.sessionId;
  const epoch = semanticState.semanticEpoch;
  const trackEpoch = trackLifecycleEngine ? trackLifecycleEngine.getTrackEpoch() : (semanticState.trackEpoch || 0);
  const languageGeneration = trackLanguageGeneration;
  const semanticTokens = []; // Legacy poetic dictionary is not a display-language source.
  const generation = phrasePoolEngine.regenerate({
    state: semanticState,
    semanticTokens,
    sessionId,
    epoch,
    trackEpoch,
    force
  });
  semanticState.words = phrasePoolEngine.snapshot();
  publishLiveWordPool(semanticState.words);
  syncMLState();
  generation.then(words => {
    if (!semanticSessionGuard.isCurrent(sessionId) || semanticState.semanticEpoch !== epoch) return;
    if (trackLanguageGeneration !== languageGeneration) return;
    if (trackLifecycleEngine && trackLifecycleEngine.getTrackEpoch() !== trackEpoch) return;
    semanticState.words = words;
    publishLiveWordPool(words, true);
    syncMLState();
  });
}

// Called by js/main.js whenever a fresh Flamingo caption is parsed (lib/directAudioReview.js's
// toObservations()). Replaces the whole set -- a stale caption's claims must not linger once a
// newer one exists, since temporalEvidenceEngine reads whatever this holds on every tick.
function applyDirectAudioObservations(candidates = [], metadata = {}) {
  if (metadata?.sessionId !== undefined && metadata?.sessionId !== null &&
      Number(metadata.sessionId) !== Number(semanticState?.sessionId)) return false;

  const currentEpoch = trackLifecycleEngine ? trackLifecycleEngine.getTrackEpoch() : (metadata?.trackEpoch || 0);
  if (metadata?.trackEpoch !== undefined && Number(metadata.trackEpoch) !== currentEpoch) {
    if (trackLifecycleEngine) trackLifecycleEngine.staleResponseDropCount += 1;
    return false;
  }

  const observationId = metadata?.observationId || (candidates[0]?.observationId) || `obs-flam-${Date.now()}`;
  const independenceGroup = metadata?.independenceGroup || (candidates[0]?.independenceGroup) || observationId;
  const audioSegmentId = metadata?.audioSegmentId || (candidates[0]?.audioSegmentId) || null;
  const trackEpoch = metadata?.trackEpoch !== undefined ? Number(metadata.trackEpoch) : currentEpoch;
  const requestId = metadata?.requestId || (candidates[0]?.requestId) || null;

  // Ingest into track-scoped FlamingoWordReservoir
  if (!flamingoWordReservoir && FlamingoReservoir?.Reservoir) {
    flamingoWordReservoir = new FlamingoReservoir.Reservoir({ trackEpoch });
  }
  let reservoirPacket = metadata?.structuredPacket || null;
  const structuredCount = FlamingoReservoir?.packetConceptCount
    ? FlamingoReservoir.packetConceptCount(reservoirPacket || {}) : 0;
  let usedObservationFallback = false;
  if (flamingoWordReservoir && structuredCount === 0 && candidates.length &&
      FlamingoReservoir?.packetFromObservations) {
    reservoirPacket = FlamingoReservoir.packetFromObservations(candidates);
    usedObservationFallback = FlamingoReservoir.packetConceptCount(reservoirPacket) > 0;
  }
  // The response has already passed the lifecycle guard above. If the reservoir alone drifted to
  // another epoch (for example after a late initialization/reset callback), realign that internal
  // store to the authoritative current track instead of silently rejecting every future packet.
  if (flamingoWordReservoir && flamingoWordReservoir.trackEpoch !== trackEpoch) {
    flamingoWordReservoir.reset(trackEpoch);
  }
  const reservoirAccepted = Boolean(flamingoWordReservoir && reservoirPacket &&
    flamingoWordReservoir.ingestPacket(reservoirPacket, {
      trackEpoch,
      observationId,
      audioSegmentId,
      timestamp: Date.now(),
      listeningMode: metadata?.continuity?.listeningMode || "independent"
    }));

  const incomingDirectAudioCandidates = (Array.isArray(candidates) ? candidates : []).map(item => {
    const common = { ...item, observationId, independenceGroup, audioSegmentId, trackEpoch, requestId, resolutionMomentum: true };
    if (item.category === "genre" && DirectGenreLabels && !DirectGenreLabels.isPlausibleGenreLabel(item.text)) return null;
    return common;
  }).filter(Boolean);
  directAudioCandidates = DirectContinuity
    ? DirectContinuity.merge(directAudioCandidates, incomingDirectAudioCandidates)
    : incomingDirectAudioCandidates;

  if (semanticState) {
    semanticState.directAudioCandidates = directAudioCandidates;
    semanticState.directAudioObservationId = observationId;
    semanticState.flamingoReservoirCandidates = flamingoWordReservoir ? flamingoWordReservoir.getCandidates() : [];
    semanticState.flamingoIngestion = {
      accepted: reservoirAccepted,
      usedObservationFallback,
      structuredConceptCount: structuredCount,
      receivedObservationCount: Array.isArray(candidates) ? candidates.length : 0,
      reservoirConceptCount: flamingoWordReservoir?.conceptRegistry?.size || 0,
      trackEpoch,
      observationId,
      updatedAt: Date.now()
    };
    semanticState.directAudioUncertainties = (metadata?.structuredPacket?.uncertainties || [])
      .filter(item => typeof item === "string" && item.trim()).slice(0, 8);
  }

  if (openWorldRegistry) {
    // Only the fresh capture is proposed. Re-retaining an older candidate is memory, not a new
    // independent observation, and must never inflate temporal or cross-source support.
    for (const item of incomingDirectAudioCandidates) {
      const type = item.category === "genre" ? "genre"
        : ["scene", "era", "culture", "lineage"].includes(item.category) ? item.category
        : item.category === "mood" ? "impression"
        : item.category === "association" ? "aesthetic"
        : "production-style";
      const proposed = openWorldRegistry.propose({
        label: item.text,
        conceptType: type,
        source: item.source || "directAudio",
        sourceFamily: item.sourceFamily || "directAudio",
        sourceModel: item.sourceModel || metadata?.provider || "music-flamingo",
        observationId,
        independenceGroup,
        audioSegmentId,
        confidence: item.confidence ?? 0.65,
        supportingEvidence: [...(item.anchors || []), ...(item.supportRefs || [])],
        reasoningHints: item.reasoningHints || null,
        conditionedOnClassifier: Boolean(item.conditionedOnClassifier),
        conditioningSources: Array.isArray(item.conditioningSources) ? item.conditioningSources : [],
        conditioningCandidateLabels: Array.isArray(item.conditioningCandidateLabels)
          ? item.conditioningCandidateLabels : []
      });
      // World-knowledge expansion is external-model work. There is no local registry of names
      // that can declare a candidate already understood; the registry itself guards re-entry.
      if (proposed && !proposed.expansionRequested && proposed.status !== "emerging" &&
          (type === "genre" || type === "microgenre") &&
          typeof fetch === "function") {
        const expansionKey = `${semanticState?.sessionId || 0}:${trackEpoch}:${proposed.id}`;
        if (conceptExpansionControllers.has(expansionKey)) continue;
        while (conceptExpansionControllers.size >= MAX_CONCEPT_EXPANSIONS_IN_FLIGHT) {
          const [oldestKey, oldestController] = conceptExpansionControllers.entries().next().value;
          oldestController.abort();
          conceptExpansionControllers.delete(oldestKey);
        }
        const expansionController = new AbortController();
        conceptExpansionControllers.set(expansionKey, expansionController);
        const expansionSessionId = semanticState?.sessionId;
        fetch("/api/expand-concept", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ concept: item.text, conceptType: type }),
          signal: expansionController.signal
        }).then(res => res.json()).then(data => {
          if (semanticState?.sessionId === expansionSessionId &&
              (!trackLifecycleEngine || trackLifecycleEngine.getTrackEpoch() === trackEpoch) &&
              data?.expansions) openWorldRegistry.proposeExpansion(item.text, data.expansions);
        }).catch(() => { /* world-knowledge expansion is a nicety, never a requirement */ })
          .finally(() => {
            if (conceptExpansionControllers.get(expansionKey) === expansionController) {
              conceptExpansionControllers.delete(expansionKey);
            }
          });
      }
    }
  }

  if (progressiveListeningEngine) {
    progressiveListeningEngine.noteDeepListen(observationId, metadata?.structuredPacket || {});
  }
  if (genreEvidenceHistory && metadata?.structuredPacket) {
    genreEvidenceHistory.recordFlamingo({
      hypotheses: metadata.structuredPacket.genreHypotheses,
      signatureRelations: metadata.structuredPacket.signatureRelations,
      uncertainties: metadata.structuredPacket.uncertainties,
      listeningMode: metadata.continuity?.listeningMode,
      independent: metadata.continuity?.independent !== false &&
        metadata.continuity?.listeningMode !== "assisted" &&
        !metadata.continuity?.genreAdvisoryUsed,
      provisional: metadata.continuity?.listenDepth === "first-impression" ||
        (metadata.structuredPacket.genreHypotheses || []).some(item => item?.provisional),
      observationId,
      segmentId: audioSegmentId
    });
    if (semanticState) semanticState.genreEvidence = genreEvidenceHistory.snapshot();
  }

  if (typeof updateTemporalEvidence === "function") {
    try { updateTemporalEvidence(); } catch { /* safe */ }
  }

  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("deepListenResolution", {
        detail: { observationId, candidateCount: directAudioCandidates.length, timestamp: Date.now() }
      }));
    } catch { /* safe */ }
  }

  if (phrasePoolEngine && semanticState) {
    refreshSemanticWords(true);
  }
  return true;
}

function noteSemanticPhraseUsed(candidate) {
  const text = typeof candidate === "object" ? candidate?.text : candidate;
  const surfaceConceptKey = typeof candidate === "object" ? candidate?.surfaceConceptKey : null;
  phrasePoolEngine?.noteUsed(text);
  const rotated = flamingoWordReservoir?.noteUsed(text, surfaceConceptKey) || false;
  if (rotated && semanticState) {
    semanticState.flamingoReservoirCandidates = flamingoWordReservoir.getCandidates();
    refreshSemanticWords(false);
  } else if (semanticState) {
    semanticState.words = phrasePoolEngine?.snapshot() || [];
  }
}

function getLanguageInspectionState() {
  return phrasePoolEngine?.inspection() || { state: {}, snapshot: null, artDirection: [], candidates: [], selected: [] };
}

// CONTEXT's third stage: the reconciliation of the classifier's reading and Music Flamingo's,
// as produced by /api/compose-genre. This is an INTERPRETATION of two existing readings, not a
// new observation of the audio, so it is filed with both of its inputs declared as conditioning
// sources and its own independence group. It can therefore surface a name neither source could
// state alone without ever counting as a third witness for one -- `independenceGroups` and
// `conditionedOnClassifier` in openWorldConceptRegistry are what keep that honest.
function applyComposedGenre(composite = [], meta = {}) {
  if (!openWorldRegistry || !Array.isArray(composite) || !composite.length) return 0;
  const trackEpoch = trackLifecycleEngine ? trackLifecycleEngine.getTrackEpoch() : 1;
  if (meta.trackEpoch !== undefined && Number(meta.trackEpoch) !== trackEpoch) return 0;
  const observationId = meta.observationId || `compose-${trackEpoch}-${Date.now()}`;
  let accepted = 0;
  for (const item of composite.slice(0, 3)) {
    const label = String(item?.label || "").trim();
    if (!label || (DirectGenreLabels && !DirectGenreLabels.isPlausibleGenreLabel(label))) continue;
    // A conflict is a report that the two readings cannot both be true. It belongs in the record
    // as an uncertainty, not as a confident new name for the music.
    const confidence = item.relation === "conflict"
      ? Math.min(0.4, Number(item.confidence) || 0.3)
      : Math.min(0.8, Number(item.confidence) || 0.55);
    openWorldRegistry.propose({
      label,
      conceptType: "genre",
      source: "genre-composition-llm",
      sourceFamily: "llmComposite",
      sourceModel: meta.model || "llm-composer",
      observationId,
      independenceGroup: `llm-composite:${observationId}`,
      audioSegmentId: meta.audioSegmentId || null,
      confidence,
      supportingEvidence: Array.isArray(item.reconciles) ? item.reconciles : [],
      reasoningHints: item.relation || null,
      conditionedOnClassifier: true,
      conditioningSources: ["genre-classifier", "music-flamingo"],
      conditioningCandidateLabels: Array.isArray(item.reconciles) ? item.reconciles.slice(0, 6) : [],
      synthesized: Boolean(item.synthesized),
      independent: false
    });
    accepted += 1;
  }
  if (semanticState && Array.isArray(meta.uncertainties) && meta.uncertainties.length) {
    semanticState.genreCompositionUncertainties = meta.uncertainties.slice(0, 5);
  }
  genreEvidenceHistory?.recordAdjudication({ composite, uncertainties: meta.uncertainties });
  if (semanticState && genreEvidenceHistory) semanticState.genreEvidence = genreEvidenceHistory.snapshot();
  return accepted;
}

function getSemanticState() {
  return semanticState || createInitialSemanticState();
}

function getProgressiveListeningEngine() {
  return progressiveListeningEngine;
}

function getTrackLifecycleEngine() {
  return trackLifecycleEngine;
}

function getFlamingoWordReservoir() {
  return flamingoWordReservoir;
}

function getLastFlamingoReset() {
  return lastFlamingoReset;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createInitialSemanticState,
    getProgressiveListeningEngine,
    getOpenWorldConceptRegistry,
    getTrackLifecycleEngine,
    getFlamingoWordReservoir,
    getGenreEvidenceHistory: () => genreEvidenceHistory,
    getLastFlamingoReset,
    applyDirectAudioObservations
  };
}
