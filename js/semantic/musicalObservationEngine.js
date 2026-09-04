// Direct Primitive -> musical concept bridge for detector outputs that do not need a broader
// genre idiom. It closes producer/consumer gaps without pretending a proxy is a new detector.
const MusicalObservations = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const read = (value, path) => path.split(".").reduce((item, key) => item?.[key], value);
  const anchor = path => `primitives.${path}`;

  const RULES = Object.freeze([
    { id: "tempo-class", paths: ["pulse.tempoClass"], facet: "rhythm", when: p => /slow|fast/.test(p.pulse.tempoClass || ""),
      text: p => ({ very_fast: "초고속 템포", fast: "빠른 템포", slow: "느린 템포", very_slow: "아주 느린 템포" })[p.pulse.tempoClass], confidence: .74 },
    { id: "subdivision-shape", paths: ["pulse.subdivision"], facet: "rhythm", when: p => ["straight", "uneven"].includes(p.pulse.subdivision),
      text: p => p.pulse.subdivision === "straight" ? "스트레이트 서브디비전" : "엇갈린 서브디비전", confidence: .72 },
    { id: "swing-ratio", paths: ["pulse.swingRatio"], facet: "rhythm", when: p => p.pulse.swingRatio >= 1.55,
      text: "늘어진 스윙 비율", confidence: p => clamp(.55 + (p.pulse.swingRatio - 1) * .25) },
    { id: "accent-displacement", paths: ["pulse.accentDisplacement"], facet: "rhythm", when: p => p.pulse.accentDisplacement >= .45,
      text: "밀려난 악센트", confidence: p => clamp(.55 + p.pulse.accentDisplacement * .35) },
    { id: "harmonic-tension-high", paths: ["harmony.harmonicTension"], facet: "performance", musicalFacet: "HARMONY",
      when: p => p.harmony.harmonicTension >= .65, text: "해소를 미루는 화성", confidence: p => p.harmony.harmonicTension },
    { id: "harmonic-tension-low", paths: ["harmony.harmonicTension", "harmony.harmonicStability"], facet: "performance", musicalFacet: "HARMONY",
      when: p => p.harmony.harmonicTension <= .18 && p.harmony.harmonicStability >= .65,
      text: "낮은 긴장도의 화성", confidence: p => clamp((1 - p.harmony.harmonicTension + p.harmony.harmonicStability) / 2) },
    { id: "stable-foreground", paths: ["role.leadStability", "role.foregroundLikelihood"], facet: "arrangement", musicalFacet: "MELODY",
      when: p => p.role.leadStability >= .74 && p.role.foregroundLikelihood >= .6, text: "지속되는 전경 선율",
      confidence: p => Math.min(p.role.leadStability, p.role.foregroundLikelihood) },
    { id: "dense-accompaniment", paths: ["role.accompanimentDensity"], facet: "arrangement", when: p => p.role.accompanimentDensity >= .72,
      text: "조밀한 반주층", confidence: p => p.role.accompanimentDensity },
    { id: "sparse-accompaniment", paths: ["role.accompanimentDensity"], facet: "arrangement", when: p => p.role.accompanimentDensity <= .28,
      text: "성긴 반주층", confidence: p => 1 - p.role.accompanimentDensity },
    { id: "foreground-role", paths: ["role.foregroundLikelihood"], facet: "arrangement", when: p => p.role.foregroundLikelihood >= .68,
      text: "선명한 전경 역할", confidence: p => p.role.foregroundLikelihood },
    { id: "melodic-role", paths: ["role.melodicRole"], facet: "performance", musicalFacet: "MELODY", when: p => p.role.melodicRole >= .65,
      text: "선율 주도 역할", confidence: p => p.role.melodicRole },
    { id: "call-response-role", paths: ["role.callResponse", "instrument.callResponse"], facet: "performance",
      when: p => p.role.callResponse >= .55 && p.instrument.callResponse >= .55, text: "주고받는 프레이징",
      confidence: p => Math.min(p.role.callResponse, p.instrument.callResponse) },
    { id: "ensemble-density", paths: ["role.ensembleDensity", "instrument.ensembleDensity"], facet: "arrangement",
      when: p => p.role.ensembleDensity >= .72 && p.instrument.ensembleDensity >= .72, text: "빽빽한 앙상블",
      confidence: p => Math.min(p.role.ensembleDensity, p.instrument.ensembleDensity) },
    { id: "instrument-exit", paths: ["instrument.exitLikelihood"], facet: "live", layer: "LIVE",
      when: p => p.instrument.exitLikelihood >= .62, text: "악기층 이탈", confidence: p => p.instrument.exitLikelihood,
      deltaSource: "instrumentExit" },
    { id: "legato-link", paths: ["instrument.legato"], facet: "performance", when: p => p.instrument.legato >= .62,
      text: "레가토 연결", confidence: p => p.instrument.legato },
    { id: "soft-transient", paths: ["articulation.transientSoftness"], facet: "performance", when: p => p.articulation.transientSoftness >= .68,
      text: "부드러운 트랜지언트", confidence: p => p.articulation.transientSoftness },
    { id: "hard-transient", paths: ["articulation.transientSoftness"], facet: "performance", when: p => p.articulation.transientSoftness <= .25,
      text: "단단한 트랜지언트", confidence: p => 1 - p.articulation.transientSoftness },
    { id: "section-change", paths: ["form.sectionChange"], facet: "live", layer: "LIVE", when: p => p.form.sectionChange >= .65,
      text: "새 구간 전환", confidence: p => p.form.sectionChange, deltaSource: "sectionChange" },
    { id: "density-rise", paths: ["form.densityDelta"], facet: "live", layer: "LIVE", when: p => p.form.densityDelta >= .18,
      text: "레이어 밀도 상승", confidence: p => clamp(.6 + p.form.densityDelta), deltaSource: "densityDelta" },
    { id: "density-fall", paths: ["form.densityDelta"], facet: "live", layer: "LIVE", when: p => p.form.densityDelta <= -.18,
      text: "레이어 밀도 하강", confidence: p => clamp(.6 - p.form.densityDelta), deltaSource: "densityDelta" },
    { id: "layer-entry", paths: ["form.layerEntry"], facet: "live", layer: "LIVE", when: p => p.form.layerEntry >= .3,
      text: "새 레이어 진입", confidence: p => clamp(.5 + p.form.layerEntry), deltaSource: "layerEntry" },
    { id: "layer-exit", paths: ["form.layerExit"], facet: "live", layer: "LIVE", when: p => p.form.layerExit >= .3,
      text: "레이어 이탈", confidence: p => clamp(.5 + p.form.layerExit), deltaSource: "layerExit" },
    { id: "form-variation", paths: ["form.variation", "arrangement.variation"], facet: "arrangement",
      when: p => p.form.variation >= .6 && p.arrangement.variation >= .6, text: "변주가 많은 전개",
      confidence: p => Math.min(p.form.variation, p.arrangement.variation) },
    { id: "form-repetition", paths: ["arrangement.repetition", "form.variation"], facet: "arrangement",
      when: p => p.arrangement.repetition >= .75 && p.form.variation <= .25, text: "반복 중심 전개",
      confidence: p => Math.min(p.arrangement.repetition, 1 - p.form.variation) },
    { id: "foreground-change", paths: ["form.foregroundChange"], facet: "live", layer: "LIVE", when: p => p.form.foregroundChange >= .45,
      text: "전경 악기 교대", confidence: p => p.form.foregroundChange, deltaSource: "foregroundChange" },
    { id: "instrument-role-change", paths: ["form.instrumentRoleChange", "arrangement.instrumentRoleChange"], facet: "live", layer: "LIVE",
      when: p => p.form.instrumentRoleChange >= .45 || p.arrangement.instrumentRoleChange >= .45, text: "악기 역할 교대",
      confidence: p => Math.max(p.form.instrumentRoleChange || 0, p.arrangement.instrumentRoleChange || 0), deltaSource: "instrumentRoleChange" },
    { id: "harmonic-production", paths: ["production.harmonicity"], facet: "production", when: p => p.production.harmonicity >= .75,
      text: "배음 중심 음색", confidence: p => p.production.harmonicity },
    { id: "spectral-slope-low", paths: ["production.spectralSlope"], facet: "production", when: p => p.production.spectralSlope >= .35,
      text: "저역으로 기운 스펙트럼", confidence: p => clamp(.5 + p.production.spectralSlope * .5) },
    { id: "spectral-slope-high", paths: ["production.spectralSlope"], facet: "production", when: p => p.production.spectralSlope <= -.35,
      text: "고역으로 기운 스펙트럼", confidence: p => clamp(.5 - p.production.spectralSlope * .5) },
    { id: "spectral-flux", paths: ["production.spectralFlux"], facet: "production", when: p => p.production.spectralFlux >= .45,
      text: "빠르게 변하는 스펙트럼", confidence: p => p.production.spectralFlux },
    { id: "compressed-behavior", paths: ["production.compressionBehavior"], facet: "production", when: p => p.production.compressionBehavior >= .75,
      text: "눌린 다이내믹", confidence: p => p.production.compressionBehavior },
    { id: "open-dynamics", paths: ["production.compressionBehavior"], facet: "production", when: p => p.production.compressionBehavior <= .3,
      text: "열린 다이내믹", confidence: p => 1 - p.production.compressionBehavior },
    { id: "saturated-texture", paths: ["production.saturationLikelihood"], facet: "production", when: p => p.production.saturationLikelihood >= .7,
      text: "포화된 질감", confidence: p => p.production.saturationLikelihood }
  ]);

  function generate(primitives = {}) {
    const candidates = [];
    for (const rule of RULES) {
      if (!rule.paths.every(path => read(primitives, path) !== null && read(primitives, path) !== undefined)) continue;
      if (!rule.when(primitives)) continue;
      const text = typeof rule.text === "function" ? rule.text(primitives) : rule.text;
      if (!text || !Facets.safeText(text, rule.facet)) continue;
      const confidence = clamp(typeof rule.confidence === "function" ? rule.confidence(primitives) : rule.confidence);
      const deltaMagnitude = rule.layer === "LIVE" ? Math.max(...rule.paths.map(path => Math.abs(Number(read(primitives, path)) || 0))) : undefined;
      candidates.push(Facets.token(text, rule.facet, confidence, rule.paths.map(anchor), {
        source: "primitive-observation", layer: rule.layer || "FACT", musicalFacet: rule.musicalFacet,
        concept: rule.id, genome: `${rule.layer || "FACT"}:OBSERVATION:${rule.id}`,
        ...(rule.layer === "LIVE" ? { deltaSource: rule.deltaSource, deltaMagnitude } : {})
      }));
    }
    return candidates;
  }

  const consumerPaths = Object.freeze([...new Set(RULES.flatMap(rule => rule.paths))]);
  return { RULES, consumerPaths, generate };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MusicalObservations;
