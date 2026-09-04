// FACT composition beyond atomic labels: relational, contrastive, and structural
// statements that still require two independent verified claims.
const FactComposer = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");

  function has(store, concept) { return store?.byConcept?.[concept]; }

  function compose(state = {}) {
    const store = state.verifiedClaims || {};
    const observed = state.instrumentation?.observed || [];
    const voice = observed.find(item => /voice|vocal/i.test(item.id || item.label || ""));
    const synth = observed.find(item => /synth/i.test(item.id || item.label || ""));
    const bass = observed.find(item => /bass/i.test(item.id || item.label || ""));
    const drums = observed.find(item => /drum/i.test(item.id || item.label || ""));
    const candidates = [];
    const add = (text, anchors, extra = {}) => {
      if (!Facets.safeText(text, extra.category || "arrangement")) return;
      candidates.push(Facets.token(text, extra.category || "arrangement", extra.confidence || 0.72, anchors, {
        source: "fact-composition", layer: "FACT", operator: extra.operator || "RELATION",
        claimsUsed: extra.claimsUsed || [], genome: extra.genome || extra.operator || "relation",
        ...extra
      }));
    };

    if (voice?.confidence >= 0.5 && synth?.confidence >= 0.5)
      add("보컬 중심의 신스층", ["instrumentation.observed", "primitives.role.foregroundLikelihood"], {
        operator: "RELATION", claimsUsed: ["instrument_voice", "instrument_synth"], category: "arrangement" });
    if (bass?.confidence >= 0.55 && drums?.confidence >= 0.5 && has(store, "four_on_floor"))
      add("킥과 베이스가 밀착된 하단", ["instrumentation.observed", "rhythmicGrammar.fourOnFloor"], {
        operator: "RELATION", claimsUsed: ["four_on_floor"], category: "arrangement" });
    if (has(store, "recurring_motif") && has(store, "sample_based"))
      add("반복되는 샘플 셀", ["primitives.melody.motifRecurrence", "productionEvidence.sampleBased"], {
        operator: "RELATION", claimsUsed: ["recurring_motif", "sample_based"], category: "production" });

    const mood = state.moodDimensions || {};
    const character = state.trackCharacter || {};
    if (voice?.dominance > (bass?.dominance || 0) + 0.12 && voice?.confidence >= 0.5)
      add("저역보다 앞선 보컬", ["instrumentation.observed", "moodDimensions.weight"], {
        operator: "CONTRAST", category: "arrangement" });
    if ((character.production?.subWeight ?? 0) <= 0.38 && (character.texture?.density ?? 0) >= 0.55)
      add("밀도에 비해 얇은 저역", ["trackCharacter.production.subWeight", "trackCharacter.texture.density"], {
        operator: "CONTRAST", category: "production" });
    if ((character.timbre?.brightness ?? mood.brightness ?? 0) >= 0.62 && (mood.valence ?? 0.5) <= 0.45)
      add("밝음과 낮은 유인가의 대비", ["timbre.brightness", "moodDimensions.valence"], {
        operator: "CONTRAST", category: "production" });

    const form = state.primitives?.form || {};
    if (form.densityDelta >= 0.18 && (form.sectionChange || form.buildupSlope >= 0.45))
      add("후렴에서 넓어지는 레이어", ["primitives.form.densityDelta", "primitives.form.buildupSlope"], {
        operator: "STRUCTURE", category: "arrangement" });
    if (form.densityDelta <= -0.18)
      add("벌스의 얇은 저역", ["primitives.form.densityDelta", "trackCharacter.production.subWeight"], {
        operator: "STRUCTURE", category: "arrangement" });
    if (has(store, "four_on_floor") && bass?.confidence >= 0.55 && (state.trackCharacter?.structure?.repetition || 0) >= 0.6)
      add("반복되는 드럼-베이스 결합", ["rhythmicGrammar.fourOnFloor", "trackCharacter.structure.repetition"], {
        operator: "STRUCTURE", category: "arrangement" });

    return candidates;
  }

  return { compose };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FactComposer;
