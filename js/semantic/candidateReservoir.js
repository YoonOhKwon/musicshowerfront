// Bounded, expiring cache for generative language. Canonical local musical terms never enter it.
// This separation lets the UI fall back to deterministic vocabulary when the API is absent.
const CandidateReservoir = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  class Reservoir {
    constructor({ capacity = 40 } = {}) {
      this.capacity = Math.min(64, Math.max(12, capacity));
      this.clear();
    }
    clear() { this.items = []; this.epoch = -1; this.installedAt = 0; }
    replace(candidates = [], { epoch = 0, at = Date.now(), defaultTtlMs = 60000 } = {}) {
      this.epoch = epoch;
      this.installedAt = at;
      this.items = candidates.slice(0, this.capacity).map((item, index) => {
        const ttlMs = Math.max(2000, Number(item.ttlMs) || defaultTtlMs);
        return { ...item, source: "remote-generative", semanticEpoch: epoch, epoch,
          generatedAt: at, expiresAt: at + ttlMs, ttlMs, useCount: 0,
          groundingScore: clamp(item.groundingScore ?? item.evidenceScore ?? item.confidence),
          freshness: 1, contextRelevance: clamp(item.contextRelevance ?? item.relevance ?? 0.8),
          specificity: clamp(item.specificity ?? 0.6), novelty: clamp(item.novelty ?? 0.7),
          semanticFamily: item.semanticFamily || null, reservoirRank: index };
      });
      return this.snapshot({ epoch, at });
    }
    noteUsed(text) {
      const item = this.items.find(candidate => candidate.text === text);
      if (item) item.useCount = (item.useCount || 0) + 1;
    }
    snapshot({ epoch = this.epoch, at = Date.now() } = {}) {
      if (epoch !== this.epoch) return [];
      this.items = this.items.filter(item => item.expiresAt > at);
      return this.items.map(item => ({ ...item,
        freshness: clamp((item.expiresAt - at) / Math.max(1, item.ttlMs)) }));
    }
    stats(at = Date.now()) {
      const active = this.snapshot({ epoch: this.epoch, at });
      return { size: active.length, capacity: this.capacity, epoch: this.epoch,
        installedAt: this.installedAt, expiringSoon: active.filter(item => item.freshness < 0.2).length };
    }
  }
  return { Reservoir };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CandidateReservoir;
