// LIVE is a delta event, not a static adjective. Each canonical event has several realizations;
// the screen picks one, the genome keeps them as the same concept.
const LiveEventGrammar = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const EVENTS = Object.freeze({
      ENERGY_RISE: {
      test: state => (state.expressionFeatures?.deltaEnergy || 0) >= 0.09,
      magnitude: state => state.expressionFeatures.deltaEnergy,
      source: "deltaEnergy",
      anchors: ["measurements.deltaEnergy"],
      texts: ["에너지 상승", "밀도가 올라감", "전면으로 밀어붙는 에너지"]
    },
    ENERGY_DROP: {
      test: state => (state.expressionFeatures?.deltaEnergy || 0) <= -0.09,
      magnitude: state => Math.abs(state.expressionFeatures.deltaEnergy),
      source: "deltaEnergy",
      anchors: ["measurements.deltaEnergy"],
      texts: ["에너지 하강", "힘이 빠지는 구간", "밀도가 가라앉음"]
    },
    LOW_END_EXPANSION: {
      test: state => (state.expressionFeatures?.deltaLowEnergy || 0) >= 0.12,
      magnitude: state => state.expressionFeatures.deltaLowEnergy,
      source: "deltaLowEnergy",
      anchors: ["measurements.deltaLowEnergy"],
      texts: ["저역 확장", "하단이 두꺼워짐", "베이스가 앞으로"]
    },
    RHYTHMIC_DENSIFICATION: {
      test: state => (state.expressionFeatures?.deltaTransientDensity || 0) >= 0.18,
      magnitude: state => state.expressionFeatures.deltaTransientDensity,
      source: "deltaTransientDensity",
      anchors: ["measurements.deltaTransientDensity"],
      texts: ["촘촘해진 리듬", "리듬이 밀집됨", "타격이 잦아짐"]
    },
    SPECTRAL_OPENING: {
      test: state => (state.expressionFeatures?.deltaCentroid || 0) >= 900,
      magnitude: state => Math.min(1, state.expressionFeatures.deltaCentroid / 1200),
      source: "deltaCentroid",
      anchors: ["measurements.deltaCentroid"],
      texts: ["밝아진 고역", "스펙트럼이 열림", "고역이 열림"]
    },
    LAYER_ENTRY: {
      test: state => (state.instrumentEvents || []).some(event => event.kind !== "exit" && event.confidence >= 0.65),
      magnitude: state => Math.max(0, ...(state.instrumentEvents || []).map(event => event.confidence)),
      source: "instrumentEvents",
      anchors: ["instrumentEvents"],
      // Avoid pairing entrance verbs with instrument names: semanticFacets treats that as a
      // named entrance that must match instrumentEvents.text exactly.
      texts: ["레이어 추가", "전경 레이어 증가", "밀도가 붙는 레이어"]
    },
    LAYER_EXIT: {
      test: state => (state.instrumentEvents || []).some(event => event.kind === "exit" && event.confidence >= 0.65),
      magnitude: state => Math.max(0, ...(state.instrumentEvents || []).filter(event => event.kind === "exit").map(event => event.confidence)),
      source: "instrumentEvents",
      anchors: ["instrumentEvents"],
      texts: ["레이어 이탈", "레이어가 빠짐", "전경 레이어 감소"]
    }
  });

  function realize(state = {}, recent = []) {
    const candidates = [];
    const used = new Set(recent.map(item => item.genome || item.concept || item.text));
    for (const [name, event] of Object.entries(EVENTS)) {
      if (!event.test(state)) continue;
      const magnitude = Number(event.magnitude(state)) || 0;
      let texts = event.texts;
      let extra = {};
      if (typeof texts === "function") {
        const match = (state.instrumentEvents || []).find(item =>
          (name === "LAYER_EXIT" ? item.kind === "exit" : item.kind !== "exit") && item.confidence >= 0.65);
        texts = texts(match);
        extra = { eventLabel: match?.label };
      }
      const chosen = (Array.isArray(texts) ? texts : [texts]).find(text => !used.has(`LIVE:${name}`)) || texts[0];
      if (!Facets.safeText(chosen, "live")) continue;
      candidates.push(Facets.token(chosen, "live", Math.min(0.92, 0.58 + Math.abs(magnitude) * 0.8), event.anchors, {
        source: "live-event", layer: "LIVE", operator: "EVENT", genome: `LIVE:${name}`,
        concept: name, deltaSource: event.source, deltaMagnitude: Math.abs(magnitude), ...extra
      }));
    }
    return candidates;
  }

  return { EVENTS, realize };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LiveEventGrammar;
