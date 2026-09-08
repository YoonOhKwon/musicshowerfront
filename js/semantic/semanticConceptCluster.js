// Conservative lexical clustering for surface-diversity scoring.
// This is not a developer aesthetic ontology: it never names genres, scenes, or vibe families.
// Identical meaning after light stemming / synonym collapse is one cluster; paraphrase count is not.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SemanticConceptCluster = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SYNONYMS = Object.freeze([
    ["향수", "노스탤", "회고", "추억", "nostalg"],
    ["애상", "쓸쓸", "멜랑", "우수", "슬픔"],
    ["경쾌", "들뜬", "발랄", "상쾌"],
    ["긴장", "조임", "불안"],
    ["질주", "돌진", "폭주"]
  ]);

  function normalize(text) {
    return String(text || "").toLowerCase()
      .replace(/(?:적인|스러운|스럽다|하는|한|의|을|를|이|가|은|는|들|感|감)$/g, "")
      .replace(/[\s·・,._\-/'()]+/g, "");
  }

  function clusterKey(input) {
    const text = typeof input === "object" ? (input.canonicalText || input.sourceText || input.text) : input;
    const value = normalize(text);
    if (!value) return "";
    const group = SYNONYMS.findIndex(list => list.some(word => value.includes(word)));
    if (group >= 0) return `syn:${group}`;
    return value.slice(0, 32);
  }

  function sameCluster(left, right) {
    const a = clusterKey(left);
    const b = clusterKey(right);
    return Boolean(a && a === b);
  }

  function inspect(entries = []) {
    const clusters = new Set();
    const surfaces = new Set();
    for (const entry of entries) {
      const key = clusterKey(entry);
      if (key) clusters.add(key);
      const family = Array.isArray(entry?.family) ? entry.family : [entry?.text || entry?.canonicalText];
      for (const surface of family) if (surface) surfaces.add(String(surface));
    }
    return {
      canonicalConceptCount: entries.length,
      semanticClusterCount: clusters.size,
      surfacePhraseCount: surfaces.size
    };
  }

  return { clusterKey, sameCluster, inspect, normalize, SYNONYMS };
});
