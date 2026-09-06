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
        maxRecordsPerConcept: options.maxRecordsPerConcept || 50,
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
      const obsId = observation.observationId || null;
      const audioSegId = observation.audioSegmentId || null;
      const indGroup = observation.independenceGroup || obsId || `grp-${at}-${Math.random().toString(36).slice(2, 6)}`;

      if (!node) {
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

      // Track distinct independence groups: claims sharing the same independenceGroup
      // do NOT multiply independent corroboration!
      node.independenceGroups.add(indGroup);

      // Track temporal support: distinct audio segments or distinct observation captures
      if (audioSegId) node.seenAudioSegments.add(audioSegId);
      if (obsId) node.seenObservationIds.add(obsId);

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
        node.temporalSupport >= 1 ||
        node.independenceGroups.size >= 2
      ) {
        node.status = "provisional";
      } else {
        node.status = "emerging";
      }

      this.revisions++;
      return this._formatNode(node);
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

    all() {
      return [...this.concepts.values()].map(node => this._formatNode(node));
    }

    byType(conceptType) {
      return this.all().filter(item => item.conceptType === conceptType);
    }

    _formatNode(node) {
      return {
        ...node,
        sources: [...node.sources],
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
