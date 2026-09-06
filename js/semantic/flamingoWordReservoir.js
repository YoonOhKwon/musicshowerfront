// FlamingoWordReservoir: Track-scoped semantic reservoir that stores, categorizes,
// and rotates Music Flamingo concept realizations with repetition penalties and
// category quotas.
//
// Works in both Node.js and browser environments.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    const Realizer = require("./directAudioRealizer");
    module.exports = factory(Realizer);
  } else {
    root.FlamingoWordReservoir = factory(root.DirectAudioRealizer);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (DirectAudioRealizer) {
  const Realizer = DirectAudioRealizer || (typeof require !== "undefined" ? require("./directAudioRealizer") : null);

  class Reservoir {
    constructor(options = {}) {
      this.realizer = options.realizer || (Realizer ? Realizer.defaultRealizer : null);
      this.recentMemorySize = options.recentMemorySize || 16;
      this.reset(options.trackEpoch || 1);
    }

    reset(trackEpoch = 1) {
      this.trackEpoch = trackEpoch;
      this.pools = {
        fact: [],       // audibleObservations -> FACT
        genre: [],      // genreHypotheses -> FACT / CONTEXT
        context: [],    // contextHypotheses -> CONTEXT
        aesthetic: [],  // aestheticConcepts -> AESTHETIC
        impression: []  // impressions -> IMPRESSION
      };
      this.conceptRegistry = new Map(); // conceptKey -> { canonical, category, layer, confidence, family: [], temporalScope }
      this.rotationIndexes = new Map(); // conceptKey -> currentIndex
      this.recentSelections = [];       // [text1, text2, ...]
      this.packetCount = 0;
      this.lastPacketAt = 0;
    }

    // Ingest a Flamingo structured packet or raw direct audio review
    ingestPacket(packet = {}, metadata = {}) {
      const trackEpoch = metadata.trackEpoch !== undefined ? Number(metadata.trackEpoch) : this.trackEpoch;
      if (trackEpoch !== this.trackEpoch) {
        // Drop stale packet belonging to a different track epoch
        return false;
      }

      this.packetCount += 1;
      this.lastPacketAt = metadata.timestamp || Date.now();
      const observationId = metadata.observationId || `flam-${Date.now()}`;

      // Ingest each category
      const categories = [
        { key: "audibleObservations", poolKey: "fact", defaultLayer: "FACT", defaultScope: "SECTION", defaultConf: 0.70 },
        { key: "genreHypotheses", poolKey: "genre", defaultLayer: "CONTEXT", defaultScope: "TRACK", defaultConf: 0.65 },
        { key: "contextHypotheses", poolKey: "context", defaultLayer: "CONTEXT", defaultScope: "TRACK", defaultConf: 0.60 },
        { key: "aestheticConcepts", poolKey: "aesthetic", defaultLayer: "AESTHETIC", defaultScope: "TRACK", defaultConf: 0.65 },
        { key: "impressions", poolKey: "impression", defaultLayer: "IMPRESSION", defaultScope: "SECTION", defaultConf: 0.60 }
      ];

      for (const cat of categories) {
        const items = Array.isArray(packet[cat.key]) ? packet[cat.key] : [];
        for (const rawItem of items) {
          const text = typeof rawItem === "string" ? rawItem : (rawItem?.text || rawItem?.label || "");
          const conf = typeof rawItem === "object" && rawItem?.confidence !== undefined ? rawItem.confidence : cat.defaultConf;
          if (!text || typeof text !== "string") continue;

          this._addConcept({
            text,
            category: cat.poolKey,
            layer: cat.defaultLayer,
            confidence: conf,
            observationId,
            temporalScope: cat.defaultScope,
            trackEpoch: this.trackEpoch
          });
        }
      }

      return true;
    }

    _addConcept({ text, category, layer, confidence, observationId, temporalScope, trackEpoch }) {
      const normKey = Realizer ? Realizer.normalizeKey(text) : text.toLowerCase().trim();
      if (!normKey) return;

      // Realize to Korean family
      let family = [];
      if (this.realizer) {
        family = this.realizer.realize(text, category);
      } else if (DirectAudioRealizer) {
        family = DirectAudioRealizer.realize(text, category);
      }
      if (!family || !family.length) {
        family = [text];
      }

      let entry = this.conceptRegistry.get(normKey);
      if (!entry) {
        entry = {
          conceptKey: normKey,
          canonicalText: text,
          category,
          layer,
          confidence,
          family,
          temporalScope,
          observationId,
          trackEpoch,
          addedAt: Date.now(),
          usageCount: 0
        };
        this.conceptRegistry.set(normKey, entry);
        if (this.pools[category]) {
          this.pools[category].push(entry);
        }
        if (!this.rotationIndexes.has(normKey)) {
          this.rotationIndexes.set(normKey, 0);
        }
      } else {
        // Update existing entry with fresh confidence and observation
        entry.confidence = Math.max(entry.confidence, confidence);
        entry.observationId = observationId;
        // Merge any new realizations
        const existingFamily = new Set(entry.family);
        for (const variant of family) {
          existingFamily.add(variant);
        }
        entry.family = [...existingFamily];
      }
    }

    // Get current candidate tokens for display and selection
    getCandidates(options = {}) {
      const candidates = [];
      const now = Date.now();

      for (const [normKey, entry] of this.conceptRegistry.entries()) {
        const family = entry.family || [entry.canonicalText];
        const rotIdx = this.rotationIndexes.get(normKey) || 0;
        const displayText = family[rotIdx % family.length] || entry.canonicalText;

        // Calculate repetition penalty
        const recentCount = this.recentSelections.filter(t => t === displayText).length;
        const repetitionFactor = 1 / (1 + recentCount * 1.5);
        const effectiveWeight = Math.max(0.05, (entry.confidence || 0.6) * repetitionFactor);

        candidates.push({
          text: displayText,
          canonicalText: entry.canonicalText,
          conceptKey: normKey,
          category: entry.category,
          layer: entry.layer,
          source: "directAudio",
          sourceFamily: "directAudio",
          sourceModel: "music-flamingo",
          temporalScope: entry.temporalScope,
          confidence: entry.confidence,
          score: effectiveWeight,
          evidenceScore: entry.confidence,
          weight: effectiveWeight,
          requiresKoreanRealization: false, // Fully realized Korean phrase
          isDirectAudio: true,
          trackEpoch: this.trackEpoch,
          familyCount: family.length,
          rotationIndex: rotIdx
        });
      }

      return candidates;
    }

    // Advance rotation index for a concept after selection so the next display uses another variation
    rotate(conceptKey) {
      const normKey = Realizer ? Realizer.normalizeKey(conceptKey) : conceptKey.toLowerCase().trim();
      const current = this.rotationIndexes.get(normKey) || 0;
      this.rotationIndexes.set(normKey, current + 1);
    }

    // Record that a phrase was selected for display
    noteUsed(text) {
      if (!text) return;
      this.recentSelections.push(text);
      if (this.recentSelections.length > this.recentMemorySize) {
        this.recentSelections.shift();
      }

      // Check if this text belongs to any registered family
      for (const [normKey, entry] of this.conceptRegistry.entries()) {
        if (entry.family && entry.family.includes(text)) {
          entry.usageCount = (entry.usageCount || 0) + 1;
          this.rotate(normKey);
          break;
        }
      }
    }

    // Diagnostic inspection snapshot
    inspect() {
      return {
        trackEpoch: this.trackEpoch,
        packetCount: this.packetCount,
        lastPacketAt: this.lastPacketAt,
        totalConcepts: this.conceptRegistry.size,
        poolCounts: {
          fact: this.pools.fact.length,
          genre: this.pools.genre.length,
          context: this.pools.context.length,
          aesthetic: this.pools.aesthetic.length,
          impression: this.pools.impression.length
        },
        recentSelections: [...this.recentSelections]
      };
    }
  }

  const defaultReservoir = new Reservoir();

  return {
    Reservoir,
    defaultReservoir
  };
});
