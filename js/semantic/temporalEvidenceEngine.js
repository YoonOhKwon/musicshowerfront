const TemporalEvidence = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const FAST = new Set(["live", "dynamics"]);
  const MUSICAL = new Set(["rhythm", "instrumentation", "performance", "arrangement", "production"]);
  const CONTEXT = new Set(["genre", "lineage", "mood", "era", "scene", "culture", "association"]);
  const keyFor = item => `${item.category}:${String(item.text).toLowerCase()}`;
  const rootsFor = item => [...new Set((item.anchors || []).map(path => String(path).split(".")[0]).filter(Boolean))];

  function provenance(item, at, previous = null) {
    const confidence = clamp(item.confidence);
    const paths = (item.anchors || []).map(path => ({ path, source: String(path).split(".")[0], observedAt: at }));
    return {
      source: Array.isArray(item.source) ? item.source : [item.source || "semantic-pipeline"],
      path: paths.map(item => item.path),
      evidence: paths,
      firstSeenAt: previous?.firstSeenAt ?? at,
      lastSeenAt: at,
      currentConfidence: confidence,
      peakConfidence: Math.max(previous?.peakConfidence || 0, confidence)
    };
  }

  function evidenceStatus(item) {
    if (item.evidenceStatus === "contradicted" || item.contradicted === true) return "contradicted";
    if (item.evidenceStatus === "unknown" || item.supported === false) return "unknown";
    return "supported";
  }

  class Engine {
    constructor({ fastMs = 200, musicalMs = 5000, contextMs = 30000, switchMargin = 0.06,
      liveTtlMs = 1800, traitMinimumMs = 1500 } = {}) {
      Object.assign(this, { fastMs, musicalMs, contextMs, switchMargin, liveTtlMs, traitMinimumMs });
      this.reset();
    }

    reset() {
      this.history = new Map();
      this.stableByFacet = new Map();
      this.pendingByFacet = new Map();
      this.liveEvents = new Map();
      this.trackTraits = new Map();
      this.deepListeningMemory = new Map();
      this.historicalEvents = [];
      this.startedAt = 0;
      this.revision = 0;
    }

    update(rawCandidates = [], at = Date.now()) {
      if (this.startedAt === 0 && this.revision === 0) this.startedAt = at;
      const suppressed = [];
      const candidates = rawCandidates.map(item => Layers.decorate(item));
      const presentKeys = new Set();
      const evaluated = [];

      for (const item of candidates) {
        const key = keyFor(item);
        const layer = Layers.layerFor(item.category, item);
        const status = evidenceStatus(item);
        const previousHistory = this.history.get(key);
        const itemProvenance = provenance(item, at, previousHistory?.provenance);
        if (status !== "supported") {
          suppressed.push({ ...item, evidenceStatus: status, suppressionReason:
            status === "contradicted" ? "current-evidence-contradicts-claim" : "supporting-detector-unavailable",
            provenance: itemProvenance });
          continue;
        }
        presentKeys.add(key);
        const obsId = item.observationId || (Array.isArray(item.source) ? (item.source.includes("directAudio") ? item.claimId || "directAudio-event" : null) : item.source === "directAudio" ? item.claimId || "directAudio-event" : null);
        const isEventBased = Boolean(obsId);

        let observations = 1;
        const memoryEntry = isEventBased ? this.deepListeningMemory.get(key) : null;
        const priorHistory = previousHistory || (memoryEntry ? {
          observations: memoryEntry.observations,
          firstSeenAt: memoryEntry.firstSeenAt,
          lastSeenAt: memoryEntry.lastSeenAt,
          lastObservationId: memoryEntry.lastObservationId,
          seenObservationIds: memoryEntry.seenObservationIds
        } : null);

        const seenObservationIds = priorHistory?.seenObservationIds instanceof Set
          ? new Set(priorHistory.seenObservationIds)
          : new Set(priorHistory?.lastObservationId ? [priorHistory.lastObservationId] : []);

        const memoryWindow = isEventBased ? 90000 : this.contextMs;
        if (priorHistory && at - priorHistory.lastSeenAt <= memoryWindow) {
          if (isEventBased) {
            if (obsId && seenObservationIds.has(obsId)) {
              // Event-based observation seen again (even in alternating A -> B -> A sequence):
              // Do NOT increment temporal observation count!
              observations = priorHistory.observations;
            } else {
              if (obsId) {
                seenObservationIds.add(obsId);
                if (seenObservationIds.size > 128) {
                  const first = seenObservationIds.values().next().value;
                  seenObservationIds.delete(first);
                }
              }
              observations = priorHistory.observations + 1;
            }
          } else {
            observations = priorHistory.observations + 1;
          }
        } else if (isEventBased && obsId) {
          seenObservationIds.add(obsId);
        }

        const history = {
          firstSeenAt: observations > 1 || (priorHistory && isEventBased) ? priorHistory.firstSeenAt : at,
          lastSeenAt: at,
          observations,
          lastObservationId: obsId || priorHistory?.lastObservationId || null,
          seenObservationIds,
          peakConfidence: Math.max(priorHistory?.peakConfidence || 0, clamp(item.confidence)),
          provenance: itemProvenance
        };
        history.provenance.firstSeenAt = history.firstSeenAt;
        history.provenance.peakConfidence = history.peakConfidence;
        this.history.set(key, history);
        if (isEventBased) {
          this.deepListeningMemory.set(key, {
            key,
            text: item.text,
            category: item.category,
            firstSeenAt: history.firstSeenAt,
            lastSeenAt: at,
            observations,
            lastObservationId: obsId,
            seenObservationIds,
            confidence: clamp(item.confidence)
          });
        }
        const stableForMs = at - history.firstSeenAt;
        const temporalStability = clamp(Math.min(1, observations / (layer === "LIVE" ? 1 : 6)) * 0.55 +
          Math.min(1, stableForMs / (layer === "FACT" ? this.musicalMs : this.contextMs)) * 0.45);
        const evaluatedItem = { ...item, layer, semanticDistance: Layers.distances[layer],
          confidence: clamp(item.confidence), semanticConfidence: clamp(item.semanticConfidence ?? item.confidence),
          temporalStability, evidenceStatus: "supported", provenance: history.provenance, temporal: {
            current: clamp(item.confidence), short: temporalStability, long: temporalStability,
            observations, stableForMs, resolution: layer === "LIVE" ? "fast" : layer === "FACT" ? "musical" : "context"
          } };
        evaluated.push(evaluatedItem);
        if (layer === "LIVE") {
          const ttlMs = Math.max(250, Number(item.ttlMs) || this.liveTtlMs);
          this.liveEvents.set(key, { ...evaluatedItem, ttlMs, expiresAt: at + ttlMs });
        }
      }

      for (const [key, item] of this.liveEvents) {
        if (at <= item.expiresAt) continue;
        this.liveEvents.delete(key);
        this.historicalEvents.push({ ...item, evidenceStatus: "expired", expiredAt: at });
      }
      this.historicalEvents = this.historicalEvents.slice(-64);

      const byFacet = new Map();
      for (const item of evaluated.filter(item => item.layer !== "LIVE")) {
        const list = byFacet.get(item.category) || [];
        list.push(item);
        byFacet.set(item.category, list);
      }
      for (const [facet, list] of byFacet) {
        list.sort((a, b) => b.semanticConfidence - a.semanticConfidence);
        const challenger = list[0];
        const current = this.stableByFacet.get(facet);
        const isDirectAudio = challenger.sourceFamily === "directAudio" || challenger.source === "directAudio" || challenger.resolutionMomentum === true;
        const minimum = isDirectAudio ? 0.48 : ({ FACT: 0.58, CONTEXT: 0.66, AESTHETIC: 0.62, IMPRESSION: 0.56 }[challenger.layer] ?? 0.58);
        const neededObservations = isDirectAudio ? 1 : (challenger.layer === "FACT" ? 2 : 3);
        const neededMs = isDirectAudio ? 0 : (["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(challenger.layer) ? 5500 : 0);
        const eligible = challenger.semanticConfidence >= minimum && challenger.temporal.observations >= neededObservations &&
          challenger.temporal.stableForMs >= neededMs;
        if (!current && eligible) this.stableByFacet.set(facet, challenger);
        else if (current && keyFor(current) === keyFor(challenger)) this.stableByFacet.set(facet, challenger);
        else if (current && eligible && challenger.semanticConfidence >= (current.semanticConfidence || current.confidence) + this.switchMargin) {
          const pending = this.pendingByFacet.get(facet);
          const delay = ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(challenger.layer) ? 2500 : 800;
          if (pending?.key === keyFor(challenger) && at - pending.since >= delay) {
            this.stableByFacet.set(facet, challenger);
            this.pendingByFacet.delete(facet);
          } else if (!pending || pending.key !== keyFor(challenger)) {
            this.pendingByFacet.set(facet, { key: keyFor(challenger), since: at });
          }
        }
      }

      for (const [facet, item] of this.stableByFacet) {
        const history = this.history.get(keyFor(item));
        const ttl = item.layer === "FACT" ? this.musicalMs : this.contextMs;
        if (!history || at - history.lastSeenAt > ttl) {
          this.stableByFacet.delete(facet);
          this.pendingByFacet.delete(facet);
        }
      }

      for (const item of evaluated.filter(item => item.layer !== "LIVE" && item.category !== "genre")) {
        const axes = rootsFor(item);
        const contextLike = ["CONTEXT", "AESTHETIC", "IMPRESSION"].includes(item.layer);
        const minimumMs = contextLike ? 5500 : this.traitMinimumMs;
        const strongMultiAxis = axes.length >= 2 && item.semanticConfidence >= 0.68;
        const exceptionalRepeated = item.temporal.observations >= 4 && item.semanticConfidence >= 0.78;
        if (item.temporal.observations >= 3 && item.temporal.stableForMs >= minimumMs && (strongMultiAxis || exceptionalRepeated)) {
          this.trackTraits.set(keyFor(item), { ...item, promotedAt: this.trackTraits.get(keyFor(item))?.promotedAt || at,
            lastConfirmedAt: at, evidenceStatus: "supported" });
        }
      }
      for (const [key, item] of this.trackTraits) {
        const history = this.history.get(key);
        const age = at - (history?.lastSeenAt ?? item.lastConfirmedAt);
        if (presentKeys.has(key)) continue;
        if (age > this.contextMs) this.trackTraits.delete(key);
        else this.trackTraits.set(key, { ...item, evidenceStatus: "stale", currentConfidence: 0,
          provenance: { ...item.provenance, currentConfidence: 0 } });
      }

      for (const [key, item] of this.history) if (at - item.lastSeenAt > this.contextMs * 2) this.history.delete(key);
      this.revision += 1;
      const liveEvents = [...this.liveEvents.values()];
      // Promotion changes ownership: a concept is either a short-term state or a track trait,
      // never duplicated in both lifecycle buckets.
      const shortTermStates = [...this.stableByFacet.values()].filter(item =>
        item.category !== "genre" && !this.trackTraits.has(keyFor(item)));
      const genreHypotheses = [...this.stableByFacet.values()].filter(item => item.category === "genre");
      const trackTraits = [...this.trackTraits.values()];
      const stable = [...this.stableByFacet.values()];
      const visibleTraits = trackTraits.filter(item => item.evidenceStatus === "supported");
      // A factual detector disappearing means the current claim is unsupported. Keep the old
      // state internally for challenger hysteresis, but do not keep rendering it.
      const visibleStable = stable.filter(item => item.layer !== "FACT" || presentKeys.has(keyFor(item)));
      const activeDirectAudio = evaluated.filter(item =>
        (item.sourceFamily === "directAudio" || item.source === "directAudio" || item.resolutionMomentum === true) &&
        (item.confidence ?? 0.6) >= 0.45
      );
      const displayCandidates = [...liveEvents, ...activeDirectAudio, ...visibleStable, ...visibleTraits].filter((item, index, all) =>
        all.findIndex(other => keyFor(other) === keyFor(item)) === index);
      return {
        windows: { fastMs: this.fastMs, musicalMs: this.musicalMs, contextMs: this.contextMs },
        elapsedMs: at - this.startedAt, revision: this.revision, evaluated, liveEvents, shortTermStates,
        trackTraits, genreHypotheses, historicalEvents: this.historicalEvents.slice(),
        contradictions: suppressed.filter(item => item.evidenceStatus === "contradicted"),
        stale: trackTraits.filter(item => item.evidenceStatus === "stale"), suppressed,
        stable, trackMemory: trackTraits, displayCandidates, updatedAt: at
      };
    }
  }

  return { Engine, FAST, MUSICAL, CONTEXT, provenance, evidenceStatus };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TemporalEvidence;
