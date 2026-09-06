const EvidenceFusion = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const SOURCE_WEIGHT = Object.freeze({
    genreModel: 1, embedding: 0.92, mir: 0.88, instrumentModel: 0.9,
    rhythm: 0.86, context: 0.76, local: 0.72, production: 0.78
  });
  const keyFor = item => `${item.category || "live"}:${String(item.text || "").trim().toLowerCase()}`;
  const dependencyFamily = (source, item) => item.evidenceFamily || item.sourceFamily ||
    (item.category === "genre" && ["local", "genreModel"].includes(source) ? "genre-classifier" : source);

  class Engine {
    fuse(groups = {}, at = Date.now()) {
      const map = new Map();
      for (const [source, items] of Object.entries(groups)) {
        // Anti-hallucination firewall: phrased words or displayed language outputs
        // must NEVER become upstream evidence.
        if (["words", "language", "phrasePool", "displayed", "llm-output"].includes(source)) {
          continue;
        }
        for (const item of items || []) {
          if (!item?.text || !item?.category) continue;
          const key = keyFor(item);
          const entry = map.get(key) || { ...item, confidence: 0, sources: {}, sourceFamilies: {}, anchors: [], timestamp: at };
          const confidence = clamp(item.confidence ?? item.weight ?? item.score);
          entry.sources[source] = Math.max(entry.sources[source] || 0, confidence);
          const family = dependencyFamily(source, item);
          entry.sourceFamilies[family] = Math.max(entry.sourceFamilies[family] || 0, confidence);
          entry.anchors = [...new Set([...(entry.anchors || []), ...(item.anchors || [])])].slice(0, 10);
          map.set(key, entry);
        }
      }
      return [...map.values()].map(item => {
        const evidence = Object.entries(item.sources);
        const weighted = evidence.reduce((sum, [source, score]) => sum + score * (SOURCE_WEIGHT[source] || 0.7), 0);
        const weights = evidence.reduce((sum, [source]) => sum + (SOURCE_WEIGHT[source] || 0.7), 0);
        const independentEvidenceCount = Object.keys(item.sourceFamilies).length;
        const independentBoost = Math.min(0.12, Math.max(0, independentEvidenceCount - 1) * 0.045);
        const confidence = clamp(weighted / Math.max(0.001, weights) + independentBoost);
        return { ...item, confidence, weight: confidence, evidenceCount: evidence.length, independentEvidenceCount,
          source: item.source || "local", fusionSources: evidence.map(([source]) => source), timestamp: at };
      }).sort((a, b) => b.confidence - a.confidence);
    }
  }
  return { Engine, SOURCE_WEIGHT };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EvidenceFusion;
