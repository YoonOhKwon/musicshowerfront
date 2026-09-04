// Semantic coverage map: which claim/operator families have enough realizations.
// Vocabulary research uses this; runtime generation does not write production knowledge.
const VocabularyCoverage = (() => {
  function key(item = {}) {
    return item.genome || `${item.layer || "?"}:${item.operator || "ATOMIC"}:${item.concept || item.text || ""}`;
  }

  function measure(candidates = []) {
    const byGenome = new Map();
    const byLayer = {};
    for (const item of candidates) {
      const genome = key(item);
      const list = byGenome.get(genome) || [];
      list.push(item.text);
      byGenome.set(genome, [...new Set(list)]);
      const layer = item.layer || "FACT";
      byLayer[layer] = (byLayer[layer] || 0) + 1;
    }
    const regions = [...byGenome.entries()].map(([genome, texts]) => ({
      genome, count: texts.length, texts
    })).sort((a, b) => a.count - b.count);
    return {
      regions,
      sparse: regions.filter(item => item.count <= 2),
      rich: regions.filter(item => item.count >= 5),
      byLayer,
      genericRatio: candidates.length
        ? candidates.filter(item => /네온|별빛|유리빛|신비로운 감성/.test(item.text || "")).length / candidates.length
        : 0
    };
  }

  function researchPrompt(coverage, signature = "") {
    const sparse = (coverage.sparse || []).slice(0, 8).map(item =>
      `${item.genome} → ${item.count} realization(s): ${item.texts.join(", ")}`).join("\n");
    return [
      "You are Music Shower's vocabulary researcher, not an analyst.",
      "Do not invent musical facts or new context relations.",
      signature ? `Observed feature signature:\n${signature}` : "",
      "Sparse semantic regions that need more short Korean realizations:",
      sparse || "(none)",
      "Propose 4–8 new realizations that keep the same genome/meaning."
    ].filter(Boolean).join("\n\n");
  }

  return { key, measure, researchPrompt };
})();

if (typeof module !== "undefined" && module.exports) module.exports = VocabularyCoverage;
