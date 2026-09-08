const ConfidenceCalibration = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function normalizedEntropy(predictions = []) {
    const scores = predictions.map(item => Math.max(0, Number(item.confidence) || 0));
    const total = scores.reduce((sum, value) => sum + value, 0);
    if (!total || scores.length < 2) return scores.length ? 0 : 1;
    const entropy = scores.reduce((sum, value) => {
      const probability = value / total;
      return sum - (probability ? probability * Math.log(probability) : 0);
    }, 0);
    return clamp(entropy / Math.log(scores.length));
  }

  // Calibration answers a semantic question only: "how much does the CURRENT model output
  // support this label?" Persistence belongs to the genre tracker/hypothesis engine and is
  // returned as diagnostics, never added to this score. Otherwise a weak guess inevitably grows
  // into a confident claim merely because it was repeated.
  function calibrate({ predictions = [], stability = 0, temporalAgreement = 0, familyFor = () => "Unknown" } = {}) {
    const ranked = [...predictions].sort((left, right) => right.confidence - left.confidence);
    const top = ranked[0]?.confidence || 0;
    const second = ranked[1]?.confidence || 0;
    const margin = Math.max(0, top - second);
    const rawStrength = clamp((top - 0.012) / 0.105);
    const marginStrength = clamp(margin / Math.max(0.008, top * 0.32));
    const entropy = normalizedEntropy(ranked);
    const normalizedMargin = top > 0 ? clamp(margin / top) : 0;
    const topFamily = ranked[0] ? familyFor(ranked[0].label) : "Unknown";
    const total = ranked.reduce((sum, item) => sum + Math.max(0, item.confidence), 0) || 1;
    const familyConsistency = clamp(ranked
      .filter(item => familyFor(item.label) === topFamily)
      .reduce((sum, item) => sum + Math.max(0, item.confidence), 0) / total);
    const semanticConfidence = clamp(
      rawStrength * 0.5 +
      marginStrength * 0.25 +
      familyConsistency * 0.15 +
      (1 - entropy) * 0.1
    );
    const differentFamilyRunnerUp = ranked[1] && familyFor(ranked[1].label) !== topFamily;
    const hybrid = Boolean(ranked[1] && differentFamilyRunnerUp && margin < Math.max(0.012, top * 0.24));
    const unknown = top < 0.016 || semanticConfidence < 0.2;
    const certainty = unknown ? "unknown"
      : hybrid ? "hybrid"
      : semanticConfidence >= 0.67 ? "certain"
      : semanticConfidence >= 0.43 ? "probable"
      : "uncertain";
    return {
      confidence: semanticConfidence,
      semanticConfidence,
      reliability: semanticConfidence,
      displayConfidence: semanticConfidence,
      temporalStability: clamp(stability),
      rawConfidence: top,
      rawTopScore: top,
      runnerUpScore: second,
      margin,
      normalizedMargin,
      entropy,
      temporalAgreement: clamp(temporalAgreement),
      familyConsistency,
      hybrid,
      unknown,
      uncertain: unknown || semanticConfidence < 0.34,
      certainty,
      related: ranked.slice(1, 5)
    };
  }

  return { calibrate, normalizedEntropy, clamp };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ConfidenceCalibration;
