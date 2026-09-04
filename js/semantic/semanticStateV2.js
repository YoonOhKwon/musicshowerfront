const SemanticStateV2 = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const LanguageLayers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  function build({ fusion = [], temporal = {}, mir = null, layers = {} } = {}, at = Date.now()) {
    const facets = Facets.empty();
    for (const item of temporal.displayCandidates || fusion) if (facets[item.category]) facets[item.category].push(item);
    const displayCandidates = Object.values(facets).flat().map(item => LanguageLayers.decorate(item))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return {
      version: 2,
      facets,
      displayCandidates,
      phraseLayers: Object.fromEntries(LanguageLayers.names.map(layer =>
        [layer, displayCandidates.filter(item => item.layer === layer)])),
      mir,
      temporal: {
        windows: temporal.windows || { fastMs: 200, musicalMs: 5000, contextMs: 30000 },
        elapsedMs: temporal.elapsedMs || 0,
        revision: temporal.revision || 0,
        stable: temporal.stable || [],
        trackMemory: temporal.trackMemory || []
      },
      layers: {
        realtimeDSP: layers.realtimeDSP !== false,
        mir: Boolean(mir),
        genreModel: Boolean(layers.genreModel),
        embedding: layers.embedding || "unavailable",
        language: layers.language || "fallback"
      },
      updatedAt: at
    };
  }
  return { build };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SemanticStateV2;
