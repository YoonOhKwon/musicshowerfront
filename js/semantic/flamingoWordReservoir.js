// FlamingoWordReservoir: Track-scoped semantic reservoir that stores, categorizes,
// and rotates Music Flamingo concept realizations with repetition penalties and
// category quotas.
//
// Works in both Node.js and browser environments.

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    const Realizer = require("./directAudioRealizer");
    const GenreLabels = require("./genreLabelShape");
    module.exports = factory(Realizer, GenreLabels);
  } else {
    root.FlamingoWordReservoir = factory(root.DirectAudioRealizer, root.GenreLabelShape);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (DirectAudioRealizer, GenreLabelShape) {
  const Realizer = DirectAudioRealizer || (typeof require !== "undefined" ? require("./directAudioRealizer") : null);
  const GenreLabels = GenreLabelShape || (typeof require !== "undefined" ? require("./genreLabelShape") : null);
  const Cluster = typeof SemanticConceptCluster !== "undefined" ? SemanticConceptCluster
    : (typeof require === "function" ? (() => { try { return require("./semanticConceptCluster"); } catch { return null; } })() : null);
  const FACT_FACETS = new Set(["rhythm", "instrumentation", "performance", "arrangement", "production", "dynamics", "live"]);
  const CONTEXT_FACETS = new Set(["scene", "era", "culture", "lineage"]);
  // Mirrors FACT_CATEGORY_ALIASES in scripts/flamingo_server.py: the model names audible facets in
  // its own words ("harmony", "bass motion"); route them onto display facets instead of dropping them.
  const FACET_ALIASES = Object.freeze({
    instrument: "instrumentation", instruments: "instrumentation", timbre: "instrumentation",
    bass: "instrumentation", bassline: "instrumentation", sample: "instrumentation",
    "vocal sample": "instrumentation", "vocal samples": "instrumentation", "vocal chop": "instrumentation",
    synth: "instrumentation", synths: "instrumentation", keys: "instrumentation",
    guitar: "instrumentation", piano: "instrumentation", brass: "instrumentation",
    vocal: "performance", vocals: "performance", voice: "performance", singing: "performance",
    rap: "performance", delivery: "performance", phrasing: "performance",
    tempo: "rhythm", groove: "rhythm", drums: "rhythm", drum: "rhythm", percussion: "rhythm",
    beat: "rhythm", meter: "rhythm", pulse: "rhythm", swing: "rhythm", syncopation: "rhythm",
    harmony: "arrangement", harmonic: "arrangement", melody: "arrangement", melodic: "arrangement",
    chords: "arrangement", chord: "arrangement", tonality: "arrangement", key: "arrangement",
    structure: "arrangement", form: "arrangement", texture: "arrangement", layering: "arrangement",
    motif: "arrangement", counterpoint: "arrangement",
    mix: "production", mixing: "production", space: "production", spatial: "production",
    stereo: "production", reverb: "production", effects: "production", fx: "production",
    "sound design": "production", tone: "production", mastering: "production", filter: "production",
    energy: "dynamics", intensity: "dynamics", loudness: "dynamics", build: "dynamics", dynamic: "dynamics"
  });

  // Canonical FACT facet for a model-written category, or null when none applies.
  function factFacetFor(rawCategory) {
    const name = String(rawCategory || "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
    if (FACT_FACETS.has(name)) return name;
    if (FACET_ALIASES[name]) return FACET_ALIASES[name];
    for (const word of name.split(" ")) {
      if (FACT_FACETS.has(word)) return word;
      if (FACET_ALIASES[word]) return FACET_ALIASES[word];
    }
    return null;
  }

  function normalizeText(text) {
    return Realizer ? Realizer.normalizeKey(text) : String(text || "").toLowerCase().trim();
  }

  // Packet fields name source channels; display candidates use the canonical SemanticFacets
  // taxonomy. Mixing the two namespaces caused every non-genre reservoir candidate to be dropped.
  function facetForPacketItem(packetKey, rawItem = {}, text = "") {
    const rawCategory = typeof rawItem === "object" && rawItem ? rawItem.category : "";
    const requested = String(rawCategory || "").toLowerCase();
    if (packetKey === "audibleObservations") return factFacetFor(requested);
    if (packetKey === "signatureRelations") return "arrangement";
    if (packetKey === "genreHypotheses") {
      if (!GenreLabels || GenreLabels.isPlausibleGenreLabel(text)) return "genre";
      return null;
    }
    if (packetKey === "contextHypotheses") return CONTEXT_FACETS.has(requested) ? requested : null;
    if (packetKey === "aestheticConcepts") return "association";
    if (packetKey === "impressions") return "mood";
    return null;
  }

  function isIndependentListen(mode, flags = {}) {
    if (flags.independent === false || flags.genreAdvisoryUsed || flags.conditionedOnClassifier) return false;
    const value = String(mode || "independent").toLowerCase();
    return value !== "assisted";
  }

  function listeningModeOf(rawItem = {}, metadata = {}) {
    if (rawItem?.listeningMode === "assisted" || metadata.listeningMode === "assisted") return "assisted";
    if (rawItem?.independent === false || metadata.independent === false ||
        metadata.genreAdvisoryUsed || metadata.conditionedOnClassifier) return "assisted";
    const mode = String(rawItem?.listeningMode || metadata.listeningMode || "independent").toLowerCase();
    return mode === "assisted" ? "assisted" : "independent";
  }

  function conceptKeyFor(text, category) {
    const normalized = normalizeText(text);
    return normalized ? `${category}:${normalized}` : "";
  }

  const PACKET_CONCEPT_FIELDS = Object.freeze([
    "audibleObservations", "signatureRelations", "genreHypotheses",
    "contextHypotheses", "aestheticConcepts", "impressions"
  ]);

  function packetConceptCount(packet = {}) {
    return PACKET_CONCEPT_FIELDS.reduce((sum, key) =>
      sum + (Array.isArray(packet?.[key]) ? packet[key].length : 0), 0);
  }

  // `/api/deep-analysis` already turns every accepted structured item into a provenance-rich
  // observation. Keep that accepted representation as a lossless fallback for the reservoir:
  // a missing/empty `structuredPacket` transport field must not make an otherwise valid Flamingo
  // response disappear from the word pool. This only routes the observation by its declared
  // evidenceType/category; it creates no words, genres, aesthetics, or interpretations of its own.
  function packetFromObservations(observations = []) {
    const packet = Object.fromEntries(PACKET_CONCEPT_FIELDS.map(key => [key, []]));
    packet.uncertainties = [];
    for (const item of (Array.isArray(observations) ? observations : [])) {
      if (!item || typeof item !== "object") continue;
      const text = String(item.sourceText || item.text || "").trim();
      if (!text) continue;
      const category = String(item.category || "").toLowerCase();
      const common = {
        text,
        category,
        confidence: item.modelConfidence ?? item.confidence,
        supportRefs: Array.isArray(item.supportRefs) ? item.supportRefs : [],
        reasoningHints: item.reasoningHints || null,
        listeningMode: item.listeningMode || (item.independent === false ? "assisted" : "independent")
      };
      const evidenceType = String(item.evidenceType || "");
      if (evidenceType === "genreHypothesis" || category === "genre") {
        packet.genreHypotheses.push({ ...common, label: text });
      } else if (evidenceType === "signatureRelation") {
        packet.signatureRelations.push(common);
      } else if (evidenceType === "contextHypothesis" || CONTEXT_FACETS.has(category)) {
        packet.contextHypotheses.push(common);
      } else if (evidenceType === "aestheticConcept" || category === "association" || item.layer === "AESTHETIC") {
        packet.aestheticConcepts.push(common);
      } else if (evidenceType === "impression" || category === "mood" || item.layer === "IMPRESSION") {
        packet.impressions.push(common);
      } else {
        packet.audibleObservations.push(common);
      }
    }
    return packet;
  }

  class Reservoir {
    constructor(options = {}) {
      this.realizer = options.realizer || (Realizer ? Realizer.defaultRealizer : null);
      // Repetition memory, not a storage cap: a longer window keeps a just-shown surface penalised
      // for longer, which pushes rotation further through each family instead of ping-ponging
      // between the same two phrasings.
      this.recentMemorySize = options.recentMemorySize || 24;
      // Memory is bounded by VOLATILITY first and by size second. A concept that stops being
      // re-heard fades out of the pool on its own, so the size cap can afford to be generous:
      // capping the pool instead of expiring it is what made the visible vocabulary feel thin,
      // since a low cap evicts breadth (many concepts) rather than staleness (old concepts).
      this.maxConcepts = options.maxConcepts || 260;
      // Full lifetime of a concept that is never corroborated again. Re-hearing it in a later
      // capture refreshes lastSeenAt and buys it another full window.
      this.conceptTtlMs = options.conceptTtlMs || 240000;
      this.effectiveConceptTtlMs = this.conceptTtlMs;
      // Weight decays smoothly over the TTL rather than the concept vanishing at a cliff edge.
      this.decayHalfLifeMs = options.decayHalfLifeMs || 60000;
      // Surface variants per concept. This is the single strongest lever on how varied the visible
      // Flamingo vocabulary feels: one capture yields only a handful of concepts, so each concept
      // has to carry the variety. Bounded well below the concept cap because these are short
      // strings -- 6 per concept is still trivial memory next to the audio buffer.
      this.maxFamilySize = options.maxFamilySize || 6;
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
      this.packetArrivalIntervals = [];
      this.effectiveConceptTtlMs = this.conceptTtlMs;
    }

    // Ingest a Flamingo structured packet or raw direct audio review
    ingestPacket(packet = {}, metadata = {}) {
      const trackEpoch = metadata.trackEpoch !== undefined ? Number(metadata.trackEpoch) : this.trackEpoch;
      if (trackEpoch !== this.trackEpoch) {
        // Drop stale packet belonging to a different track epoch
        return false;
      }

      this.packetCount += 1;
      const packetAt = metadata.timestamp || Date.now();
      if (this.lastPacketAt && packetAt > this.lastPacketAt) {
        const interval = packetAt - this.lastPacketAt;
        this.packetArrivalIntervals.push(interval);
        if (this.packetArrivalIntervals.length > 8) this.packetArrivalIntervals.shift();
        const sorted = [...this.packetArrivalIntervals].sort((a, b) => a - b);
        const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
        this.effectiveConceptTtlMs = Math.max(this.conceptTtlMs, Math.min(600000, p90 * 2.5));
      }
      this.lastPacketAt = packetAt;
      const observationId = metadata.observationId || `flam-${Date.now()}`;
      const audioSegmentId = metadata.audioSegmentId || null;

      // Ingest each category
      const categories = [
        { key: "audibleObservations", poolKey: "fact", realizationMode: "fact", defaultLayer: "FACT", defaultScope: "SECTION", defaultConf: 0.70 },
        { key: "signatureRelations", poolKey: "fact", realizationMode: "fact", defaultLayer: "FACT", defaultScope: "SECTION", defaultConf: 0.62 },
        { key: "genreHypotheses", poolKey: "genre", realizationMode: "genre", defaultLayer: "CONTEXT", defaultScope: "TRACK", defaultConf: 0.65 },
        { key: "contextHypotheses", poolKey: "context", realizationMode: "context", defaultLayer: "CONTEXT", defaultScope: "TRACK", defaultConf: 0.60 },
        { key: "aestheticConcepts", poolKey: "aesthetic", realizationMode: "aesthetic", defaultLayer: "AESTHETIC", defaultScope: "TRACK", defaultConf: 0.65 },
        { key: "impressions", poolKey: "impression", realizationMode: "impression", defaultLayer: "IMPRESSION", defaultScope: "SECTION", defaultConf: 0.60 }
      ];

      for (const cat of categories) {
        const items = Array.isArray(packet[cat.key]) ? packet[cat.key] : [];
        for (const rawItem of items) {
          const text = typeof rawItem === "string" ? rawItem : (rawItem?.text || rawItem?.label || "");
          const conf = typeof rawItem === "object" && rawItem?.confidence !== undefined ? rawItem.confidence : cat.defaultConf;
          const listeningMode = listeningModeOf(typeof rawItem === "object" ? rawItem : {}, metadata);
          if (!text || typeof text !== "string") continue;
          const category = facetForPacketItem(cat.key, rawItem, text);
          if (!category) continue;
          const layer = category === "genre" || CONTEXT_FACETS.has(category) ? "CONTEXT"
            : category === "association" ? "AESTHETIC"
              : category === "mood" ? "IMPRESSION" : cat.defaultLayer;

          this._addConcept({
            text,
            category,
            sourcePool: cat.poolKey,
            realizationMode: cat.realizationMode,
            layer,
            confidence: conf,
            observationId,
            audioSegmentId,
            listeningMode,
            supportRefs: typeof rawItem === "object" && Array.isArray(rawItem?.supportRefs) ? rawItem.supportRefs : [],
            temporalScope: cat.defaultScope,
            trackEpoch: this.trackEpoch
          });
        }
      }

      return true;
    }

    _addConcept({ text, category, sourcePool, realizationMode, layer, confidence, observationId,
        audioSegmentId, listeningMode, supportRefs, temporalScope, trackEpoch }) {
      const normalizedText = normalizeText(text);
      const conceptKey = conceptKeyFor(text, category);
      if (!conceptKey) return;

      // Realize to Korean family
      let family = [];
      if (this.realizer) {
        family = this.realizer.realize(text, realizationMode || category);
      } else if (DirectAudioRealizer) {
        family = DirectAudioRealizer.realize(text, realizationMode || category);
      }
      if (!family || !family.length) {
        family = [text];
      }

      let entry = this.conceptRegistry.get(conceptKey);
      if (!entry) {
        this._evictWeakestConcept();
        entry = {
          conceptKey,
          normalizedText,
          canonicalText: text,
          category,
          sourcePool,
          realizationMode: realizationMode || category,
          layer,
          confidence: 0,
          modelConfidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
          confidenceEvidence: new Map(),
          family: family.slice(0, this.maxFamilySize),
          temporalScope,
          observationId,
          observationIds: new Set(observationId ? [observationId] : []),
          segmentIds: new Set(audioSegmentId ? [audioSegmentId] : []),
          independentObservationIds: new Set(isIndependentListen(listeningMode) && observationId ? [observationId] : []),
          assistedObservationIds: new Set(listeningMode === "assisted" && observationId ? [observationId] : []),
          canonicalConceptId: conceptKey,
          semanticClusterId: Cluster ? Cluster.clusterKey({ text, canonicalText: text }) : conceptKey,
          surfaceUsage: 0,
          trackEpoch,
          addedAt: Date.now(),
          lastSeenAt: Date.now(),
          usageCount: 0
        };
        this._recordConfidence(entry, observationId, confidence, listeningMode);
        entry.supportRefs = new Set(Array.isArray(supportRefs) ? supportRefs : []);
        this.conceptRegistry.set(conceptKey, entry);
        if (this.pools[sourcePool]) {
          this.pools[sourcePool].push(entry);
        }
        if (!this.rotationIndexes.has(conceptKey)) {
          this.rotationIndexes.set(conceptKey, 0);
        }
      } else {
        // Update existing entry with fresh confidence and observation. Being heard again is what
        // buys a concept another full lifetime -- that is the whole volatility contract.
        this._recordConfidence(entry, observationId, confidence, listeningMode);
        entry.observationId = observationId;
        if (observationId) entry.observationIds.add(observationId);
        if (audioSegmentId) entry.segmentIds.add(audioSegmentId);
        for (const ref of (Array.isArray(supportRefs) ? supportRefs : [])) entry.supportRefs.add(ref);
        if (isIndependentListen(listeningMode) && observationId) entry.independentObservationIds.add(observationId);
        if (listeningMode === "assisted" && observationId) entry.assistedObservationIds.add(observationId);
        entry.lastSeenAt = Date.now();
        // Merge any new realizations
        const existingFamily = new Set(entry.family);
        for (const variant of family) {
          existingFamily.add(variant);
        }
        entry.family = [...existingFamily].slice(-this.maxFamilySize);
      }
    }

    _recordConfidence(entry, observationId, confidence, listeningMode) {
      const value = Math.max(0, Math.min(1, Number(confidence) || 0));
      const key = observationId || `anonymous-${entry.confidenceEvidence.size}`;
      const weight = listeningMode === "assisted" ? 0.35 : 1;
      // Repeated copies inside one packet are one observation, not corroboration.
      entry.confidenceEvidence.set(key, { value, weight, listeningMode });
      const evidence = [...entry.confidenceEvidence.values()];
      const totalWeight = evidence.reduce((sum, item) => sum + item.weight, 0) || 1;
      const mean = evidence.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
      const independentCount = evidence.filter(item => isIndependentListen(item.listeningMode)).length;
      const corroboration = Math.min(0.08, Math.max(0, independentCount - 1) * 0.025);
      entry.modelConfidence = value;
      entry.confidence = Math.max(0, Math.min(1, mean + corroboration));
    }

    // Low-confidence genre names remain inspectable as raw Flamingo output, but one weak hearing
    // cannot enter the selectable language pool. The gate is entirely label-agnostic: a second
    // capture can promote any name, including one absent from every local taxonomy.
    isPromotionEligible(entry) {
      if (!entry) return false;
      // An assisted fact may reflect the classifier label that framed the hearing. Keep it in the
      // inspector for transparency, but do not let it speak as FACT until a blind pass hears the
      // same concept. This rule is category/label agnostic and therefore adds no genre catalogue.
      if (entry.layer === "FACT") {
        const independent = entry.independentObservationIds instanceof Set
          ? entry.independentObservationIds.size : 0;
        if (independent === 0) return false;
      }
      if (entry.category !== "genre") return true;
      const confidence = Math.max(0, Math.min(1, Number(entry.confidence) || 0));
      const observations = entry.observationIds instanceof Set ? entry.observationIds.size : 0;
      return confidence >= 0.50 || (observations >= 2 && confidence >= 0.42);
    }

    promotionHoldReason(entry) {
      if (entry?.layer === "FACT" && entry.independentObservationIds instanceof Set &&
          entry.independentObservationIds.size === 0) return "독립청취 미확인";
      if (entry?.category === "genre" && !this.isPromotionEligible(entry)) return "단발 저확신";
      return "검증 대기";
    }

    _evictWeakestConcept() {
      if (this.conceptRegistry.size < this.maxConcepts) return;
      let weakestKey = null;
      let weakestEntry = null;
      let weakestScore = Infinity;
      const now = Date.now();
      for (const [key, entry] of this.conceptRegistry) {
        // Staleness is measured from the last time the concept was actually HEARD, not from when
        // it was first added -- a concept Flamingo keeps re-confirming is not old, it is current.
        const freshness = Math.max(0, 1 - (now - (entry.lastSeenAt || entry.addedAt || 0)) / this.effectiveConceptTtlMs);
        const score = (Number(entry.confidence) || 0) * 0.65 + freshness * 0.25 +
          Math.min(0.1, (entry.usageCount || 0) * 0.01);
        if (score < weakestScore) {
          weakestKey = key;
          weakestEntry = entry;
          weakestScore = score;
        }
      }
      if (!weakestKey) return;
      this.conceptRegistry.delete(weakestKey);
      this.rotationIndexes.delete(weakestKey);
      const pool = weakestEntry && this.pools[weakestEntry.sourcePool];
      if (pool) {
        const index = pool.indexOf(weakestEntry);
        if (index >= 0) pool.splice(index, 1);
      }
    }

    // Drops concepts that have not been re-heard within their lifetime. Called from
    // getCandidates() so the pool is swept exactly as often as it is read, with no timer.
    sweepExpired(now = Date.now()) {
      let removed = 0;
      for (const [conceptKey, entry] of [...this.conceptRegistry.entries()]) {
        if (now - (entry.lastSeenAt || entry.addedAt || now) <= this.effectiveConceptTtlMs) continue;
        this.conceptRegistry.delete(conceptKey);
        this.rotationIndexes.delete(conceptKey);
        const pool = this.pools[entry.sourcePool];
        const index = pool ? pool.indexOf(entry) : -1;
        if (index >= 0) pool.splice(index, 1);
        removed += 1;
      }
      return removed;
    }

    // Get current candidate tokens for display and selection
    getCandidates(options = {}) {
      const candidates = [];
      const now = Date.now();
      this.sweepExpired(now);

      for (const [conceptKey, entry] of this.conceptRegistry.entries()) {
        if (!this.isPromotionEligible(entry)) continue;
        const family = entry.family || [entry.canonicalText];
        const rotIdx = this.rotationIndexes.get(conceptKey) || 0;
        const displayText = family[rotIdx % family.length] || entry.canonicalText;

        // Calculate repetition penalty
        const recentCount = this.recentSelections.filter(t => t === displayText).length;
        const repetitionFactor = 1 / (1 + recentCount * 1.5);
        // Volatility, expressed as weight rather than a cliff: a concept that has not been heard
        // again keeps fading until sweepExpired() finally drops it, so newly-heard concepts
        // naturally take over the pool instead of competing with stale ones on equal footing.
        const ageMs = Math.max(0, now - (entry.lastSeenAt || entry.addedAt || now));
        const freshnessFactor = Math.pow(0.5, ageMs / this.decayHalfLifeMs);
        const effectiveWeight = Math.max(0.05, (entry.confidence || 0.6) * repetitionFactor * freshnessFactor);

        candidates.push({
          text: displayText,
          canonicalText: entry.canonicalText,
          sourceText: entry.canonicalText,
          conceptKey,
          surfaceConceptKey: conceptKey,
          category: entry.category,
          layer: entry.layer,
          source: "directAudio",
          sourceFamily: "directAudio",
          sourceModel: "music-flamingo",
          resolutionMomentum: true,
          temporalScope: entry.temporalScope,
          confidence: entry.confidence,
          // `score` is read by semanticFacetManager.curate() as a QUALITY ranking, on the same
          // axis as the language critic's score for every locally-composed phrase (~0.7-0.9).
          // Publishing the volatility decay here instead meant a Flamingo concept entered that
          // comparison at confidence * 0.5^(age/60s) -- below every local phrase after about a
          // minute, and falling further the longer the song played, which is exactly when the
          // deep listen has the most to say. Volatility is real, but it is a freshness preference,
          // not evidence that the concept is worse. Publish it separately.
          score: entry.confidence,
          evidenceScore: entry.confidence,
          weight: entry.confidence,
          // Consumed as gentle multipliers by phraseSelection.weight() (evidenceReservoir /
          // reservoirFitness), so a stale concept is graded down rather than buried.
          reservoirScore: Math.max(0.05, repetitionFactor * freshnessFactor),
          freshness: freshnessFactor,
          volatilityWeight: effectiveWeight,
          // An unknown English phrase is an honest temporary placeholder in the reservoir, not
          // finished UI copy. It remains hidden until the asynchronous Korean family arrives.
          requiresKoreanRealization: entry.category !== "genre" && !/[가-힣]/.test(displayText),
          isDirectAudio: true,
          trackEpoch: this.trackEpoch,
          observationIds: [...entry.observationIds],
          segmentIds: [...entry.segmentIds],
          independentObservationCount: entry.independentObservationIds.size,
          crossSegmentSupport: entry.segmentIds.size,
          supportRefs: [...entry.supportRefs],
          familyCount: family.length,
          rotationIndex: rotIdx
        });
      }

      return candidates;
    }

    // Applies a genuine LLM Korean realization to an already-registered concept, REPLACING
    // (never merging into) whatever the synchronous fallback produced -- a plain-English or
    // hybrid-language placeholder must stop being selectable the moment real Korean phrasing for
    // the same concept arrives. Returns false if the concept isn't registered or the family is
    // empty/non-Korean (nothing to apply).
    applyRealization(conceptText, family = [], category = null) {
      const koreanFamily = Array.isArray(family)
        ? [...new Set(family.filter(f => typeof f === "string" && f.trim() && /[가-힣]/.test(f)))]
          .slice(0, this.maxFamilySize)
        : [];
      if (!koreanFamily.length) return false;
      const normalizedText = normalizeText(conceptText);
      const targetKey = category ? conceptKeyFor(conceptText, category) : null;
      const entries = targetKey && this.conceptRegistry.has(targetKey)
        ? [[targetKey, this.conceptRegistry.get(targetKey)]]
        : [...this.conceptRegistry.entries()].filter(([, entry]) => entry.normalizedText === normalizedText);
      if (!entries.length) return false;
      for (const [conceptKey, entry] of entries) {
        entry.family = koreanFamily;
        this.rotationIndexes.set(conceptKey, 0);
      }
      return true;
    }

    // Advance rotation index for a concept after selection so the next display uses another variation
    rotate(conceptKey) {
      let resolvedKey = this.conceptRegistry.has(conceptKey) ? conceptKey : null;
      if (!resolvedKey) {
        const normalizedText = normalizeText(conceptKey);
        resolvedKey = [...this.conceptRegistry.entries()].find(([, entry]) => entry.normalizedText === normalizedText)?.[0] || null;
      }
      if (!resolvedKey) return false;
      const current = this.rotationIndexes.get(resolvedKey) || 0;
      this.rotationIndexes.set(resolvedKey, current + 1);
      return true;
    }

    // Record that a phrase was selected for display
    noteUsed(text, surfaceConceptKey = null) {
      if (!text) return false;
      this.recentSelections.push(text);
      if (this.recentSelections.length > this.recentMemorySize) {
        this.recentSelections.shift();
      }

      // Prefer the stable facet-aware key carried by the selected token. Text lookup remains a
      // compatibility fallback for old callers, but can be ambiguous when two concepts share a
      // surface phrase.
      if (surfaceConceptKey && this.conceptRegistry.has(surfaceConceptKey)) {
        const entry = this.conceptRegistry.get(surfaceConceptKey);
        entry.usageCount = (entry.usageCount || 0) + 1;
        entry.surfaceUsage = (entry.surfaceUsage || 0) + 1;
        this.rotate(surfaceConceptKey);
        return true;
      }

      // Check if this text belongs to any registered family
      for (const [normKey, entry] of this.conceptRegistry.entries()) {
        if (entry.family && entry.family.includes(text)) {
          entry.usageCount = (entry.usageCount || 0) + 1;
          this.rotate(normKey);
          return true;
        }
      }
      return false;
    }

    // Diagnostic inspection snapshot
    inspect() {
      const entries = [...this.conceptRegistry.values()];
      const clusterStats = Cluster ? Cluster.inspect(entries) : {
        canonicalConceptCount: entries.length,
        semanticClusterCount: entries.length,
        surfacePhraseCount: entries.reduce((sum, entry) => sum + new Set(entry.family || []).size, 0)
      };
      return {
        trackEpoch: this.trackEpoch,
        packetCount: this.packetCount,
        lastPacketAt: this.lastPacketAt,
        effectiveConceptTtlMs: this.effectiveConceptTtlMs,
        totalConcepts: this.conceptRegistry.size,
        canonicalConceptCount: clusterStats.canonicalConceptCount,
        semanticClusterCount: clusterStats.semanticClusterCount,
        surfacePhraseCount: clusterStats.surfacePhraseCount,
        independentlySupportedConceptCount: entries.filter(entry => entry.independentObservationIds.size > 0).length,
        crossSegmentConceptCount: entries.filter(entry => entry.segmentIds.size > 1).length,
        poolCounts: {
          fact: this.pools.fact.length,
          genre: this.pools.genre.length,
          context: this.pools.context.length,
          aesthetic: this.pools.aesthetic.length,
          impression: this.pools.impression.length
        },
        facetCounts: entries.reduce((counts, entry) => {
          counts[entry.category] = (counts[entry.category] || 0) + 1;
          return counts;
        }, {}),
        recentSelections: [...this.recentSelections]
      };
    }
  }

  const defaultReservoir = new Reservoir();

  return {
    Reservoir,
    defaultReservoir,
    facetForPacketItem,
    factFacetFor,
    conceptKeyFor,
    packetConceptCount,
    packetFromObservations,
    isIndependentListen,
    listeningModeOf
  };
});
