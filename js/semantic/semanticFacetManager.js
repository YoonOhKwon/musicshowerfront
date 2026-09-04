const SemanticFacetManager = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Expressions = typeof MusicExpressionEngine !== "undefined" ? MusicExpressionEngine : require("./musicExpressionEngine");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const decorateAll = candidates => (candidates || []).filter(Boolean).map(item => Layers.decorate(item));
  function base(state) {
    const generated = Expressions.generate(state);
    if (state.expressionFeatures?.audible === false) return decorateAll(generated);
    return decorateAll([...generated, ...(state.instrumentFacetCandidates || []), ...(state.rhythmFacetCandidates || []),
      ...(state.productionFacetCandidates || []), ...(state.genreContextEvidence?.candidates || []),
      ...(state.arrangementFacetCandidates || []), ...(state.detectedIdioms || []),
      ...(state.primitiveObservationCandidates || []),
      ...(state.impressionFacetCandidates || []), ...(state.composedFactCandidates || []),
      ...(state.liveEventCandidates || []), ...(state.aestheticConceptCandidates || [])].slice(0, 140));
  }
  function local(state) {
    const stabilized = state.stateV2?.displayCandidates;
    return Array.isArray(stabilized) && stabilized.length ? decorateAll(stabilized.slice(0, 120)) : base(state);
  }
  function group(candidates) {
    const output = Facets.empty();
    for (const candidate of candidates) {
      const item = Layers.decorate(candidate);
      if (output[item.category]) output[item.category].push(item);
    }
    return output;
  }
  // Evidence decides what exists; the layer/facet cycles only prevent one perspective
  // from monopolizing a pool and never invent candidates to fill a quota.
  function curate(candidates, limit = 40) {
    const ordered = decorateAll(candidates).sort((a, b) =>
      (b.score || b.evidenceScore || b.weight || 0) - (a.score || a.evidenceScore || a.weight || 0));
    const groups = group(ordered);
    const selected = [], seen = new Set(), seenText = new Set();
    const layerOrder = ["FACT", "CONTEXT", "LIVE", "FACT", "AESTHETIC", "IMPRESSION"];
    const facetsByLayer = {
      LIVE: ["live"],
      FACT: ["performance", "instrumentation", "rhythm", "production", "arrangement", "dynamics"],
      CONTEXT: ["genre", "lineage", "era", "scene", "culture", "association"],
      AESTHETIC: ["association", "mood"], IMPRESSION: ["mood"]
    };
    const cursor = Object.fromEntries(Facets.names.map(facet => [facet, 0]));
    for (let round = 0; round < 16 && selected.length < limit; round++) {
      for (const layer of layerOrder) {
        const facets = facetsByLayer[layer];
        let item;
        for (let offset = 0; offset < facets.length; offset++) {
          const facet = facets[(round + offset) % facets.length];
          while (groups[facet][cursor[facet]] && groups[facet][cursor[facet]].layer !== layer) cursor[facet]++;
          const candidate = groups[facet][cursor[facet]];
          if (candidate) { item = candidate; cursor[facet]++; break; }
        }
        if (!item) continue;
        const key = Quality.conceptKey(item), literal = Quality.literalKey(item);
        if (seen.has(key) || seenText.has(literal)) continue;
        selected.push(item); seen.add(key); seenText.add(literal);
        if (selected.length >= limit) break;
      }
    }
    for (const item of ordered) {
      if (selected.length >= limit) break;
      const key = Quality.conceptKey(item), literal = Quality.literalKey(item);
      if (!seen.has(key) && !seenText.has(literal)) {
        selected.push(item); seen.add(key); seenText.add(literal);
      }
    }
    return selected;
  }
  return { base, local, group, curate };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SemanticFacetManager;
