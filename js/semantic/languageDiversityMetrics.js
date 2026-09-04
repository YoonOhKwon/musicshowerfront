const LanguageDiversityMetrics = (() => {
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const ratio = (part, total) => total ? part / total : 0;
  const tail = (items, count) => (items || []).slice(-Math.max(1, count));
  const concepts = items => new Set((items || []).map(item => Quality.conceptKey(item)));

  function intraSongDiversity(items = [], window = 30) {
    const sample = tail(items, window);
    return ratio(concepts(sample).size, sample.length);
  }

  function jaccard(left = [], right = []) {
    const a = concepts(left), b = concepts(right);
    const union = new Set([...a, ...b]);
    return ratio([...a].filter(key => b.has(key)).length, union.size);
  }

  function facetCoverage(items = []) {
    const facets = [...new Set(items.map(item => Quality.musicalFacet(item)))];
    return { count: facets.length, facets };
  }

  function specificityRatio(items = []) {
    return ratio(items.filter(item => (item.specificityTier || Quality.specificityTier(item)) >= 3).length, items.length);
  }

  function groundingRate(items = []) {
    const factual = items.map(item => Layers.decorate(item)).filter(item => ["FACT", "LIVE"].includes(item.layer));
    return ratio(factual.filter(item => item.anchors.length > 0 &&
      (item.evidenceScore === undefined || item.evidenceScore >= 0.45)).length, factual.length);
  }

  function repetitionRate(items = [], shortWindow = 6) {
    let repeats = 0;
    for (let index = 0; index < items.length; index++) {
      const recent = items.slice(Math.max(0, index - shortWindow), index);
      if (recent.some(item => Quality.sameConcept(item, items[index]) ||
        Quality.semanticFamily(item) === Quality.semanticFamily(items[index]))) repeats++;
    }
    return ratio(repeats, items.length);
  }

  function evaluate(items = [], options = {}) {
    return { phraseCount: items.length, intraSongUniqueConceptRatio: intraSongDiversity(items, options.window || 30),
      facetCoverage: facetCoverage(items), specificityRatio: specificityRatio(items),
      groundingRate: groundingRate(items), repetitionRate: repetitionRate(items, options.shortWindow || 6) };
  }

  return { concepts, intraSongDiversity, jaccard, facetCoverage, specificityRatio, groundingRate, repetitionRate, evaluate };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LanguageDiversityMetrics;
