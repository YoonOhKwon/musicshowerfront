// Aesthetic concepts are associations induced from verified feature clusters, never facts
// about a work, place, or franchise.
const AestheticConceptEngine = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Grammar = typeof LocalGenerativeGrammar !== "undefined" ? LocalGenerativeGrammar : require("./localGenerativeGrammar");

  function induce(state = {}) {
    const store = state.verifiedClaims;
    if (!store?.licensed) return [];
    const fromGrammar = Grammar.realize(state);
    const extras = [];
    const licensed = store.licensed;
    if (licensed.has("bright_timbre") && licensed.has("sample_based") && licensed.has("high_valence")) {
      extras.push(Facets.token("레트로 광고 미학", "association", 0.66,
        ["primaryGenre", "moodDimensions.brightness", "productionEvidence.sampleBased", "moodDimensions.valence"], {
          source: "aesthetic-induction", layer: "AESTHETIC", operator: "PROJECTION",
          concept: "retro_commercial_gloss", genome: "AESTHETIC:PROJECTION:retro_commercial_gloss",
          claimsUsed: ["bright_timbre", "sample_based", "high_valence"], kind: "aesthetic"
        }));
    }
    if (licensed.has("wide_space") && licensed.has("sparse_texture") && licensed.has("dark_timbre")) {
      extras.push(Facets.token("어두운 잔향 미학", "association", 0.64,
        ["primaryGenre", "moodDimensions.spaciousness", "texture.density", "moodDimensions.brightness"], {
          source: "aesthetic-induction", layer: "AESTHETIC", operator: "SPATIALIZATION",
          concept: "dark_reverb_aesthetic", genome: "AESTHETIC:SPATIALIZATION:dark_reverb_aesthetic",
          claimsUsed: ["wide_space", "sparse_texture", "dark_timbre"], kind: "aesthetic"
        }));
    }
    return [...fromGrammar, ...extras];
  }

  return { induce };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AestheticConceptEngine;
