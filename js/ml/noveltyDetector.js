const NoveltyDetector = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const distance = (left = [], right = []) => {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let total = 0;
    for (let index = 0; index < length; index++) {
      total += Math.abs(clamp(left[index]) - clamp(right[index]));
    }
    return total / length;
  };

  const cosineDistance = (left = [], right = []) => {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < length; index++) {
      const a = Number(left[index]) || 0;
      const b = Number(right[index]) || 0;
      dot += a * b;
      leftNorm += a * a;
      rightNorm += b * b;
    }
    if (!leftNorm || !rightNorm) return 0;
    return clamp(1 - dot / Math.sqrt(leftNorm * rightNorm));
  };

  function featureVector(snapshot = {}) {
    return [
      clamp((snapshot.rms || 0) * 4),
      clamp((snapshot.flux || 0) * 14),
      clamp((snapshot.centroid || 0) / 12000),
      clamp((snapshot.bpm || 0) / 200),
      clamp((snapshot.onsetRate || 0) / 8),
      clamp(snapshot.bass || 0),
      clamp(snapshot.mid || 0),
      clamp(snapshot.high || 0),
      ...(snapshot.chroma || []).slice(0, 12).map(clamp),
      ...(snapshot.mfcc || []).slice(0, 8).map(value => clamp((Number(value) + 100) / 200))
    ];
  }

  class Detector {
    constructor({ smoothing = 0.3, threshold = 0.34 } = {}) {
      this.smoothing = clamp(smoothing);
      this.threshold = clamp(threshold);
      this.reset();
    }

    reset() {
      this.previous = null;
      this.score = 0;
    }

    update(snapshot = {}, embedding = null) {
      const current = featureVector(snapshot);
      if (!this.previous) {
        this.previous = { features: current, embedding };
        return { score: 0, transitionDetected: false };
      }
      const dspDistance = distance(current, this.previous.features);
      const embeddingDistance = embedding && this.previous.embedding
        ? cosineDistance(embedding, this.previous.embedding)
        : dspDistance;
      const raw = clamp(dspDistance * 0.72 + embeddingDistance * 0.28);
      this.score += (raw - this.score) * this.smoothing;
      this.previous = { features: current, embedding: embedding || this.previous.embedding };
      return {
        score: this.score,
        dspDistance,
        embeddingDistance,
        transitionDetected: this.score >= this.threshold
      };
    }
  }

  return { Detector, featureVector, distance, cosineDistance };
})();

if (typeof module !== "undefined" && module.exports) module.exports = NoveltyDetector;
