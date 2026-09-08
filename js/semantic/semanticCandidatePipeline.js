// One deterministic semantic-candidate path shared by browser production and smoke fixtures.
// It starts after audio/DSP evidence exists; it intentionally does not emulate capture or FFT.
const SemanticCandidatePipeline = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Instruments = typeof InstrumentationEvents !== "undefined" ? InstrumentationEvents : require("./instrumentationEventEngine");
  const Primitives = typeof MusicalPrimitives !== "undefined" ? MusicalPrimitives : require("./musicalPrimitiveEngine");
  const Observations = typeof MusicalObservations !== "undefined" ? MusicalObservations : require("./musicalObservationEngine");
  const Arrangement = typeof ArrangementEngine !== "undefined" ? ArrangementEngine : require("./arrangementEngine");
  const Idioms = typeof MusicalIdioms !== "undefined" ? MusicalIdioms : require("./musicalIdiomEngine");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Grammar = typeof RhythmicGrammar !== "undefined" ? RhythmicGrammar : require("./rhythmicGrammar");
  const productionRules = Object.freeze([
    { id: "filter-sweep-display", path: "productionEvidence.filterSweep", min: 0.7 },
    { id: "sidechain-display", path: "productionEvidence.sidechain", min: 0.7 },
    { id: "sample-based-display", path: "productionEvidence.sampleBased", min: 0.7 },
    { id: "vocal-chop-display", path: "productionEvidence.vocalChop", min: 0.7 },
    { id: "stereo-width-display", path: "productionEvidence.stereoWidth", min: 0.7 },
    { id: "reverb-display", path: "productionEvidence.reverb", min: 0.7 }
  ]);

  function rhythmCandidates(grammar = {}) {
    return (Array.isArray(grammar.candidates) && grammar.candidates.length
      ? grammar.candidates : Grammar.candidatesFromEvidence(grammar)).map(item => ({ ...item, source: "rhythm" }));
  }

  function productionCandidates(evidence = {}) {
    const candidates = [];
    const add = (text, field, confidence, extraAnchors = []) => candidates.push(Facets.token(text, "production", confidence,
      ["productionEvidence." + field, ...extraAnchors], { source: "production" }));
    if (evidence.filterSweep >= 0.7) add("필터 스윕 가능성", "filterSweep", evidence.filterSweep,
      ["measurements.deltaCentroid"]);
    if (evidence.sidechain >= 0.7) add("사이드체인 펌핑", "sidechain", evidence.sidechain,
      ["rhythmicGrammar.fourOnFloor"]);
    if (evidence.sampleBased >= 0.7) add("샘플 기반", "sampleBased", evidence.sampleBased,
      ["trackContext.memory"]);
    if (evidence.vocalChop >= 0.7) add("보컬 찹", "vocalChop", evidence.vocalChop,
      ["instrumentationEvidence.voice"]);
    if (evidence.stereoWidth >= 0.7) add("스테레오 확장", "stereoWidth", evidence.stereoWidth,
      ["space.spaciousness"]);
    if (evidence.reverb >= 0.7) add("리버브 중심", "reverb", evidence.reverb,
      ["space.perceivedDepth"]);
    return candidates;
  }

  function ensureInstrumentation(state) {
    if (state.instrumentation?.observed?.length) return state.instrumentation;
    const observed = Instruments.normalize((state.instruments || []).filter(item => item.source !== "dsp"));
    const total = observed.reduce((sum, item) => sum + item.confidence, 0);
    observed.forEach(item => { item.dominance = item.confidence / Math.max(0.001, total); });
    // Anything the caller already knows about instrumentation (e.g. instrumentationEventEngine's
    // leadTransitionRate) survives the rollup instead of being silently dropped.
    const { observed: _ignored, ...supplied } = state.instrumentation || {};
    return { observed, families: Instruments.familyRollup(observed),
      dominanceDispersion: Instruments.dominanceDispersion(observed),
      confidence: observed[0]?.confidence || 0, resolution: "model classes; no source separation", ...supplied };
  }

  function populate(state = {}, { arrangementEngine = null, idiomEngine = null } = {}) {
    state.instrumentation = ensureInstrumentation(state);
    state.rhythmFacetCandidates = rhythmCandidates(state.rhythmicGrammar);
    state.productionFacetCandidates = productionCandidates(state.productionEvidence);
    state.instrumentFacetCandidates = Instruments.candidateTokens(state.instrumentation.observed,
      state.instrumentEvents || [], state.performance || {});
    const arrangement = (arrangementEngine || new Arrangement.Engine()).update(
      { ...state.instrumentation, density: state.arrangement?.density,
        verifiedEnsembleSize: state.arrangement?.verifiedEnsembleSize }, state.trackCharacter || {});
    state.arrangement = { ...(state.arrangement || {}), ...arrangement };
    state.arrangementFacetCandidates = arrangement.candidates;
    state.primitives = Primitives.analyze(state);
    state.primitiveObservationCandidates = Observations.generate(state.primitives);
    // Genre-conditioned wording in the legacy lexicon contains developer-authored genre names.
    // Keep only genre-neutral idioms; model-owned genre output remains available separately in
    // CONTEXT and never changes a local FACT label through a lookup table.
    state.detectedIdioms = (idiomEngine || new Idioms.Engine()).evaluate(state.primitives, {});
    // The local engine measures mood-related axes but does not turn them into subjective
    // language. IMPRESSION belongs to Music Flamingo's direct-listening packet (and, later,
    // an optional external interpreter fed by that packet).
    state.impressionConcepts = [];
    state.impressionFacetCandidates = [];
    const Composition = typeof LanguageComposition !== "undefined" ? LanguageComposition : require("./languageComposition");
    return Composition.apply(state);
  }

  function sourceCounts(candidates = []) {
    const names = ["primitive", "primitive-observation", "idiom", "rhythm", "instrument", "production", "arrangement"];
    return Object.fromEntries(names.map(name => [name, candidates.filter(item =>
      Layers.decorate(item).layer === "FACT" && item.source === name).length]));
  }

  return { populate, rhythmCandidates, productionCandidates, ensureInstrumentation, sourceCounts, productionRules,
    primitiveConsumerPaths: Observations.consumerPaths };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SemanticCandidatePipeline;
