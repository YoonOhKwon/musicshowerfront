// ProgressiveListeningEngine: Replaces rigid elapsed-time gates with dynamic, continuous
// Progressive Listening Maturity metrics.
//
// Calculates continuous readiness in [0, 1] for each epistemic layer:
//   - factReadiness: fast physical/acoustic/rhythmic/instrumental observation
//   - genreReadiness: stable tradition/genre hypothesis grounded in multi-axis evidence
//   - contextReadiness: historical, scene, lineage, and era connection
//   - aestheticReadiness: cultural, sensory, and visual aesthetic world
//   - impressionReadiness: holistic emotional synthesis of 2+ musical dimensions
//
// On section change / semantic epoch shift:
//   - Temporarily elevates LIVE and FACT layers for "re-interpretation" without wiping track memory.
//   - Allows interpretive layers to smoothly recover as evidence for the new section accumulates.
//
// FACT maintains a stable floor late in the song so sudden physical changes are always spoken.

const ProgressiveListening = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  class Engine {
    constructor(options = {}) {
      this.options = {
        minFactSeconds: 3,
        minContextGenreReadiness: 0.38,
        minAestheticContextReadiness: 0.32,
        reinterpretationDurationMs: 8000,
        ...options
      };
      this.reset();
    }

    reset() {
      this.readiness = {
        live: 1.0,
        fact: 0.2,
        genre: 0.0,
        context: 0.0,
        aesthetic: 0.0,
        impression: 0.0
      };
      this.reinterpretation = {
        active: false,
        startedAt: 0,
        factor: 1.0
      };
      this.deepListenEvidence = {
        count: 0,
        lastArrivalAt: 0,
        freshness: 0,
        genreRichness: 0,
        contextRichness: 0,
        aestheticRichness: 0,
        impressionRichness: 0,
        audibleRichness: 0
      };
      this.history = [];
    }

    // Called on new Flamingo deep-listen packet arrival
    noteDeepListen(observationId, packetOrAt = {}, maybeAt = Date.now()) {
      let packet = {};
      let at = Date.now();
      if (typeof packetOrAt === "number") {
        at = packetOrAt;
        packet = {};
      } else if (typeof packetOrAt === "object" && packetOrAt !== null) {
        packet = packetOrAt;
        at = typeof maybeAt === "number" ? maybeAt : Date.now();
      }

      this.deepListenEvidence.count += 1;
      this.deepListenEvidence.lastArrivalAt = at;
      this.deepListenEvidence.freshness = 1.0;

      const hasCategories = Array.isArray(packet.genreHypotheses) ||
        Array.isArray(packet.contextHypotheses) ||
        Array.isArray(packet.aestheticConcepts) ||
        Array.isArray(packet.impressions) ||
        Array.isArray(packet.audibleObservations);

      if (hasCategories) {
        const genreCount = Array.isArray(packet.genreHypotheses) ? packet.genreHypotheses.length : 0;
        const contextCount = Array.isArray(packet.contextHypotheses) ? packet.contextHypotheses.length : 0;
        const aestheticCount = Array.isArray(packet.aestheticConcepts) ? packet.aestheticConcepts.length : 0;
        const impressionCount = Array.isArray(packet.impressions) ? packet.impressions.length : 0;
        const audibleCount = Array.isArray(packet.audibleObservations) ? packet.audibleObservations.length : 0;

        this.deepListenEvidence.genreRichness = clamp(genreCount / 2);
        this.deepListenEvidence.contextRichness = clamp(contextCount / 2);
        this.deepListenEvidence.aestheticRichness = clamp(aestheticCount / 2);
        this.deepListenEvidence.impressionRichness = clamp(impressionCount / 2);
        this.deepListenEvidence.audibleRichness = clamp(audibleCount / 3);
      } else {
        this.deepListenEvidence.genreRichness = 1.0;
        this.deepListenEvidence.contextRichness = 0.8;
        this.deepListenEvidence.aestheticRichness = 1.0;
        this.deepListenEvidence.impressionRichness = 0.8;
        this.deepListenEvidence.audibleRichness = 1.0;
      }
    }

    // Update readiness based on real acoustic, semantic, and temporal evidence
    update(context = {}, at = Date.now()) {
      const {
        state = {},
        observationSeconds = 0,
        semanticChange = false,
        sectionChange = false,
        deepListenFreshness = null
      } = context;

      // Handle re-interpretation triggers (section transition or large semantic epoch shift)
      if (semanticChange || sectionChange) {
        this.reinterpretation.active = true;
        this.reinterpretation.startedAt = at;
        this.reinterpretation.factor = 0.45; // dampens higher layers temporarily
      } else if (this.reinterpretation.active) {
        const elapsed = at - this.reinterpretation.startedAt;
        if (elapsed >= this.options.reinterpretationDurationMs) {
          this.reinterpretation.active = false;
          this.reinterpretation.factor = 1.0;
        } else {
          // Smooth recovery back to 1.0
          this.reinterpretation.factor = 0.45 + 0.55 * (elapsed / this.options.reinterpretationDurationMs);
        }
      }

      // Update deep-listen freshness decay
      if (deepListenFreshness !== null) {
        this.deepListenEvidence.freshness = clamp(deepListenFreshness);
      } else if (this.deepListenEvidence.lastArrivalAt > 0) {
        const deepAge = (at - this.deepListenEvidence.lastArrivalAt) / 1000;
        this.deepListenEvidence.freshness = clamp(Math.exp(-deepAge / 60));
      }

      // 1. FACT READINESS: scales with acoustic transient stability, rhythm grid, primitives
      const timeRamp = clamp(observationSeconds / this.options.minFactSeconds);
      const rhythmConfidence = clamp(state.rhythm?.bpmConfidence ?? state.audio?.tempoConfidence ?? 0.5);
      const primitiveCount = Object.keys(state.primitives || {}).length;
      const primitiveCoverage = clamp(primitiveCount / 8);
      const rawFactReadiness = clamp(timeRamp * 0.45 + rhythmConfidence * 0.3 + primitiveCoverage * 0.25);
      this.readiness.fact = Math.max(0.2, rawFactReadiness);

      // 2. GENRE READINESS: based on classifier confidence, entropy, margin, independent evidence, open-world
      const genre = state.genre || state.classifierGenre || {};
      const primaryConfidence = clamp(genre.confidence ?? genre.semanticConfidence ?? 0);
      const entropy = clamp(genre.entropy ?? (genre.uncertain ? 0.9 : 0.4));
      const margin = clamp(genre.margin ?? 0.2);
      const genreReasoning = state.genreReasoning || {};
      const independentFamilies = genreReasoning.primary?.independentEvidenceCount ?? 1;
      const independentBoost = clamp(independentFamilies / 3);
      const genreStability = clamp(genreReasoning.primary?.temporalStability ?? (observationSeconds >= 15 ? 0.6 : 0.2));

      // Open-world concepts also contribute to genre readiness if present
      const openWorldGenres = (state.openWorldConcepts || []).filter(c => c.conceptType === "genre" || c.conceptType === "microgenre");
      const openWorldMaxConf = openWorldGenres.length ? Math.max(...openWorldGenres.map(c => c.confidence || 0)) : 0;

      let rawGenreReadiness = clamp(
        Math.max(primaryConfidence, openWorldMaxConf * 0.85) * 0.35 +
        (1 - entropy) * 0.25 +
        margin * 0.15 +
        independentBoost * 0.15 +
        genreStability * 0.10
      );
      if (genre.uncertain && openWorldMaxConf < 0.6) rawGenreReadiness *= 0.45;
      this.readiness.genre = rawGenreReadiness * this.reinterpretation.factor;

      // 3. CONTEXT READINESS: continuous and independent
      // Can emerge from production style, recording aesthetic, rhythmic idiom, lineage, or Flamingo
      // even when genre classification is still tentative.
      const contextEvidenceCount = (state.genreContextEvidence?.candidates?.length || state.genreContextEvidence?.length || 0) +
        (genreReasoning.relations?.length || 0) +
        (state.openWorldConcepts || []).filter(c => ["scene", "era", "culture", "lineage", "production-style"].includes(c.conceptType)).length;
      const contextSupport = clamp(contextEvidenceCount / 3);
      const contextTemporalRamp = clamp(observationSeconds / 20);
      const genreContribution = this.readiness.genre * 0.35;
      const directAudioContextBoost = (this.deepListenEvidence.count > 0 ? (0.40 * (this.deepListenEvidence.contextRichness ?? 0.5)) * this.deepListenEvidence.freshness : 0);

      if (contextSupport === 0 && directAudioContextBoost === 0 && genreContribution < 0.15) {
        this.readiness.context = 0;
      } else {
        this.readiness.context = clamp(
          contextSupport * 0.40 +
          directAudioContextBoost * 0.35 +
          genreContribution +
          contextTemporalRamp * 0.15
        ) * this.reinterpretation.factor;
      }

      // 4. AESTHETIC READINESS: continuous multi-feature synthesis
      const aestheticEvidence = state.aestheticEvidence || {};
      const aestheticCount = Object.keys(aestheticEvidence).length +
        (state.openWorldConcepts || []).filter(c => c.conceptType === "aesthetic").length;
      const aestheticSupport = clamp(aestheticCount / 3);
      const deepListenAestheticBoost = this.deepListenEvidence.count > 0 ? (0.2 + 0.8 * (this.deepListenEvidence.aestheticRichness ?? 0.5)) * this.deepListenEvidence.freshness : 0;
      const aestheticTemporalRamp = clamp(observationSeconds / 30);

      if (aestheticSupport === 0 && deepListenAestheticBoost === 0 && this.readiness.context < 0.2) {
        this.readiness.aesthetic = 0;
      } else {
        this.readiness.aesthetic = clamp(
          deepListenAestheticBoost * 0.45 +
          aestheticSupport * 0.30 +
          this.readiness.context * 0.20 +
          aestheticTemporalRamp * 0.10
        ) * this.reinterpretation.factor;
      }

      // 5. IMPRESSION READINESS: holistic emotional and sensory synthesis
      const mood = state.moodDimensions || state.mood || {};
      const localMood = state.mood?.local || state.mood || {};
      const hasMood = (localMood.valence !== undefined && localMood.arousal !== undefined);
      const impressionConcepts = (state.impressionConcepts?.length || 0) +
        (state.openWorldConcepts || []).filter(c => c.conceptType === "impression").length;
      const impressionSupport = clamp(impressionConcepts / 2);
      const deepListenImpressionBoost = this.deepListenEvidence.count > 0 ? (0.2 + 0.8 * (this.deepListenEvidence.impressionRichness ?? 0.5)) * this.deepListenEvidence.freshness : 0;
      const impressionTemporalRamp = clamp(observationSeconds / 35);

      if (!hasMood && deepListenImpressionBoost === 0 && impressionSupport === 0) {
        this.readiness.impression = 0;
      } else if (observationSeconds < 3 && deepListenImpressionBoost === 0) {
        this.readiness.impression = 0;
      } else {
        this.readiness.impression = clamp(
          impressionSupport * 0.35 +
          deepListenImpressionBoost * 0.35 +
          this.readiness.aesthetic * 0.20 +
          (hasMood ? 0.10 : 0) +
          impressionTemporalRamp * 0.10
        ) * this.reinterpretation.factor;
      }

      return { ...this.readiness, reinterpretationFactor: this.reinterpretation.factor };
    }

    // Calculates sampling weights across LIVE, FACT, CONTEXT, AESTHETIC, IMPRESSION
    // Guarantees FACT never starves, even in deep immersion.
    getLayerWeights(options = {}) {
      const changing = options.changing || this.reinterpretation.active;
      if (changing) {
        return { LIVE: 0.44, FACT: 0.40, CONTEXT: 0.08, AESTHETIC: 0.04, IMPRESSION: 0.04 };
      }

      // Early initial period before higher layers open: LIVE and FACT divide 100% of space
      if (this.readiness.context === 0 && this.readiness.aesthetic === 0 && this.readiness.impression === 0) {
        const live = clamp(0.55 - this.readiness.fact * 0.15);
        return { LIVE: live, FACT: 1 - live, CONTEXT: 0, AESTHETIC: 0, IMPRESSION: 0 };
      }

      // Scale shares according to readiness
      const liveShare = 0.06 + Math.max(0, 0.44 * (1 - this.readiness.fact));
      const factFloor = 0.30; // FACT is always guaranteed space
      const factShare = factFloor + Math.max(0, 0.20 * (1 - this.readiness.genre));

      const contextRaw = this.readiness.context * 0.22;
      const aestheticRaw = this.readiness.aesthetic * 0.25;
      const impressionRaw = this.readiness.impression * 0.25;

      const total = liveShare + factShare + contextRaw + aestheticRaw + impressionRaw;

      return {
        LIVE: clamp(liveShare / total),
        FACT: clamp(factShare / total),
        CONTEXT: clamp(contextRaw / total),
        AESTHETIC: clamp(aestheticRaw / total),
        IMPRESSION: clamp(impressionRaw / total)
      };
    }
  }

  return { Engine };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ProgressiveListening;
}
