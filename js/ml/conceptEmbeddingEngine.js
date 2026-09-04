const ConceptEmbeddingEngine = (() => {
  class Engine {
    constructor() { this.reset(); }
    reset() {
      this.bank = null;
      this.status = { available: false, reason: "concept-text-embeddings-not-bundled", model: null };
    }
    async initialize(url) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("concept-bank-unavailable");
        this.bank = await response.json();
        const vectors = this.bank.vectors;
        const valid = this.bank.embeddingModel && Number.isInteger(this.bank.dimensions) && Array.isArray(vectors) && vectors.length;
        this.status = valid
          ? { available: true, reason: null, model: this.bank.embeddingModel }
          : { available: false, reason: "concept-text-embeddings-not-bundled", model: null };
      } catch (error) {
        this.status = { available: false, reason: error.message, model: null };
      }
      return this.status;
    }
    classify(audioEmbedding = []) {
      if (!this.status.available || audioEmbedding.length !== this.bank.dimensions) return [];
      const norm = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      const audioNorm = norm(audioEmbedding);
      if (!audioNorm) return [];
      const threshold = this.bank.activationPolicy?.minimumSimilarity || 0.68;
      return this.bank.vectors.map(item => {
        const dot = item.vector.reduce((sum, value, index) => sum + value * audioEmbedding[index], 0);
        return { text: item.text, category: item.category, confidence: dot / Math.max(1e-9, audioNorm * norm(item.vector)), source: "embedding" };
      }).filter(item => item.confidence >= threshold).sort((a, b) => b.confidence - a.confidence);
    }
  }
  return { Engine };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ConceptEmbeddingEngine;
