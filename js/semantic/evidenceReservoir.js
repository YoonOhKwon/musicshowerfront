// Song-scoped reservoir for every grounded display candidate. Unlike CandidateReservoir
// (remote language only), this keeps local facts, events and context together so selection can
// compare evidence strength, freshness and display history without changing detector truth.
const EvidenceReservoir = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const lifetimes = Object.freeze({ LIVE: 8000, FACT: 45000, CONTEXT: 150000, AESTHETIC: 120000, IMPRESSION: 45000 });
  const reliability = Object.freeze({ LIVE: 1, FACT: 1, CONTEXT: 0.86, AESTHETIC: 0.76, IMPRESSION: 0.68 });

  class Reservoir {
    constructor({ capacity = 180 } = {}) {
      this.capacity = Math.min(240, Math.max(40, capacity));
      this.clear(0);
    }

    clear(sessionId = this.sessionId || 0) {
      this.sessionId = sessionId;
      this.items = new Map();
      this.observations = 0;
    }

    observe(candidates = [], { sessionId = this.sessionId, epoch = 0, at = Date.now(), observationSeconds = Infinity } = {}) {
      if (sessionId !== this.sessionId) this.clear(sessionId);
      this.observations++;
      for (const source of candidates) {
        if (!source?.text) continue;
        const item = Layers.decorate(source);
        const conceptKey = Quality.conceptKey(item);
        const previous = this.items.get(conceptKey);
        const confidence = clamp(item.evidenceScore ?? item.confidence ?? item.weight ?? 0.5);
        const agreement = previous ? 1 - Math.min(1, Math.abs(previous.confidence - confidence) * 2) : 0.45;
        const seenCount = (previous?.seenCount || 0) + 1;
        const stability = clamp((previous?.stability || 0.3) * 0.72 + agreement * 0.18 + Math.min(0.1, seenCount * 0.02));
        const specificityTier = Quality.specificityTier(item);
        const specificity = clamp(item.specificity ?? specificityTier / 4);
        const proposedNovelty = clamp(item.novelty ?? 1);
        const novelty = previous?.displayCount
          ? Math.min(proposedNovelty, clamp(1 / (1 + previous.displayCount * 0.45)))
          : proposedNovelty;
        const salience = clamp(item.salience ?? (item.layer === "LIVE" ? 1 : 0.58 + specificity * 0.34));
        const temporalRelevance = clamp(Math.min(1, Layers.temporalFitness(item, {
          observationSeconds, changing: item.layer === "LIVE"
        })));
        const epistemicReliability = reliability[item.layer] || 0.65;
        const ttlMs = Math.max(Layers.ttlMs(item), lifetimes[item.layer] || 45000);
        const reservoirScore = clamp(confidence * (0.55 + stability * 0.45) *
          (0.55 + salience * 0.45) * (0.5 + specificity * 0.5) *
          (0.62 + novelty * 0.38) * (0.65 + temporalRelevance * 0.35) * epistemicReliability);
        this.items.set(conceptKey, {
          ...previous, ...item, conceptKey, musicalFacet: Quality.musicalFacet(item), specificityTier,
          confidence, stability, salience, novelty, temporalRelevance, epistemicReliability,
          reservoirScore, seenCount, firstSeen: previous?.firstSeen || at, lastSeen: at,
          lastEpoch: epoch, expiresAt: at + ttlMs, ttlMs,
          displayCount: previous?.displayCount || 0, lastDisplayed: previous?.lastDisplayed || null
        });
      }
      this.prune(at);
      return this.snapshot({ at });
    }

    prune(at = Date.now()) {
      for (const [key, item] of this.items) if (item.expiresAt <= at) this.items.delete(key);
      if (this.items.size <= this.capacity) return;
      const keep = [...this.items.values()].sort((a, b) => b.reservoirScore - a.reservoirScore).slice(0, this.capacity);
      this.items = new Map(keep.map(item => [item.conceptKey, item]));
    }

    noteDisplayed(candidate, at = Date.now()) {
      const key = Quality.conceptKey(candidate);
      const item = this.items.get(key);
      if (!item) return null;
      item.displayCount = (item.displayCount || 0) + 1;
      item.lastDisplayed = at;
      item.novelty = clamp(1 / (1 + item.displayCount * 0.45));
      return { ...item };
    }

    find(input) {
      const key = Quality.conceptKey(input);
      return this.items.get(key) || [...this.items.values()].find(item => item.text === input) || null;
    }

    snapshot({ at = Date.now() } = {}) {
      this.prune(at);
      return [...this.items.values()].sort((a, b) => b.reservoirScore - a.reservoirScore).map(item => ({ ...item }));
    }

    stats(at = Date.now()) {
      const items = this.snapshot({ at });
      const facets = {};
      for (const item of items) facets[item.musicalFacet] = (facets[item.musicalFacet] || 0) + 1;
      return { size: items.length, capacity: this.capacity, sessionId: this.sessionId,
        observations: this.observations, facets, displayed: items.filter(item => item.displayCount > 0).length };
    }
  }

  return { Reservoir, lifetimes, reliability };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EvidenceReservoir;
