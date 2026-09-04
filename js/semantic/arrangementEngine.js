const ArrangementEngine = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  class Engine {
    update(instrumentation = {}, character = {}) {
      const observed = instrumentation.observed || [];
      const density = Number(character.texture?.density ?? instrumentation.density);
      const candidates = [];
      const find = pattern => observed.find(item => pattern.test(String(item.id || item.label).toLowerCase()));
      const drums = find(/drum|percussion/), bass = find(/bass/), voice = find(/voice|vocal/), synth = find(/synth/);
      if (drums?.confidence >= 0.55 && bass?.confidence >= 0.55)
        candidates.push(Facets.token("리듬 섹션 중심", "arrangement", Math.min(drums.confidence, bass.confidence),
          ["instrumentation.observed", "arrangement.density"], { source: "arrangement" }));
      if (voice?.confidence >= 0.72 && (voice.dominance || 0) >= 0.25)
        candidates.push(Facets.token("보컬 중심", "arrangement", voice.confidence,
          ["instrumentation.observed", "arrangement.dominantRole"], { source: "arrangement" }));
      if (synth?.confidence >= 0.65 && density >= 0.7)
        candidates.push(Facets.token("레이어드 신스", "arrangement", Math.min(synth.confidence, density),
          ["instrumentation.observed", "texture.layeredness"], { source: "arrangement" }));
      if (Number.isFinite(density) && density < 0.32 && observed.filter(x => x.confidence >= 0.5).length >= 2)
        candidates.push(Facets.token("소편성 질감", "arrangement", 0.7,
          ["arrangement.density", "instrumentation.observed"], { source: "arrangement" }));
      const size = instrumentation.verifiedEnsembleSize;
      if (Number.isFinite(size) && size >= 2) {
        const text = size === 2 ? "듀오 구성" : size === 3 ? "트리오 구성" : size === 4 ? "콰르텟 구성" : "소편성 앙상블";
        candidates.push(Facets.token(text, "arrangement", 0.78, ["arrangement.verifiedEnsembleSize", "instrumentation.observed"], { source: "arrangement" }));
      }
      return { density: Number.isFinite(density) ? density : null, verifiedEnsembleSize: Number.isFinite(size) ? size : null, candidates };
    }
  }
  return { Engine };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ArrangementEngine;
