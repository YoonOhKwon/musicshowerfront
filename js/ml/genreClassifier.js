const GenreClassifier = (() => {
  const sigmoid = value => 1 / (1 + Math.exp(-Number(value || 0)));
  const softmax = values => {
    if (!values?.length) return [];
    const peak = Math.max(...values);
    const exponentials = values.map(value => Math.exp(Number(value || 0) - peak));
    const total = exponentials.reduce((sum, value) => sum + value, 0) || 1;
    return exponentials.map(value => value / total);
  };

  function classify(output, labels = [], { topK = 5, activation = "sigmoid" } = {}) {
    const raw = Array.from(output || []);
    if (!raw.length || raw.length !== labels.length) return [];
    const scores = activation === "softmax"
      ? softmax(raw)
      : activation === "identity" ? raw.map(value => Math.min(1, Math.max(0, Number(value) || 0))) : raw.map(sigmoid);
    return scores.map((confidence, index) => ({ label: labels[index], confidence }))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, topK);
  }

  return { classify, sigmoid, softmax };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreClassifier;
