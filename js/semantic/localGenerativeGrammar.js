// Local generative grammar: Claim + operator + lexical family, no LLM required.
const LocalGenerativeGrammar = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");

  const FAMILIES = Object.freeze([
    {
      id: "digital_nostalgia",
      needs: ["bright_timbre", "nostalgia"],
      optional: ["sample_based", "high_valence"],
      operator: "FUSION",
      layer: "AESTHETIC",
      category: "association",
      texts: ["디지털 노스탤지어 미학", "광택 있는 회고 감성", "반짝이는 과거 이미지", "샘플의 디지털 향수 미학"]
    },
    {
      id: "plastic_optimism",
      needs: ["bright_timbre", "high_valence"],
      optional: ["sidechain", "four_on_floor"],
      operator: "AMPLIFICATION",
      layer: "AESTHETIC",
      category: "association",
      texts: ["플라스틱 낙관 미학", "반짝이는 낙관 감성", "광택 있는 낙관 이미지"]
    },
    {
      id: "industrial_void",
      needs: ["dark_timbre", "sparse_texture"],
      optional: ["wide_space"],
      operator: "SPATIALIZATION",
      layer: "AESTHETIC",
      category: "association",
      texts: ["산업적 공백 미학", "거친 암부 감성", "차가운 빈 공간 이미지"]
    },
    {
      id: "excited_nostalgia",
      needs: ["nostalgia", "high_arousal"],
      optional: ["bright_timbre"],
      operator: "CONTRAST",
      layer: "IMPRESSION",
      category: "mood",
      texts: ["들뜬 향수", "질주하는 회고", "밝게 밀리는 노스탤지어"]
    }
  ]);

  function realize(state = {}, recent = []) {
    const licensed = state.verifiedClaims?.licensed || new Set();
    const used = new Set(recent.map(item => item.genome));
    const candidates = [];
    for (const family of FAMILIES) {
      if (!family.needs.every(concept => licensed.has(concept))) continue;
      const extras = family.optional.filter(concept => licensed.has(concept));
      const text = family.texts.find(value => !used.has(`AESTHETIC:${family.id}`)) || family.texts[0];
      if (!Facets.safeText(text, family.category)) continue;
      const anchors = ["primaryGenre", ...family.needs.concat(extras).slice(0, 5).map(concept =>
        state.verifiedClaims.byConcept[concept]?.evidence?.[0] || `moodDimensions.${concept}`)];
      candidates.push(Facets.token(text, family.category, 0.68 + extras.length * 0.04, anchors, {
        source: "local-grammar", layer: family.layer, operator: family.operator,
        concept: family.id, genome: `${family.layer}:${family.operator}:${family.id}`,
        claimsUsed: family.needs.concat(extras), kind: family.category === "association" ? "aesthetic" : "descriptor"
      }));
    }
    return candidates;
  }

  return { FAMILIES, realize };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LocalGenerativeGrammar;
