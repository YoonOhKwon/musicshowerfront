// Turns verified material relations into FACT tokens. Wording comes from the
// surface realizer; this module does not invent musical facts.
const FactComposer = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Relations = typeof MaterialRelationEngine !== "undefined" ? MaterialRelationEngine : require("./materialRelationEngine");
  const Surface = typeof LocalSurfaceRealizer !== "undefined" ? LocalSurfaceRealizer : require("./localSurfaceRealizer");

  function compose(state = {}, options = {}) {
    const evaluated = Relations.evaluate(state);
    const relations = evaluated.relations || [];
    state.materialRelations = relations;
    state.materialRelationDebug = evaluated.debug;
    const claims = state.verifiedClaims || {};
    const now = options.now ?? state.now ?? Date.now();
    const surface = options.surface || Surface;
    const candidates = [];
    for (const rel of relations) {
      const realized = typeof surface.enrich === "function"
        ? surface.enrich({ ...rel, conceptId: rel.relationId, text: rel.text }, claims)
        : rel;
      const text = realized.canonicalText || realized.text || rel.relationId;
      if (!Facets.safeText(text, rel.category || "arrangement")) continue;
      if (/후렴|벌스|코러스|버스|chorus|verse/i.test(text)) continue;
      candidates.push(Facets.token(text, rel.category || "arrangement", rel.confidence || 0.72, rel.anchors, {
        source: "fact-composition",
        layer: rel.category === "live" ? "LIVE" : "FACT",
        operator: rel.relationType,
        conceptId: rel.relationId,
        relationId: rel.relationId,
        relationType: rel.relationType,
        subjectConceptId: rel.subjectConceptId,
        objectConceptId: rel.objectConceptId,
        temporalScope: rel.temporalScope,
        evidenceAxes: rel.evidenceAxes,
        salience: rel.salience,
        canonicalText: realized.canonicalText || text,
        realizations: realized.realizations || [],
        genome: rel.relationType,
        claimsUsed: [rel.subjectConceptId, rel.objectConceptId].filter(Boolean)
      }));
    }
    return candidates;
  }

  return { compose };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FactComposer;
