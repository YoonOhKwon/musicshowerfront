// OpenWorldConceptRegistry: Session-local belief state registry for open-world concepts.
// Unregistered genres, microgenres, scenes, eras, aesthetics, and impressions are treated
// as first-class citizens rather than fallbacks.
//
// Concepts advance through continuous, reversible belief states:
//   - emerging: initial hypothesis, qualified in language (e.g. "~ 가능성", "~ 연상")
//   - provisional: multi-observation or multi-source support (e.g. "~ 계열", "~ 문법", "~ 감성")
//   - stable: high confidence, corroborated by temporal/multimodal evidence
//   - weakened: decaying, contradicted, or demoted evidence
//
// Absence from local static taxonomy NEVER implies concept rejection (conceptInvalid = false).

const OpenWorldConceptRegistry = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const normalize = text => String(text || "").toLowerCase().replace(/[\s_&-]+/g, "");

  const STATUSES = Object.freeze(["emerging", "provisional", "stable", "weakened"]);
  const RELATION_TYPES = Object.freeze(["influence", "lineage", "hybrid", "subgenre", "samples", "aesthetic-world"]);

  class Registry {
    constructor(options = {}) {
      this.options = {
        decayHalfLifeMs: options.decayHalfLifeMs || 60000,
        stableMinConfidence: options.stableMinConfidence || 0.72,
        provisionalMinConfidence: options.provisionalMinConfidence || 0.50,
        stableMinTemporalSupport: options.stableMinTemporalSupport || 2,
        maxRecordsPerConcept: options.maxRecordsPerConcept || 16,
        maxEvidenceIdentities: options.maxEvidenceIdentities || 48,
        maxConcepts: options.maxConcepts || 180,
        ...options
      };
      this.reset();
    }

    reset() {
      this.concepts = new Map(); // key -> concept node
      this.revisions = 0;
    }

    keyFor(label, type) {
      return `${type || "genre"}:${normalize(label)}`;
    }

    _trimSet(values) {
      while (values.size > this.options.maxEvidenceIdentities) {
        values.delete(values.values().next().value);
      }
    }

    _evictWeakest(at = Date.now()) {
      if (this.concepts.size < this.options.maxConcepts) return;
      const statusWeight = { weakened: 0, emerging: 0.12, provisional: 0.28, stable: 0.5 };
      let weakestKey = null;
      let weakestScore = Infinity;
      for (const [key, node] of this.concepts) {
        const freshness = Math.max(0, 1 - (at - node.lastSeenAt) / 900000);
        const score = (statusWeight[node.status] || 0) + node.confidence * 0.35 + freshness * 0.25;
        if (score < weakestScore) {
          weakestKey = key;
          weakestScore = score;
        }
      }
      if (!weakestKey) return;
      this.concepts.delete(weakestKey);
      for (const node of this.concepts.values()) node.relations.delete(weakestKey);
    }

    // Register or update an open-world concept hypothesis
    // observation: {
    //   label: string,
    //   conceptType: "genre" | "microgenre" | "scene" | "era" | "culture" | "lineage" | "aesthetic" | "impression" | "production-style",
    //   source: string | string[],
    //   sourceFamily?: string,
    //   sourceModel?: string,
    //   observationId?: string,
    //   audioSegmentId?: string,
    //   independenceGroup?: string,
    //   confidence: number,
    //   supportingEvidence?: any[],
    //   contradictions?: any[],
    //   reasoningHints?: string
    // }
    propose(observation = {}, at = Date.now()) {
      const label = String(observation.label || "").trim();
      if (!label) return null;
      const conceptType = observation.conceptType || "genre";
      const key = this.keyFor(label, conceptType);

      let node = this.concepts.get(key);
      const incomingConfidence = clamp(observation.confidence ?? 0.55);
      const sources = Array.isArray(observation.source) ? observation.source : [observation.source || "unknown"];
      const sourceFamily = observation.sourceFamily || (sources[0] || "unknown");
      const conditionedOnClassifier = Boolean(observation.conditionedOnClassifier);
      const conditioningSources = Array.isArray(observation.conditioningSources)
        ? observation.conditioningSources.map(String).filter(Boolean).slice(0, 4) : [];
      const conditioningCandidateLabels = Array.isArray(observation.conditioningCandidateLabels)
        ? observation.conditioningCandidateLabels.map(String).filter(Boolean).slice(0, 5) : [];
      const obsId = observation.observationId || null;
      const audioSegId = observation.audioSegmentId || null;
      const indGroup = observation.independenceGroup || obsId || `grp-${at}-${Math.random().toString(36).slice(2, 6)}`;

      if (!node) {
        this._evictWeakest(at);
        node = {
          id: key,
          canonicalLabel: label,
          conceptType,
          openWorld: true,
          firstSeenAt: at,
          lastSeenAt: at,
          seenObservationIds: new Set(),
          seenAudioSegments: new Set(),
          independenceGroups: new Set(),
          sources: new Set(sources),
          conditioningSources: new Set(),
          conditioningCandidateLabels: new Set(),
          hasConditionedDeepListen: false,
          hasIndependentDeepListen: false,
          confidence: incomingConfidence,
          peakConfidence: incomingConfidence,
          temporalSupport: 0,
          evidenceRecords: [],
          contradictions: [],
          relations: new Map(), // targetKey -> { targetId, relationType, confidence, updatedAt }
          status: "emerging",
          reasoningHints: observation.reasoningHints || ""
        };
        this.concepts.set(key, node);
      } else {
        node.lastSeenAt = at;
        for (const s of sources) node.sources.add(s);
        if (observation.reasoningHints) node.reasoningHints = observation.reasoningHints;
      }

      for (const source of conditioningSources) node.conditioningSources.add(source);
      for (const label of conditioningCandidateLabels) node.conditioningCandidateLabels.add(label);
      this._trimSet(node.conditioningSources);
      this._trimSet(node.conditioningCandidateLabels);
      const isDeepListen = sourceFamily === "directAudio" || sources.includes("directAudio") ||
        observation.sourceModel === "music-flamingo";
      if (isDeepListen && conditionedOnClassifier) node.hasConditionedDeepListen = true;
      if (isDeepListen && !conditionedOnClassifier) node.hasIndependentDeepListen = true;

      // Track distinct independence groups: claims sharing the same independenceGroup
      // do NOT multiply independent corroboration!
      node.independenceGroups.add(indGroup);
      this._trimSet(node.independenceGroups);

      // Track temporal support: distinct audio segments or distinct observation captures
      if (audioSegId) node.seenAudioSegments.add(audioSegId);
      if (obsId) node.seenObservationIds.add(obsId);
      this._trimSet(node.seenAudioSegments);
      this._trimSet(node.seenObservationIds);

      // Temporal support count is based on distinct captures/segments
      const distinctTemporalCaptures = Math.max(node.seenAudioSegments.size, node.seenObservationIds.size);
      if (distinctTemporalCaptures > 0) {
        node.temporalSupport = distinctTemporalCaptures;
      } else if (at - node.firstSeenAt > 10000 && node.temporalSupport === 0) {
        node.temporalSupport = 1;
      }

      // Create first-class evidence record
      const evidenceRecord = {
        evidenceId: observation.evidenceId || `ev-${at}-${Math.random().toString(36).slice(2, 7)}`,
        conceptId: key,
        sourceFamily,
        sourceModel: observation.sourceModel || "unknown",
        observationId: obsId,
        audioSegmentId: audioSegId,
        timestamp: at,
        claim: label,
        confidence: incomingConfidence,
        evidenceType: observation.evidenceType || conceptType,
        independenceGroup: indGroup,
        conditionedOnClassifier,
        conditioningSources,
        conditioningCandidateLabels,
        supportingFeatures: Array.isArray(observation.supportingEvidence) ? observation.supportingEvidence : [],
        contradictingFeatures: Array.isArray(observation.contradictions) ? observation.contradictions : []
      };

      node.evidenceRecords.push(evidenceRecord);
      if (node.evidenceRecords.length > this.options.maxRecordsPerConcept) {
        node.evidenceRecords = node.evidenceRecords.slice(-this.options.maxRecordsPerConcept);
      }

      // Add contradictions
      if (Array.isArray(observation.contradictions) && observation.contradictions.length > 0) {
        node.contradictions = [...node.contradictions, ...observation.contradictions].slice(-15);
      }

      // Blend confidence:
      // - Contradiction penalty: strongly penalizes conflicts with physical acoustic measurements
      // - Contradictions also suppress past temporal and cross-group bonuses
      // - Cross-independence-group boost: rewards genuinely distinct inference runs/channels
      // - Temporal boost: rewards persistence across distinct audio segments
      const contradictionCount = node.contradictions.length;
      const contradictionPenalty = Math.min(0.55, contradictionCount * 0.22);
      const contradictionSuppression = contradictionCount > 0 ? 0.35 : 1.0;
      const temporalBoost = Math.min(0.20, (node.temporalSupport - 1) * 0.08) * contradictionSuppression;
      const distinctGroupCount = node.independenceGroups.size;
      const crossGroupBoost = Math.min(0.18, Math.max(0, distinctGroupCount - 1) * 0.06) * contradictionSuppression;

      const blended = node.confidence * 0.65 + incomingConfidence * 0.35;
      node.confidence = clamp(blended + temporalBoost + crossGroupBoost - contradictionPenalty);
      node.peakConfidence = Math.max(node.peakConfidence, node.confidence);

      // Determine belief status (reversible!)
      if (node.contradictions.length >= 3 || (node.contradictions.length >= 2 && node.confidence < 0.35)) {
        node.status = "weakened";
      } else if (
        node.confidence >= this.options.stableMinConfidence &&
        node.temporalSupport >= this.options.stableMinTemporalSupport &&
        node.contradictions.length === 0
      ) {
        node.status = "stable";
      } else if (
        node.confidence >= this.options.provisionalMinConfidence ||
        node.temporalSupport >= 2 ||
        node.independenceGroups.size >= 2
      ) {
        node.status = "provisional";
      } else {
        node.status = "emerging";
      }

      this.revisions++;
      return this._formatNode(node);
    }

    // World-knowledge concept expansion (see docs -- "UNKNOWN GENRE -> discovered concept ->
    // semantic neighborhood -> track-specific interpretation"). Fires at most once per concept
    // (node.expansionRequested guards re-entry) and never injects a fact directly: every expanded
    // item enters through the SAME propose() path as any other observation, at low "emerging"
    // confidence, so current audio/Flamingo evidence still has to corroborate it before it can
    // become stable or surface in language. World knowledge proposes; evidence decides.
    //
    // expansions: { scene: [...], lineage: [...], culture: [...], era: [...],
    //               productionTraits: [...], aestheticAssociations: [...] }
    // Each item is a string or { text, confidence }.
    proposeExpansion(labelOrKey, expansions = {}, at = Date.now()) {
      const key = labelOrKey.includes(":") ? labelOrKey : this.keyFor(labelOrKey, "genre");
      const node = this.concepts.get(key);
      if (!node) return null;
      if (node.expansionRequested) return this.constellation(key);
      node.expansionRequested = true;

      const CATEGORY_TO_TYPE = {
        scene: "scene", lineage: "lineage", culture: "culture", era: "era",
        productionTraits: "production-style", aestheticAssociations: "aesthetic"
      };
      const CATEGORY_TO_RELATION = {
        scene: "lineage", lineage: "lineage", culture: "lineage", era: "lineage",
        productionTraits: "influence", aestheticAssociations: "aesthetic-world"
      };

      for (const [category, items] of Object.entries(expansions || {})) {
        const conceptType = CATEGORY_TO_TYPE[category];
        const relationType = CATEGORY_TO_RELATION[category];
        if (!conceptType || !Array.isArray(items)) continue;
        for (const item of items.slice(0, 4)) {
          const label = String(typeof item === "string" ? item : item?.text || "").trim();
          if (!label) continue;
          const confidence = Math.min(0.45, clamp(typeof item === "object" ? (item?.confidence ?? 0.35) : 0.35));
          this.propose({
            label, conceptType, source: "world-knowledge-expansion", sourceFamily: "world-knowledge",
            sourceModel: "llm-expansion", confidence, observationId: `expand-${key}-${at}`
          }, at);
          // Pass fully-qualified keys directly -- relate()'s plain-label lookup assumes conceptType
          // "genre", which would silently miss a "scene"/"aesthetic"/etc. target.
          this.relate(key, this.keyFor(label, conceptType), relationType, confidence, at);
        }
      }
      return this.constellation(key);
    }

    // Connect two concepts into a constellation relation (e.g. Future Funk has influence French House)
    relate(fromLabelOrKey, toLabelOrKey, relationType = "influence", confidence = 0.7, at = Date.now()) {
      const fromKey = fromLabelOrKey.includes(":") ? fromLabelOrKey : this.keyFor(fromLabelOrKey, "genre");
      const toKey = toLabelOrKey.includes(":") ? toLabelOrKey : this.keyFor(toLabelOrKey, "genre");

      const fromNode = this.concepts.get(fromKey);
      if (!fromNode) return false;

      fromNode.relations.set(toKey, {
        targetId: toKey,
        relationType,
        confidence: clamp(confidence),
        updatedAt: at
      });
      this.revisions++;
      return true;
    }

    // Demote an existing hypothesis (e.g. French House downgraded from primary to influence)
    demote(labelOrKey, targetStatus = "provisional", reason = "takeover-or-contradiction", at = Date.now()) {
      const key = labelOrKey.includes(":") ? labelOrKey : this.keyFor(labelOrKey, "genre");
      const node = this.concepts.get(key);
      if (!node) return null;

      node.status = targetStatus;
      node.lastSeenAt = at;
      if (targetStatus === "weakened") {
        node.confidence = Math.min(node.confidence, 0.40);
      } else if (targetStatus === "provisional") {
        node.confidence = Math.min(node.confidence, 0.65);
      }
      this.revisions++;
      return this._formatNode(node);
    }

    // Retrieve full constellation for a concept (node + its related concepts)
    constellation(labelOrKey) {
      const key = labelOrKey.includes(":") ? labelOrKey : this.keyFor(labelOrKey, "genre");
      const node = this.concepts.get(key);
      if (!node) return null;

      const related = [];
      for (const [targetKey, rel] of node.relations.entries()) {
        const targetNode = this.concepts.get(targetKey);
        related.push({
          ...rel,
          concept: targetNode ? this._formatNode(targetNode) : null
        });
      }

      return {
        concept: this._formatNode(node),
        relations: related
      };
    }

    // Apply temporal decay to concepts that haven't been re-observed
    tick(at = Date.now()) {
      for (const [key, node] of this.concepts.entries()) {
        const ageMs = at - node.lastSeenAt;
        if (ageMs > this.options.decayHalfLifeMs) {
          const decayFactor = Math.exp(-ageMs / (this.options.decayHalfLifeMs * 2));
          node.confidence = clamp(node.confidence * decayFactor);
          if (node.confidence < 0.40 && node.status === "stable") {
            node.status = "provisional"; // Reversible: stable drops to provisional
          } else if (node.confidence < 0.30 && node.status !== "weakened") {
            node.status = "weakened";
          }
        }
        // Purge dead concepts after 15 minutes without refresh
        if (ageMs > 900000 && node.confidence < 0.2) {
          this.concepts.delete(key);
        }
      }
    }

    // Linguistic framing based on epistemic confidence & status
    realizePhrase(conceptOrKey, defaultSuffix = "") {
      const node = typeof conceptOrKey === "string" ? this.concepts.get(conceptOrKey) : conceptOrKey;
      if (!node) return null;
      const label = node.canonicalLabel;

      switch (node.status) {
        case "stable":
          return defaultSuffix ? `${label} ${defaultSuffix}` : label;
        case "provisional":
          if (node.conceptType === "genre" || node.conceptType === "microgenre") return `${label} 계열`;
          if (node.conceptType === "scene" || node.conceptType === "culture") return `${label} 문법`;
          if (node.conceptType === "aesthetic" || node.conceptType === "impression") return `${label} 감성`;
          return `${label} 계열`;
        case "emerging":
          return `${label} 가능성`;
        case "weakened":
        default:
          return `${label} 연상`;
      }
    }

    get(label, type) {
      const node = this.concepts.get(this.keyFor(label, type));
      return node ? this._formatNode(node) : null;
    }

    all(options = {}) {
      return [...this.concepts.values()].map(node => this._formatNode(node, options.compact === true));
    }

    byType(conceptType) {
      return this.all().filter(item => item.conceptType === conceptType);
    }

    _formatNode(node, compact = false) {
      if (compact) {
        // The live semantic state is rebuilt roughly once per second. It needs belief metadata,
        // not every historical evidence record; omitting those large arrays prevents repeated
        // allocation churn while inspect()/get()/constellation() retain the full audit view.
        return {
          id: node.id,
          canonicalLabel: node.canonicalLabel,
          conceptType: node.conceptType,
          openWorld: node.openWorld,
          firstSeenAt: node.firstSeenAt,
          lastSeenAt: node.lastSeenAt,
          sources: [...node.sources],
          conditionedOnClassifier: node.hasConditionedDeepListen && !node.hasIndependentDeepListen,
          hasConditionedDeepListen: node.hasConditionedDeepListen,
          hasIndependentDeepListen: node.hasIndependentDeepListen,
          conditioningSources: [...node.conditioningSources],
          conditioningCandidateLabels: [...node.conditioningCandidateLabels],
          confidence: node.confidence,
          peakConfidence: node.peakConfidence,
          temporalSupport: node.temporalSupport,
          status: node.status,
          reasoningHints: node.reasoningHints,
          expansionRequested: Boolean(node.expansionRequested),
          // A compact, bounded view of the constellation. The genre engine needs to know what a
          // discovered name is RELATED to -- that is how an unseen label like "Future Funk" gets
          // corroborated against a classifier that can only say "City Pop" and "Nu Disco". The
          // full relations map stays out of the once-per-second state; this is label + type only.
          relatedLabels: [...node.relations.values()].slice(-10).map(relation => ({
            label: String(relation.targetId || "").split(":").slice(1).join(":"),
            type: relation.targetId ? String(relation.targetId).split(":")[0] : "genre",
            relationType: relation.relationType,
            confidence: relation.confidence
          })).filter(relation => relation.label),
          contradictions: node.contradictions.slice(-8)
        };
      }
      return {
        ...node,
        sources: [...node.sources],
        conditioningSources: [...node.conditioningSources],
        conditioningCandidateLabels: [...node.conditioningCandidateLabels],
        seenObservationIds: [...node.seenObservationIds],
        seenAudioSegments: [...node.seenAudioSegments],
        independenceGroups: [...node.independenceGroups],
        relations: Object.fromEntries(node.relations)
      };
    }
  }

  return { Registry, STATUSES, RELATION_TYPES };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = OpenWorldConceptRegistry;
}
