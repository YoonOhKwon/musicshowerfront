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
  const isDirectAudio = item => item?.source === "directAudio" || item?.sourceFamily === "directAudio";
  const audioIsAudible = state => state?.expressionFeatures?.audible !== false ||
    (typeof hasCurrentAudioSignal === "function" && hasCurrentAudioSignal()) ||
    (typeof getSoundCloudPlaybackState === "function" && getSoundCloudPlaybackState()?.transport === "playing");
  const isGenericRemote = item => ["llm", "remote-generative"].includes(String(item?.source || ""));
  const forbiddenLocalSemanticSources = new Set([
    "impression-synthesis", "local-grammar", "aesthetic-induction", "aesthetic-axis",
    "evidence-gated-prior", "genre-relation"
  ]);
  // Enforce semantic ownership at the last shared gate as well as at producer call sites. This
  // prevents dormant legacy code or a generic language-pool response from quietly reclaiming a
  // layer later.
  function ownershipAllowed(candidate) {
    const item = Layers.decorate(candidate);
    if (forbiddenLocalSemanticSources.has(String(item.source || ""))) return false;
    if (["AESTHETIC", "IMPRESSION"].includes(item.layer)) return isDirectAudio(item);
    // FACT/LIVE may come from local analysis or Music Flamingo. The general language model does
    // not listen to the audio and therefore cannot originate those layers.
    if (["FACT", "LIVE"].includes(item.layer) && isGenericRemote(item)) return false;
    return true;
  }
  const sourceIdentity = item => `${item?.category || ""}:${normalize(item?.canonicalText || item?.sourceText || item?.text)}`;
  function realizeOpenWorldGenre(item, state) {
    if (item.category !== "genre" || (item.source !== "directAudio" && item.sourceFamily !== "directAudio")) return item;
    const concept = (state.openWorldConcepts || []).find(candidate =>
      ["genre", "microgenre"].includes(candidate.conceptType) &&
      normalize(candidate.canonicalLabel) === normalize(item.canonicalText || item.sourceText || item.text));
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
    if (!audioIsAudible(state)) return decorateAll(generated);
    return decorateAll([...generated, ...(state.instrumentFacetCandidates || []), ...(state.rhythmFacetCandidates || []),
      ...(state.productionFacetCandidates || []), ...(state.genreContextEvidence?.candidates || []),
      ...(state.arrangementFacetCandidates || []), ...(state.detectedIdioms || []),
      ...(state.primitiveObservationCandidates || []),
      ...(state.impressionFacetCandidates || []), ...(state.composedFactCandidates || []),
      ...(state.liveEventCandidates || []), ...(state.aestheticConceptCandidates || []),
      ...(state.directAudioCandidates || []),
      ...(state.flamingoReservoirCandidates || [])].slice(0, 160)).filter(ownershipAllowed);
  }
  function local(state) {
    const stabilized = state.stateV2?.displayCandidates;
    let candidates;
    if (Array.isArray(stabilized) && stabilized.length) {
      // stateV2 contains the evidence-stabilized canonical claims, while the Flamingo reservoir
      // contains their current Korean surface realization. Prefer that surface for matching direct
      // audio concepts, then append it so aesthetic/impression families are never bypassed.
      const reservoir = decorateAll(state.flamingoReservoirCandidates || []);
      const realizedKeys = new Set(reservoir.map(sourceIdentity));
      const stable = decorateAll(stabilized.slice(0, 120)).filter(item =>
        !isDirectAudio(item) || !realizedKeys.has(sourceIdentity(item)));
      candidates = [...stable, ...reservoir].slice(0, 160);
    } else {
      candidates = base(state);
    }
    return candidates
      .map(item => realizeCandidate(item, state))
      .filter(ownershipAllowed)
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
  // At most this share of a curated set is held for direct-audio (Music Flamingo) concepts.
  // A ceiling, not a floor: unused reservation goes straight back to the general rounds below.
  const DIRECT_AUDIO_SHARE = 0.3;
  // Evidence decides what exists; the layer/facet cycles only prevent one perspective
  // from monopolizing a pool and never invent candidates to fill a quota.
  function curate(candidates, limit = 40) {
    const ordered = decorateAll(candidates).filter(ownershipAllowed).sort((a, b) =>
      (b.score || b.evidenceScore || b.weight || 0) - (a.score || a.evidenceScore || a.weight || 0));
    const groups = group(ordered);
    const selected = [], seen = new Set(), seenText = new Set();

    // Source diversity, for the same reason the layer/facet cycles exist: one perspective must not
    // monopolize the pool. That rule was only ever applied to layer and facet, so it did not cover
    // the case that actually matters here -- the local composers emit dozens of phrases per tick
    // while a deep-listen capture contributes a handful, and the facet cursors walk in score order,
    // so a hundred local phrases push every Flamingo concept past the limit. Measured: with 60+
    // local candidates only 3 of 8 direct-audio concepts survived, and adoption fell to ~3%.
    // They lost on COUNT, not on merit, and the whole point of the deep listen is that it says
    // things the local heuristics structurally cannot. Reserve a share for it -- capped by how
    // many actually exist, so this never invents a candidate to fill a quota.
    const directAudioOrdered = ordered.filter(isDirectAudio);
    const reserved = Math.min(directAudioOrdered.length, Math.floor(limit * DIRECT_AUDIO_SHARE));
    for (const item of directAudioOrdered.slice(0, reserved)) {
      const key = Quality.conceptKey(item), literal = Quality.literalKey(item);
      if (seen.has(key) || seenText.has(literal)) continue;
      selected.push(item); seen.add(key); seenText.add(literal);
    }

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
  return { base, local, group, curate, ownershipAllowed, isDirectAudio };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SemanticFacetManager;
