const InstrumentClassifier = (() => {
  const thresholds = {
    voice: 0.18, drums: 0.2, percussion: 0.16, bass: 0.2,
    electricguitar: 0.18, acousticguitar: 0.16, synthesizer: 0.2,
    piano: 0.18, strings: 0.16, orchestra: 0.16
  };

  function classify(output, labels = [], { limit = 6, threshold = 0.2, activation = "sigmoid" } = {}) {
    return GenreClassifier.classify(output, labels, { topK: labels.length, activation })
      .map(item => ({ ...item, rawConfidence: item.confidence }))
      .filter(item => item.confidence >= (thresholds[item.label.toLowerCase()] ?? threshold))
      .slice(0, limit);
  }

  return { classify, thresholds };
})();

if (typeof module !== "undefined" && module.exports) module.exports = InstrumentClassifier;
