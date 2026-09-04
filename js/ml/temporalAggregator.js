const TemporalModelAggregation = (() => {
  function meanVectors(items, key) {
    const vectors = items.map(item => item[key]).filter(vector => vector?.length);
    if (!vectors.length) return [];
    const length = Math.min(...vectors.map(vector => vector.length));
    const output = new Float32Array(length);
    for (const vector of vectors) {
      for (let index = 0; index < length; index++) output[index] += vector[index] / vectors.length;
    }
    return Array.from(output);
  }

  function weightedMeanVectors(items, key, at, halfLifeSeconds) {
    const vectors = items.map(item => item[key]).filter(vector => vector?.length);
    if (!vectors.length) return [];
    const length = Math.min(...vectors.map(vector => vector.length));
    const output = new Float32Array(length);
    let totalWeight = 0;
    for (const item of items) {
      const vector = item[key];
      if (!vector?.length) continue;
      const ageSeconds = Math.max(0, at - item.at) / 1000;
      const weight = Math.pow(0.5, ageSeconds / Math.max(0.5, halfLifeSeconds));
      totalWeight += weight;
      for (let index = 0; index < length; index++) output[index] += vector[index] * weight;
    }
    if (totalWeight) for (let index = 0; index < length; index++) output[index] /= totalWeight;
    return Array.from(output);
  }

  function cosineSimilarity(left = [], right = []) {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let index = 0; index < length; index++) {
      const a = Number(left[index]) || 0;
      const b = Number(right[index]) || 0;
      dot += a * b;
      aNorm += a * a;
      bNorm += b * b;
    }
    if (!aNorm || !bNorm) return 0;
    return Math.min(1, Math.max(0, dot / Math.sqrt(aNorm * bNorm)));
  }

  class Aggregator {
    constructor(windows = { fast: 5, mid: 12, long: 30 }) {
      this.windows = windows;
      this.reset();
    }

    reset() {
      this.items = [];
      this.sections = [];
    }

    add(outputs, at = Date.now()) {
      if (!outputs) return this.snapshot(at);
      this.items.push({ at, ...outputs });
      if (outputs.embedding?.length) {
        const previousSection = this.sections[this.sections.length - 1];
        const separated = !previousSection || at - previousSection.at >= 8000;
        const distinct = !previousSection || cosineSimilarity(previousSection.embedding, outputs.embedding) < 0.9;
        if (!previousSection || separated && distinct) {
          this.sections.push({ at, embedding: Array.from(outputs.embedding) });
          if (this.sections.length > 12) this.sections.splice(0, this.sections.length - 12);
        }
      }
      const oldest = at - (Math.max(...Object.values(this.windows)) + 3) * 1000;
      this.items = this.items.filter(item => item.at >= oldest);
      return this.snapshot(at);
    }

    snapshot(at = Date.now()) {
      const scales = {};
      for (const [name, seconds] of Object.entries(this.windows)) {
        const items = this.items.filter(item => item.at >= at - seconds * 1000);
        scales[name] = {
          count: items.length,
          genre: weightedMeanVectors(items, "genre", at, seconds * 0.48),
          embedding: weightedMeanVectors(items, "embedding", at, seconds * 0.48),
          instrument: weightedMeanVectors(items, "instrument", at, seconds * 0.48),
          mood: weightedMeanVectors(items, "mood", at, seconds * 0.48)
        };
      }
      const scaleWeights = { fast: 0.22, mid: 0.33, long: 0.45 };
      const available = Object.entries(scales).filter(([, scale]) => scale.count);
      const totalWeight = available.reduce((sum, [name]) => sum + (scaleWeights[name] || 1), 0) || 1;
      const blend = key => {
        const length = Math.min(...available.map(([, scale]) => scale[key].length).filter(Boolean));
        if (!Number.isFinite(length)) return [];
        const output = new Float32Array(length);
        for (const [name, scale] of available) {
          const weight = (scaleWeights[name] || 1) / totalWeight;
          for (let index = 0; index < length; index++) output[index] += scale[key][index] * weight;
        }
        return Array.from(output);
      };
      const genre = blend("genre");
      const embedding = blend("embedding");
      const relevant = this.items.filter(item => item.at >= at - Math.max(...Object.values(this.windows)) * 1000);
      const agreement = (key, reference) => relevant.length && reference.length
        ? relevant.reduce((sum, item) => sum + cosineSimilarity(item[key], reference), 0) / relevant.length
        : 0;
      const embeddingVariance = relevant.length && embedding.length
        ? relevant.reduce((sum, item) => sum + (1 - cosineSimilarity(item.embedding, embedding)), 0) / relevant.length
        : 0;
      return {
        scales,
        genre,
        embedding,
        trackEmbedding: {
          shortTerm: scales.fast?.embedding || [],
          rollingCentroid: scales.long?.embedding || embedding,
          variance: embeddingVariance,
          sections: this.sections.map(section => ({ at: section.at, embedding: section.embedding }))
        },
        instrument: blend("instrument"),
        mood: blend("mood"),
        diagnostics: {
          observations: relevant.length,
          contextSeconds: relevant.length > 1 ? (at - relevant[0].at) / 1000 : 0,
          genreAgreement: agreement("genre", genre),
          embeddingAgreement: agreement("embedding", embedding),
          embeddingVariance,
          sectionCount: this.sections.length
        }
      };
    }
  }

  return { Aggregator, meanVectors, weightedMeanVectors, cosineSimilarity };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TemporalModelAggregation;
