const GenreTracking = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function normalizePredictions(predictions = []) {
    const clean = predictions
      .map(item => ({
        label: String(item.label || item.name || "").trim(),
        confidence: clamp(item.confidence ?? item.score)
      }))
      .filter(item => item.label);
    const total = clean.reduce((sum, item) => sum + item.confidence, 0);
    if (!total) return [];
    return clean.map(item => ({ ...item, probability: item.confidence / total }))
      .sort((left, right) => right.confidence - left.confidence);
  }

  function entropy(predictions = []) {
    const normalized = normalizePredictions(predictions);
    if (normalized.length < 2) return normalized.length ? 0 : 1;
    return clamp(-normalized.reduce((sum, item) =>
      sum + (item.probability > 0 ? item.probability * Math.log(item.probability) : 0), 0
    ) / Math.log(normalized.length));
  }

  function assessUncertainty(predictions = [], options = {}) {
    const normalized = normalizePredictions(predictions);
    const top = normalized[0]?.confidence || 0;
    const margin = top - (normalized[1]?.confidence || 0);
    const predictionEntropy = entropy(normalized);
    const uncertain =
      top < (options.unknownThreshold ?? 0.35) ||
      margin < (options.marginThreshold ?? 0.1) ||
      predictionEntropy > (options.entropyThreshold ?? 0.82);
    return { uncertain, confidence: top, margin, entropy: predictionEntropy };
  }

  function blendMap(target, predictions, alpha) {
    const incoming = new Map(predictions.map(item => [item.label, item.confidence]));
    const labels = new Set([...target.keys(), ...incoming.keys()]);
    for (const label of labels) {
      const next = (target.get(label) || 0) * (1 - alpha) + (incoming.get(label) || 0) * alpha;
      if (next < 0.0005) target.delete(label);
      else target.set(label, next);
    }
  }

  function ranked(map, topK) {
    return [...map.entries()]
      .map(([label, confidence]) => ({ label, confidence }))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, topK);
  }

  class GenreTracker {
    constructor(options = {}) {
      this.options = {
        topK: 5,
        unknownThreshold: 0.35,
        marginThreshold: 0.1,
        entropyThreshold: 0.82,
        switchMargin: 0.1,
        persistence: 3,
        ...options
      };
      this.reset();
    }

    reset() {
      this.fast = new Map();
      this.mid = new Map();
      this.long = new Map();
      this.primary = null;
      this.pending = null;
      this.pendingCount = 0;
      this.stability = 0;
    }

    update(rawPredictions = [], { novelty = 0, familyFor = () => "Unknown" } = {}) {
      const predictions = normalizePredictions(rawPredictions).slice(0, this.options.topK);
      if (!predictions.length) return this.snapshot([], familyFor);
      const noveltyScore = clamp(novelty);
      blendMap(this.fast, predictions, 0.62 + noveltyScore * 0.28);
      blendMap(this.mid, predictions, 0.24 + noveltyScore * 0.38);
      blendMap(this.long, predictions, 0.08 + noveltyScore * 0.14);

      const fastWeight = 0.25 + noveltyScore * 0.35;
      const longWeight = 0.35 - noveltyScore * 0.22;
      const midWeight = 1 - fastWeight - longWeight;
      const labels = new Set([...this.fast.keys(), ...this.mid.keys(), ...this.long.keys()]);
      const fused = [...labels].map(label => ({
        label,
        confidence:
          (this.fast.get(label) || 0) * fastWeight +
          (this.mid.get(label) || 0) * midWeight +
          (this.long.get(label) || 0) * longWeight
      })).sort((left, right) => right.confidence - left.confidence);

      const candidate = fused[0];
      const currentScore = fused.find(item => item.label === this.primary)?.confidence || 0;
      const canSwitch = !this.primary || candidate.label === this.primary ||
        candidate.confidence >= currentScore + this.options.switchMargin || noveltyScore > 0.55;
      if (candidate.label === this.primary) {
        this.pending = null;
        this.pendingCount = 0;
        this.stability = clamp(this.stability + 0.12);
      } else if (canSwitch) {
        if (candidate.label !== this.pending) {
          this.pending = candidate.label;
          this.pendingCount = 1;
        } else {
          this.pendingCount += 1;
        }
        const required = noveltyScore > 0.55 ? 1 : this.options.persistence;
        if (this.pendingCount >= required) {
          this.primary = candidate.label;
          this.pending = null;
          this.pendingCount = 0;
          this.stability = noveltyScore > 0.55 ? 0.35 : 0.55;
        }
      }
      if (!this.primary) this.primary = candidate.label;
      return this.snapshot(fused, familyFor);
    }

    snapshot(fused = [], familyFor = () => "Unknown") {
      const topK = normalizePredictions(fused).slice(0, this.options.topK);
      const uncertainty = assessUncertainty(topK, this.options);
      const primary = topK.find(item => item.label === this.primary) || topK[0] || null;
      return {
        family: primary ? familyFor(primary.label) : "Unknown",
        primary: primary?.label || "미확정 장르",
        secondary: topK.filter(item => item.label !== primary?.label).slice(0, this.options.topK - 1),
        topK,
        confidence: primary?.confidence || 0,
        entropy: uncertainty.entropy,
        margin: uncertainty.margin,
        stability: this.stability,
        uncertain: uncertainty.uncertain
      };
    }
  }

  return { GenreTracker, assessUncertainty, entropy, normalizePredictions };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreTracking;
