const PhraseSelection = (() => {
  const Expressions = typeof MusicExpressionEngine !== "undefined" ? MusicExpressionEngine : require("../semantic/musicExpressionEngine");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("../semantic/languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("../semantic/phraseQuality");
  const Genome = typeof PhraseGenome !== "undefined" ? PhraseGenome : require("../semantic/phraseGenome");
  const typeFactor = { single: 1.1, fragment: 1, nominal: 0.8, micro: 0.42 };
  function weight(candidate, recent = [], options = {}) {
    const item = Layers.decorate(candidate);
    const samePerspective = recent.filter(previous => previous.perspective === item.perspective).length;
    const sameType = recent.filter(previous => previous.type === item.type).length;
    const sameLayer = recent.filter(previous => Layers.decorate(previous).layer === item.layer).length;
    const sameDistance = recent.filter(previous => Layers.decorate(previous).semanticDistance === item.semanticDistance).length;
    const sameSource = recent.filter(previous => previous.source && previous.source === item.source).length;
    const semanticFamily = Quality.semanticFamily(item);
    const sameSemanticFamily = recent.filter(previous => Quality.semanticFamily(previous) === semanticFamily).length;
    const family = Quality.relationFamily(item);
    const sameRelationFamily = family === "NONE" ? 0 : recent.filter(previous => Quality.relationFamily(previous) === family).length;
    const temporal = Layers.temporalFitness(item, options);
    const informationGain = Genome.informationGain(item, recent);
    const specificityTier = item.specificityTier || Quality.specificityTier(item);
    const tierFactor = ({ 1: 0.28, 2: 0.68, 3: 1.08, 4: 1.46 })[specificityTier] || 0.68;
    const quality = (item.relevance * 0.2 + item.novelty * 0.16 + item.specificity * 0.18 +
      item.contrastiveness * 0.1 + (item.evidenceScore ?? item.confidence ?? 0.65) * 0.2 +
      informationGain * 0.16);
    // Raw single-axis descriptors stay available (they carry the first seconds and every
    // fallback) but they must not out-compete language that actually synthesises features.
    const primitivePenalty = item.primitive ? 0.45 : 1;
    const sourcePriority = ({ idiom: 1.38, rhythm: 1.3, instrument: 1.25, production: 1.22,
      "primitive-observation": 1.26,
      "live-event": 1.32, "fact-composition": 1.28, arrangement: 1.15,
      "local-grammar": 1.18, "aesthetic-induction": 1.16, primitive: 0.72 })[item.source] || 1;
    const familyPenalty = family === "NONE" ? 1 : 1 / (1 + sameRelationFamily * (family === "ARTIST" ? 2.4 : 0.85));
    const semanticFamilyPenalty = 1 / (1 + sameSemanticFamily *
      (["dreamlike", "neon-city", "light-glass", "space-reverb", "warmth"].includes(semanticFamily) ? 1.65 : 0.72));
    const reservoirFitness = item.source === "remote-generative"
      ? (0.35 + 0.65 * (item.freshness ?? 1)) *
        (0.65 + 0.35 * (item.groundingScore ?? item.evidenceScore ?? item.confidence ?? 0.6)) *
        (0.72 + 0.28 * (item.contextRelevance ?? item.relevance ?? 0.7))
      : 1;
    const genericAncestorPenalty = ["PARENT", "LINEAGE"].includes(family) && recent.some(previous =>
      ["PARENT", "LINEAGE"].includes(Quality.relationFamily(previous)) &&
      (previous.relationScore || previous.confidence || 0) > (item.relationScore || item.confidence || 0) + 0.08) ? 0.42 : 1;
    const songUsePenalty = 1 / (1 + Math.max(0, Number(item.songUsageCount) || 0) * 0.7);
    const exhaustionPenalty = item.exhausted || (item.exhaustedUntil || 0) > (options.now || Date.now()) ? 0.04 : 1;
    const facetNeed = 0.55 + 0.45 * (item.facetNeed ?? 1);
    const evidenceReservoir = 0.55 + 0.45 * (item.reservoirScore ?? 1);
    return Math.max(0.005, (item.weight || item.score || 0.6) * quality * temporal * primitivePenalty * sourcePriority *
      tierFactor * familyPenalty * semanticFamilyPenalty * reservoirFitness * genericAncestorPenalty *
      songUsePenalty * exhaustionPenalty * facetNeed * evidenceReservoir * (typeFactor[item.type] || 1) /
      (1 + samePerspective * 0.22 + sameType * 0.08 + sameLayer * 0.13 + sameDistance * 0.08 + sameSource * 0.07));
  }
  function layerRatios(observationSeconds, changing) {
    if (changing) return { LIVE: 0.45, FACT: 0.32, CONTEXT: 0.12, AESTHETIC: 0.05, IMPRESSION: 0.06 };
    if (observationSeconds < 5) return { LIVE: 0.60, FACT: 0.40, CONTEXT: 0, AESTHETIC: 0, IMPRESSION: 0 };
    if (observationSeconds < 15) return { LIVE: 0.27, FACT: 0.50, CONTEXT: 0.23, AESTHETIC: 0, IMPRESSION: 0 };
    if (observationSeconds < 30) return { LIVE: 0.15, FACT: 0.37, CONTEXT: 0.33, AESTHETIC: 0.08, IMPRESSION: 0.07 };
    // Long-form output remains music-first: roughly 65% audio-derived LIVE/FACT, 20% context and
    // 15% aesthetic/impression. Candidate count never lets a genre dictionary dominate this mix.
    return { LIVE: 0.10, FACT: 0.55, CONTEXT: 0.20, AESTHETIC: 0.08, IMPRESSION: 0.07 };
  }
  function choose(source = [], recent = [], random = Math.random, options = {}) {
    const { changing = false, active = [], observationSeconds = Infinity, avoidFacets = [] } = options;
    // Before real analysis exists primitives are legitimately most of the language; once the
    // track is understood they should be a garnish, not the meal.
    const primitiveBudget = observationSeconds < 8 ? 1 : observationSeconds < 20 ? 0.4 : 0.15;
    const temporalOptions = { changing, observationSeconds };
    let available = source.map(item => Layers.decorate(item)).filter(item =>
      Layers.temporalFitness(item, temporalOptions) > 0 &&
      !active.some(text => Quality.literalKey(text) === Quality.literalKey(item) || Quality.sameConcept(text, item)));
    if (!available.length) return undefined;
    const notExhausted = available.filter(item => !item.exhausted && (item.exhaustedUntil || 0) <= (options.now || Date.now()));
    if (notExhausted.length) available = notExhausted;
    const avoided = new Set(avoidFacets.map(value => String(value).toUpperCase()));
    const facetAlternatives = available.filter(item => !avoided.has(Quality.musicalFacet(item)));
    if (facetAlternatives.length) available = facetAlternatives;
    const recentConcepts = new Set(recent.slice(-8).map(item => Quality.conceptKey(item)));
    const globallyFresh = available.filter(item => !recentConcepts.has(Quality.conceptKey(item)));
    if (globallyFresh.length) available = globallyFresh;
    const recentFamilies = new Set(recent.slice(-4).map(item => Quality.semanticFamily(item)));
    const familyFresh = available.filter(item => !recentFamilies.has(Quality.semanticFamily(item)));
    if (familyFresh.length) available = familyFresh;
    const ratios = layerRatios(observationSeconds, changing);
    const presentLayers = [...new Set(available.map(item => item.layer))];
    const layerShare = layer => (ratios[layer] || 0.02) /
      (1 + recent.filter(item => Layers.decorate(item).layer === layer).length * 0.9);
    let layerCursor = random() * presentLayers.reduce((sum, layer) => sum + layerShare(layer), 0);
    const layer = presentLayers.find(name => (layerCursor -= layerShare(name)) <= 0) || presentLayers.at(-1);
    let layerPool = available.filter(item => item.layer === layer);
    // The first FACT after a few seconds should reveal a musical idiom/instrument/production
    // reading when one exists, before falling back to another raw level adjective.
    if (layer === "FACT" && observationSeconds >= 8) {
      const recentHighResolution = recent.slice(-6).some(item => Layers.decorate(item).layer === "FACT" && !item.primitive);
      const highResolution = layerPool.filter(item => !item.primitive && item.source !== "genre");
      if (!recentHighResolution && highResolution.length) layerPool = highResolution;
    }
    // Within an epistemic layer, select a needed facet rather than merely the loudest candidate.
    const recentFacetCounts = Object.fromEntries([...new Set(layerPool.map(item => Quality.musicalFacet(item)))]
      .map(facet => [facet, recent.filter(item => Quality.musicalFacet(item) === facet).length]));
    const minimumFacetUse = Math.min(...Object.values(recentFacetCounts));
    let facetPool = layerPool.filter(item => recentFacetCounts[Quality.musicalFacet(item)] <= minimumFacetUse + 1);
    const recentlyUsed = new Set(recent.slice(-8).map(item => Quality.conceptKey(item)));
    const conceptFresh = facetPool.filter(item => !recentlyUsed.has(Quality.conceptKey(item)));
    if (conceptFresh.length) facetPool = conceptFresh;
    // Thirty percent of profile-aware draws explicitly explore grounded but under-exposed
    // concepts. The remaining draws exploit the strongest evidence through the normal weights.
    // Candidates without song metadata keep the legacy deterministic path used by unit tests.
    const profileAware = facetPool.some(item => Number.isFinite(item.songUsageCount));
    if (profileAware && random() < (options.explorationRate ?? 0.3)) {
      const unexplored = facetPool.filter(item => item.unexplored || item.songUsageCount === 0);
      const underExposed = facetPool.filter(item => (item.facetNeed ?? 0) >= 0.75);
      if (unexplored.length) facetPool = unexplored;
      else if (underExposed.length) facetPool = underExposed;
    }
    // Hard ceiling on how much of the screen may be raw descriptors once real analysis exists.
    const recentPrimitives = recent.filter(item => item.primitive).length;
    const overPrimitiveBudget = recent.length >= 6 && recentPrimitives / recent.length > primitiveBudget;
    const synthesised = facetPool.filter(item => !item.primitive);
    const pool = overPrimitiveBudget && synthesised.length ? synthesised : facetPool;
    const effective = item => weight(item, recent, temporalOptions) /
      (1 + recent.filter(previous => Quality.sameConcept(previous, item)).length * 3);
    let cursor = random() * pool.reduce((sum, item) => sum + effective(item), 0);
    for (const item of pool) { cursor -= effective(item); if (cursor <= 0) return item; }
    return pool.at(-1);
  }
  function treatment(token = {}) {
    const type = token.type || (String(token.text || "").length > 20 ? "micro" : "fragment");
    const shape = type === "single" ? { scale: 1.12, speed: 1 } : type === "micro" ? { scale: 0.68, speed: 0.82 }
      : type === "nominal" ? { scale: 0.88, speed: 0.94 } : { scale: 1, speed: 1 };
    const layer = Layers.decorate(token).layer;
    const temporalSpeed = { LIVE: 1.14, FACT: 1, CONTEXT: 0.86, AESTHETIC: 0.88, IMPRESSION: 0.96 }[layer] || 1;
    return { ...shape, speed: shape.speed * temporalSpeed };
  }
  return { choose, weight, treatment, layerRatios };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PhraseSelection;
