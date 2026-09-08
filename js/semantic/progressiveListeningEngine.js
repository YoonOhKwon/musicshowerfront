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
// FACT keeps an adaptive floor: prominent while the engine is learning, compact once several
// independent interpretive layers are genuinely ready, and immediately prominent on change.

const ProgressiveListening = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const conceptText = item => typeof item === "string" ? item
    : String(item?.text || item?.label || "");
  const conceptKey = item => conceptText(item).toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
  const uniqueCount = values => new Set((Array.isArray(values) ? values : [])
    .map(conceptKey).filter(Boolean)).size;

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
        audibleRichness: 0,
        packetCompleteness: 0,
        duplicateRatio: 0
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

      this.deepListenEvidence.lastArrivalAt = at;
      this.deepListenEvidence.freshness = 1.0;

      const hasCategories = Array.isArray(packet.genreHypotheses) ||
        Array.isArray(packet.contextHypotheses) ||
        Array.isArray(packet.aestheticConcepts) ||
        Array.isArray(packet.impressions) ||
        Array.isArray(packet.signatureRelations) ||
        Array.isArray(packet.audibleObservations);

      if (hasCategories) {
        const fields = ["genreHypotheses", "contextHypotheses", "aestheticConcepts", "impressions",
          "signatureRelations", "audibleObservations"];
        const rawCount = fields.reduce((sum, field) => sum + (Array.isArray(packet[field]) ? packet[field].length : 0), 0);
        const counts = Object.fromEntries(fields.map(field => [field, uniqueCount(packet[field])]));
        const uniqueTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
        if (uniqueTotal > 0) this.deepListenEvidence.count += 1;
        const genreCount = counts.genreHypotheses;
        const contextCount = counts.contextHypotheses;
        const aestheticCount = counts.aestheticConcepts;
        const impressionCount = counts.impressions;
        const audibleCount = counts.audibleObservations + counts.signatureRelations;

        this.deepListenEvidence.genreRichness = clamp(genreCount / 2);
        this.deepListenEvidence.contextRichness = clamp(contextCount / 2);
        this.deepListenEvidence.aestheticRichness = clamp(aestheticCount / 2);
        this.deepListenEvidence.impressionRichness = clamp(impressionCount / 2);
        this.deepListenEvidence.audibleRichness = clamp(audibleCount / 3);
        this.deepListenEvidence.packetCompleteness = fields.filter(field => counts[field] > 0).length / fields.length;
        this.deepListenEvidence.duplicateRatio = rawCount ? clamp((rawCount - uniqueTotal) / rawCount) : 0;
      } else {
        this.deepListenEvidence.genreRichness = 0;
        this.deepListenEvidence.contextRichness = 0;
        this.deepListenEvidence.aestheticRichness = 0;
        this.deepListenEvidence.impressionRichness = 0;
        this.deepListenEvidence.audibleRichness = 0;
        this.deepListenEvidence.packetCompleteness = 0;
        this.deepListenEvidence.duplicateRatio = 0;
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

      // 4. AESTHETIC READINESS: Flamingo aesthetic evidence only. Local genre/mood cannot open it.
      const flamingoAesthetic = this.deepListenEvidence.aestheticRichness || 0;
      const flamingoCoverage = clamp((this.deepListenEvidence.count || 0) / 2);
      const flamingoFresh = this.deepListenEvidence.freshness || 0;
      const aestheticSupport = flamingoAesthetic * flamingoCoverage * flamingoFresh;
      this.readiness.aesthetic = aestheticSupport > 0
        ? clamp(aestheticSupport) * this.reinterpretation.factor
        : 0;

      // 5. IMPRESSION READINESS: Flamingo impression evidence only.
      const flamingoImpression = this.deepListenEvidence.impressionRichness || 0;
      const impressionSupport = flamingoImpression * flamingoCoverage * flamingoFresh;
      this.readiness.impression = impressionSupport > 0
        ? clamp(impressionSupport) * this.reinterpretation.factor
        : 0;

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

      // Scale shares according to readiness. The former permanent 30% FACT floor made a mature
      // interpretation sound like a diagnostics panel forever. As context, aesthetic and
      // impression evidence converge, the floor eases toward ~15% of the normalized mix while
      // section changes still jump to the explicit 40% FACT re-interpretation profile above.
      const interpretiveMaturity = clamp((this.readiness.context + this.readiness.aesthetic + this.readiness.impression) / 3);
      const liveShare = 0.06 + Math.max(0, 0.44 * (1 - this.readiness.fact));
      const factFloor = 0.30 - 0.11 * interpretiveMaturity;
      const factShare = factFloor + Math.max(0, 0.20 * (1 - this.readiness.genre) * (1 - 0.65 * interpretiveMaturity));

      const contextRaw = this.readiness.context * (0.22 + 0.07 * interpretiveMaturity);
      const aestheticRaw = this.readiness.aesthetic * (0.25 + 0.12 * interpretiveMaturity);
      const impressionRaw = this.readiness.impression * (0.25 + 0.07 * interpretiveMaturity);

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
