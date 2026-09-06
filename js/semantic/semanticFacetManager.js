const SemanticFacetManager = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Expressions = typeof MusicExpressionEngine !== "undefined" ? MusicExpressionEngine : require("./musicExpressionEngine");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const GenreLabels = typeof GenreLabelShape !== "undefined" ? GenreLabelShape : require("./genreLabelShape");
  const DirectAudioRealizer = (typeof globalThis !== "undefined" && globalThis.DirectAudioRealizer)
    ? globalThis.DirectAudioRealizer
    : (typeof require !== "undefined" ? (() => { try { return require("../../lib/directAudioRealizer"); } catch { return null; } })() : null);
  const decorateAll = candidates => (candidates || []).filter(Boolean).map(item => Layers.decorate(item));
  const normalize = text => String(text || "").toLowerCase().replace(/[\s_&'().,\-]+/g, "");
  function realizeOpenWorldGenre(item, state) {
    if (item.category !== "genre" || (item.source !== "directAudio" && item.sourceFamily !== "directAudio")) return item;
    const concept = (state.openWorldConcepts || []).find(candidate =>
      ["genre", "microgenre"].includes(candidate.conceptType) &&
      normalize(candidate.canonicalLabel) === normalize(item.sourceText || item.text));
    if (!concept) return item;
    const label = concept.canonicalLabel || item.text;
    const text = concept.status === "stable" ? label
      : concept.status === "provisional" ? `${label} 계열`
        : concept.status === "emerging" ? `${label} 가능성` : `${label} 연상`;
    return Layers.decorate({ ...item, text, canonicalText: label, beliefStatus: concept.status });
  }
  function realizeCandidate(item, state) {
    if (item.requiresKoreanRealization === true) {
      const family = Array.isArray(item.realizations) && item.realizations.length
        ? item.realizations
        : (DirectAudioRealizer ? DirectAudioRealizer.realize(item.canonicalText || item.sourceText || item.text, item.category) : []);
      if (family && family.length && /[가-힣]/.test(family[0])) {
        return Layers.decorate({
          ...item,
          canonicalText: item.canonicalText || item.sourceText || item.text,
          text: family[0],
          requiresKoreanRealization: false,
          realizations: family
        });
      }
    }
    return realizeOpenWorldGenre(item, state);
  }
  function base(state) {
    const generated = Expressions.generate(state);
    if (state.expressionFeatures?.audible === false) return decorateAll(generated);
    return decorateAll([...generated, ...(state.instrumentFacetCandidates || []), ...(state.rhythmFacetCandidates || []),
      ...(state.productionFacetCandidates || []), ...(state.genreContextEvidence?.candidates || []),
      ...(state.arrangementFacetCandidates || []), ...(state.detectedIdioms || []),
      ...(state.primitiveObservationCandidates || []),
      ...(state.impressionFacetCandidates || []), ...(state.composedFactCandidates || []),
      ...(state.liveEventCandidates || []), ...(state.aestheticConceptCandidates || []),
      ...(state.directAudioCandidates || []),
      ...(state.flamingoReservoirCandidates || [])].slice(0, 160));
  }
  function local(state) {
    const stabilized = state.stateV2?.displayCandidates;
    const candidates = Array.isArray(stabilized) && stabilized.length
      ? decorateAll(stabilized.slice(0, 120)) : base(state);
    return candidates
      .map(item => realizeCandidate(item, state))
      .filter(item => item.requiresKoreanRealization !== true &&
        (item.category !== "genre" || GenreLabels.isPlausibleGenreLabel(item.canonicalText || item.sourceText || item.text)));
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
