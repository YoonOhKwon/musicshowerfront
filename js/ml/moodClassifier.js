const MoodClassifier = (() => {
  const positive = new Set(["energetic", "bright", "happy", "uplifting", "party", "groovy", "warm"]);
  const negative = new Set(["dark", "sad", "melancholic", "aggressive", "tense", "cold"]);

  function classify(output, labels = [], options = {}) {
    const tags = GenreClassifier.classify(output, labels, {
      topK: labels.length,
      activation: options.activation || "sigmoid"
    }).filter(item => item.confidence >= (options.threshold ?? 0.035)).slice(0, options.limit || 8);
    const score = label => tags.find(item => item.label.toLowerCase() === label)?.confidence || 0;
    const positiveMean = tags.filter(item => positive.has(item.label.toLowerCase()))
      .reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, tags.filter(item => positive.has(item.label.toLowerCase())).length);
    const negativeMean = tags.filter(item => negative.has(item.label.toLowerCase()))
      .reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, tags.filter(item => negative.has(item.label.toLowerCase())).length);
    return {
      tags,
      evidence: tags[0]?.confidence || 0,
      dimensions: {
        valence: Math.min(1, Math.max(0, 0.5 + positiveMean * 0.5 - negativeMean * 0.5)),
        arousal: Math.max(score("energetic"), score("aggressive"), score("party"), 0.35),
        tension: Math.max(score("tense"), score("aggressive"), score("dark"), 0.25),
        warmth: Math.max(score("warm"), score("romantic"), 0.35),
        brightness: Math.max(score("bright"), score("happy"), score("uplifting"), 0.35),
        spaciousness: Math.max(score("spacious"), score("ambient"), score("ethereal"), score("dreamy"), 0.35)
      }
    };
  }

  return { classify };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MoodClassifier;
