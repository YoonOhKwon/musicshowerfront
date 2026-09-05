const LanguageDiversityMetrics = (() => {
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Cliche = typeof ClicheScore !== "undefined" ? ClicheScore : require("./clicheScore");
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
      groundingRate: groundingRate(items), repetitionRate: repetitionRate(items, options.shortWindow || 6),
      layerDistribution: layerDistribution(items), clicheDistribution: clicheDistribution(items, options.shortWindow || 8) };
  }

  // Section 3/6: how much of the DECLARED axis space (data/aestheticAxes.json) actually has
  // vocabulary keyed to it? Bucketing a 10+ dimensional space into a true grid is combinatorially
  // absurd, so this buckets PER AXIS instead -- for each axis, which coarse bands (low/mid/high)
  // has at least one region/vocabulary entry gating on it? A (axis, band) cell with zero entries
  // is a genuine blind spot: no word can ever fire there, no matter how strong that evidence gets.
  // Accepts either data/aestheticRegions.json-style entries (`requires`) or
  // data/aestheticVocabulary.generated.json-style entries (`region`) -- same shape otherwise.
  const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
  function axisCoverage(entries = [], axisNames = [], { bins = 3 } = {}) {
    const labels = bins === 3 ? ["low", "mid", "high"] : Array.from({ length: bins }, (_, index) => `bin${index}`);
    const binIndex = value => Math.min(bins - 1, Math.floor(clamp01(value) * bins));
    const counts = new Map();
    for (const axis of axisNames) for (let bin = 0; bin < bins; bin++) counts.set(`${axis}:${bin}`, 0);
    for (const entry of entries || []) {
      for (const condition of entry?.requires || entry?.region || []) {
        if (!condition || !axisNames.includes(condition.axis)) continue;
        const key = `${condition.axis}:${binIndex(Number.isFinite(condition.min) ? condition.min : 0)}`;
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
    }
    const cells = [...counts.entries()].map(([key, count]) => {
      const [axis, bin] = key.split(":");
      return { axis, band: labels[Number(bin)], count };
    });
    const blindSpots = cells.filter(cell => cell.count === 0);
    return { bands: labels, cells, blindSpots, blindSpotRatio: cells.length ? blindSpots.length / cells.length : 0 };
  }

  // Section 6: how much vocabulary is even SPEAKABLE, per epistemic layer -- not how it was used
  // in one song's stream (that's evaluate()/facetCoverage above), but the size of the underlying
  // pool a caller assembles from data/musicalLexicon.json, data/aestheticRegions.json,
  // impressionSynthesizer.RULES, etc. Distinct TEXT per layer, since the same wording counted
  // twice across two data files is not additional vocabulary.
  function vocabularyPoolSize(items = []) {
    const byLayer = {};
    for (const layer of Layers.names) byLayer[layer] = new Set();
    for (const item of items || []) {
      if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
      const layer = Layers.decorate(item).layer;
      (byLayer[layer] || (byLayer[layer] = new Set())).add(item.text);
    }
    const byLayerCounts = Object.fromEntries(Object.entries(byLayer).map(([layer, set]) => [layer, set.size]));
    return { total: Object.values(byLayerCounts).reduce((sum, count) => sum + count, 0), byLayer: byLayerCounts };
  }

  // Section 6: what fraction of a SELECTED stream actually spoke in each epistemic layer. The
  // reform's target is roughly 30-50% open layer (AESTHETIC+IMPRESSION combined) -- too little
  // means the open layer is still effectively silent despite existing; too much means raw
  // measurement/context is being crowded out by impression.
  function layerDistribution(items = []) {
    const total = items.length;
    const byLayer = Object.fromEntries(Layers.names.map(layer =>
      [layer, ratio(items.filter(item => Layers.decorate(item).layer === layer).length, total)]));
    return { byLayer, openLayerRatio: (byLayer.AESTHETIC || 0) + (byLayer.IMPRESSION || 0) };
  }

  // Section 1/6: js/semantic/clicheScore.js grades a phrase instead of vetoing it in the open
  // layer -- this reports the resulting distribution across a selected stream's open-layer items,
  // so "did the cliche score actually stay low in practice" is measurable, not just theorized.
  // Recency is evaluated the same way phraseSelection.js's weight() does: against the items
  // already emitted before each one in the stream, not the whole stream at once.
  function clicheDistribution(items = [], recentWindow = 8) {
    const openLayerItems = items.map((item, index) => ({ item, index }))
      .filter(({ item }) => ["AESTHETIC", "IMPRESSION"].includes(Layers.decorate(item).layer));
    const scores = openLayerItems.map(({ item, index }) =>
      Cliche.score(item.text, items.slice(Math.max(0, index - recentWindow), index)));
    if (!scores.length) return { count: 0, mean: 0, max: 0 };
    return { count: scores.length, mean: scores.reduce((sum, value) => sum + value, 0) / scores.length, max: Math.max(...scores) };
  }

  return { concepts, intraSongDiversity, jaccard, facetCoverage, specificityRatio, groundingRate, repetitionRate,
    axisCoverage, vocabularyPoolSize, layerDistribution, clicheDistribution, evaluate };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LanguageDiversityMetrics;
