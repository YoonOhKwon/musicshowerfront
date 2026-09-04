// Converts several already-grounded musical facts into a bounded subjective concept.
// It never reads raw PCM and never supplies a missing fact. Outputs remain IMPRESSION phrases,
// separate from the canonical lexicon, and expire with their semantic epoch.
const ImpressionSynthesizer = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = Facets.clamp;
  const read = (source, path) => path.split(".").reduce((value, key) => value?.[key], source);
  const numeric = value => typeof value === "number" && Number.isFinite(value);

  const RULES = Object.freeze([
    { id: "EXPANSIVE_SUSPENSION", text: "잔향 속의 공백", family: "SPACIOUS_STILLNESS", operator: "spatial-metaphor",
      requires: [{ path: "moodDimensions.spaciousness", min: .72 }, { path: "trackCharacter.texture.sustainedness", min: .72 },
        { path: "arrangement.density", max: .35 }, { path: "trackCharacter.harmony.harmonicMotion", max: .38 }] },
    { id: "COMPRESSED_EUPHORIA", text: "압축된 낙관", family: "COMPRESSED_EUPHORIA", operator: "emotional-synthesis",
      requires: [{ path: "productionEvidence.sidechain", min: .7 }, { path: "rhythmicGrammar.fourOnFloor", min: .7 },
        { path: "moodDimensions.valence", min: .62 }, { path: "moodDimensions.brightness", min: .62 }] },
    { id: "BRIGHT_SAMPLE_AFTERGLOW", text: "샘플의 잔열", family: "SAMPLE_NOSTALGIA", operator: "material-metaphor",
      requires: [{ path: "productionEvidence.sampleBased", min: .7 }, { path: "moodDimensions.brightness", min: .6 },
        { path: "trackCharacter.structure.repetition", min: .62 }] },
    { id: "UPLIFTING_MELANCHOLY", text: "들뜬 애상", family: "BITTERSWEET_UPLIFT", operator: "emotional-synthesis",
      requires: [{ path: "primitives.harmony.majorMinorLikelihood.minor", min: .58 },
        { path: "moodDimensions.valence", min: .58 }, { path: "moodDimensions.arousal", min: .58 }] },
    { id: "LAID_BACK_WARMTH", text: "뒤로 눕는 온기", family: "LAID_BACK_WARMTH", operator: "kinetic-metaphor",
      requires: [{ path: "rhythmicGrammar.swing", min: .62 }, { path: "moodDimensions.warmth", min: .62 },
        { path: "moodDimensions.arousal", max: .68 }] },
    { id: "RESTLESS_PROPULSION", text: "엇박의 추진력", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "rhythmicGrammar.syncopation", min: .62 }, { path: "moodDimensions.arousal", min: .62 },
        { path: "trackCharacter.rhythm.onsetDensity", min: .5 }] },
    { id: "HIGH_SPEED_CALM", text: "고속의 평온", family: "HIGH_SPEED_CALM", operator: "interpretive-compression",
      requires: [{ path: "primitives.pulse.tempo", min: 145 }, { path: "moodDimensions.arousal", max: .42 },
        { path: "moodDimensions.tension", max: .38 }] },
    { id: "SOFT_SATURATION", text: "포화된 온기", family: "WARM_SATURATION", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.production.saturation", min: .6 }, { path: "moodDimensions.warmth", min: .62 },
        { path: "trackCharacter.timbre.roughness", max: .48 }] },
    { id: "AIRY_SUSPENSION", text: "고역의 부유감", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "primitives.production.airiness", min: .62 }, { path: "moodDimensions.spaciousness", min: .65 },
        { path: "trackCharacter.texture.sustainedness", min: .55 }] },
    { id: "DARK_SPACIOUS_TENSION", text: "어두운 부유감", family: "DARK_SUSPENSION", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.brightness", max: .35 }, { path: "moodDimensions.spaciousness", min: .72 },
        { path: "moodDimensions.tension", min: .5 }] },
    { id: "GENTLE_HARMONIC_MOTION", text: "온화한 화성 흐름", family: "GENTLE_MOTION", operator: "interpretive-compression",
      requires: [{ path: "trackCharacter.harmony.harmonicMotion", min: .45 }, { path: "moodDimensions.warmth", min: .62 },
        { path: "moodDimensions.tension", max: .42 }] },
    { id: "BROKEN_URGENCY", text: "끊어 걷는 긴장", family: "BROKEN_URGENCY", operator: "kinetic-metaphor",
      requires: [{ path: "rhythmicGrammar.brokenBeat", min: .68 }, { path: "rhythmicGrammar.swing", min: .55 },
        { path: "moodDimensions.tension", min: .48 }] },

    // ---------- Affect ----------
    { id: "RESTRAINED_UPLIFT", text: "절제된 고양감", family: "RESTRAINED_UPLIFT", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.valence", min: .58 }, { path: "moodDimensions.arousal", max: .5 },
        { path: "trackCharacter.dynamics.dynamicRange", min: .45 }] },
    { id: "EUPHORIC_RELEASE", text: "터지는 황홀감", family: "COMPRESSED_EUPHORIA", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.arousal", min: .78 }, { path: "moodDimensions.valence", min: .68 },
        { path: "primitives.form.buildupSlope", min: .5 }] },
    { id: "GENTLE_MELANCHOLY", text: "부드러운 애수", family: "BITTERSWEET_UPLIFT", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.valence", max: .42 }, { path: "moodDimensions.warmth", min: .5 },
        { path: "moodDimensions.arousal", max: .5 }] },
    { id: "RESTLESS_TENSION", text: "가라앉지 않는 긴장", family: "DARK_SUSPENSION", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.tension", min: .62 }, { path: "trackCharacter.timbre.roughness", min: .5 },
        { path: "moodDimensions.arousal", min: .5 }] },
    { id: "SETTLED_CALM", text: "가라앉은 평정", family: "HIGH_SPEED_CALM", operator: "interpretive-compression",
      requires: [{ path: "moodDimensions.arousal", max: .3 }, { path: "moodDimensions.tension", max: .3 },
        { path: "trackCharacter.texture.sustainedness", min: .5 }] },
    { id: "RESTRAINED_INTENSITY", text: "억눌린 강도", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "moodDimensions.arousal", min: .55 }, { path: "trackCharacter.dynamics.compressionDensity", min: .6 },
        { path: "moodDimensions.tension", min: .4 }] },

    // ---------- Motion ----------
    { id: "FORWARD_PULL", text: "앞으로 당기는 추진", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.groovePushPull", max: -.2 }, { path: "primitives.pulse.metricStability", min: .5 }] },
    { id: "TRAILING_DRIFT", text: "뒤로 끌리는 표류", family: "LAID_BACK_WARMTH", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.groovePushPull", min: .2 }, { path: "moodDimensions.spaciousness", min: .5 }] },
    { id: "SUSPENDED_HOVER", text: "정지된 부유", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "primitives.pulse.pulsePresence", max: .3 }, { path: "moodDimensions.spaciousness", min: .65 },
        { path: "trackCharacter.texture.sustainedness", min: .6 }] },
    { id: "BOUNCING_LIFT", text: "튀어오르는 탄력", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "rhythmicGrammar.swing", min: .5 }, { path: "moodDimensions.valence", min: .55 },
        { path: "moodDimensions.arousal", min: .5 }] },
    { id: "GLIDING_MOTION", text: "미끄러지는 활공", family: "GENTLE_MOTION", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.metricStability", min: .55 }, { path: "moodDimensions.spaciousness", min: .5 },
        { path: "trackCharacter.timbre.roughness", max: .35 }] },
    { id: "FRAGMENTED_MOTION", text: "조각난 움직임", family: "BROKEN_URGENCY", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.rhythmicEntropy", min: .6 }, { path: "rhythmicGrammar.brokenBeat", min: .55 }] },
    { id: "ROLLING_MOMENTUM", text: "굴러가는 관성", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.rhythmicRepetition", min: .6 }, { path: "primitives.pulse.tempo", min: 140 },
        { path: "moodDimensions.arousal", min: .4 }] },
    { id: "PUSHING_URGENCY", text: "밀어붙이는 조급함", family: "SYNCOPATED_DRIVE", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.groovePushPull", max: -.15 }, { path: "moodDimensions.tension", min: .5 },
        { path: "primitives.pulse.onsetDensity", min: .55 }] },

    // ---------- Space ----------
    { id: "INTIMATE_CLOSENESS", text: "가까운 밀착감", family: "SPACIOUS_STILLNESS", operator: "spatial-metaphor",
      requires: [{ path: "moodDimensions.spaciousness", max: .3 }, { path: "primitives.production.lowEndWeight", min: .4 },
        { path: "trackCharacter.production.masterBrightness", max: .55 }] },
    { id: "VAST_OPENNESS", text: "광막한 개방감", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "moodDimensions.spaciousness", min: .78 }, { path: "primitives.production.airiness", min: .5 }] },
    { id: "DISTANT_ECHO", text: "먼 곳의 메아리", family: "SPACIOUS_STILLNESS", operator: "spatial-metaphor",
      requires: [{ path: "primitives.production.reverbTail", min: .55 }, { path: "moodDimensions.spaciousness", min: .55 },
        { path: "moodDimensions.arousal", max: .4 }] },
    { id: "DEEP_LAYERED_SPACE", text: "깊게 쌓인 공간", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "primitives.production.spatialDepth", min: .55 }, { path: "trackCharacter.texture.layeredness", min: .5 }] },
    { id: "ENCLOSED_PRESSURE", text: "닫힌 압박감", family: "DARK_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "moodDimensions.spaciousness", max: .3 }, { path: "trackCharacter.dynamics.compressionDensity", min: .65 },
        { path: "moodDimensions.tension", min: .4 }] },
    { id: "EXPANDING_FIELD", text: "확장되는 장", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "primitives.production.stereoWidth", min: .55 }, { path: "moodDimensions.spaciousness", min: .5 }] },

    // ---------- Material ----------
    { id: "GLOSSY_SURFACE", text: "매끈한 광택", family: "WARM_SATURATION", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.production.masterBrightness", min: .6 }, { path: "trackCharacter.production.cleanLoFi", min: .55 },
        { path: "moodDimensions.brightness", min: .55 }] },
    { id: "GRAINY_TEXTURE", text: "거친 입자감", family: "WARM_SATURATION", operator: "material-metaphor",
      requires: [{ path: "primitives.production.granularity", min: .55 }, { path: "trackCharacter.timbre.noisiness", min: .4 }] },
    { id: "METALLIC_SHEEN", text: "금속성 광택", family: "AIRY_SUSPENSION", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.timbre.brightness", min: .68 }, { path: "trackCharacter.timbre.roughness", min: .5 },
        { path: "moodDimensions.aggression", min: .3 }] },
    { id: "GLASSY_FRAGILITY", text: "유리 같은 투명함", family: "AIRY_SUSPENSION", operator: "material-metaphor",
      requires: [{ path: "primitives.production.airiness", min: .55 }, { path: "trackCharacter.texture.sustainedness", min: .55 },
        { path: "trackCharacter.timbre.roughness", max: .3 }] },
    { id: "SATURATED_WARMTH", text: "포화된 색감", family: "WARM_SATURATION", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.production.saturation", min: .6 }, { path: "moodDimensions.warmth", min: .55 }] },
    { id: "DUSTY_PATINA", text: "먼지 앉은 질감", family: "SAMPLE_NOSTALGIA", operator: "material-metaphor",
      requires: [{ path: "productionEvidence.sampleBased", min: .55 }, { path: "trackCharacter.production.cleanLoFi", max: .45 },
        { path: "moodDimensions.warmth", min: .45 }] },

    // ---------- Temporal feeling ----------
    { id: "RETROSPECTIVE_GLOW", text: "돌아보는 온기", family: "SAMPLE_NOSTALGIA", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.structure.repetition", min: .6 }, { path: "moodDimensions.warmth", min: .55 },
        { path: "moodDimensions.valence", min: .5 }] },
    { id: "FUTURE_FACING_SHEEN", text: "미래를 향한 광택", family: "AIRY_SUSPENSION", operator: "material-metaphor",
      requires: [{ path: "trackCharacter.production.masterBrightness", min: .62 }, { path: "primitives.production.stereoWidth", min: .45 },
        { path: "moodDimensions.arousal", min: .4 }] },
    { id: "SUSPENDED_ANTICIPATION", text: "멈춰선 기대감", family: "DARK_SUSPENSION", operator: "emotional-synthesis",
      requires: [{ path: "primitives.form.buildupSlope", min: .5 }, { path: "moodDimensions.tension", min: .45 },
        { path: "primitives.pulse.onsetDensity", max: .4 }] },
    { id: "CYCLICAL_TIMELESSNESS", text: "순환하는 무시간성", family: "HIGH_SPEED_CALM", operator: "interpretive-compression",
      requires: [{ path: "trackCharacter.structure.repetition", min: .72 }, { path: "primitives.tonal.harmonicRhythm", max: .35 }] },
    { id: "LINGERING_AFTERGLOW", text: "남아있는 잔광", family: "SAMPLE_NOSTALGIA", operator: "material-metaphor",
      requires: [{ path: "primitives.production.reverbTail", min: .5 }, { path: "moodDimensions.warmth", min: .5 },
        { path: "moodDimensions.arousal", max: .45 }] },

    // ---------- Compound cross-domain (rhythm + production + affect, per spec examples) ----------
    { id: "HIGH_SPEED_STILLNESS", text: "고속의 정적", family: "HIGH_SPEED_CALM", operator: "interpretive-compression",
      requires: [{ path: "primitives.pulse.tempo", min: 150 }, { path: "moodDimensions.arousal", max: .38 },
        { path: "moodDimensions.spaciousness", min: .55 }] },
    { id: "DISTORTED_WARMTH", text: "소음 속의 온기", family: "WARM_SATURATION", operator: "material-metaphor",
      requires: [{ path: "primitives.production.distortionLikelihood", min: .55 }, { path: "trackCharacter.harmony.harmonicMotion", max: .4 },
        { path: "moodDimensions.warmth", min: .45 }] },
    { id: "MODAL_DRIFT", text: "모달 부유", family: "AIRY_SUSPENSION", operator: "spatial-metaphor",
      requires: [{ path: "primitives.tonal.harmonicRhythm", max: .35 }, { path: "primitives.harmony.tonalAmbiguity", min: .45 },
        { path: "moodDimensions.spaciousness", min: .5 }] },
    { id: "SYNCOPATED_WARMTH", text: "당김음의 온기", family: "LAID_BACK_WARMTH", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.syncopation", min: .55 }, { path: "moodDimensions.warmth", min: .6 },
        { path: "primitives.pulse.groovePushPull", min: .1 }] },
    { id: "BRIGHT_MELANCHOLY", text: "밝은 색채의 애상", family: "BITTERSWEET_UPLIFT", operator: "emotional-synthesis",
      requires: [{ path: "moodDimensions.brightness", min: .6 }, { path: "moodDimensions.valence", max: .45 }] },
    { id: "TIGHT_ANXIOUS_PULSE", text: "조여드는 맥박", family: "DARK_SUSPENSION", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.metricStability", min: .6 }, { path: "moodDimensions.tension", min: .6 },
        { path: "trackCharacter.dynamics.compressionDensity", min: .55 }] },
    { id: "LOOSE_ORGANIC_FEEL", text: "느슨한 유기적 느낌", family: "LAID_BACK_WARMTH", operator: "kinetic-metaphor",
      requires: [{ path: "primitives.pulse.microTimingDeviation", min: .3 }, { path: "moodDimensions.warmth", min: .5 },
        { path: "trackCharacter.production.cleanLoFi", max: .6 }] },
    { id: "PRECISE_MECHANICAL_FEEL", text: "정밀한 기계적 질감", family: "HIGH_SPEED_CALM", operator: "interpretive-compression",
      requires: [{ path: "primitives.pulse.microTimingDeviation", max: .15 }, { path: "primitives.pulse.metricStability", min: .68 },
        { path: "trackCharacter.production.cleanLoFi", min: .5 }] },
    // The three below became expressible only once harmony and melody had real detectors: each one
    // leans on a measured contour or chroma-motion value, never on genre. Two independent axes are
    // still mandatory, so a falling line alone can never produce a feeling on its own.
    { id: "DESCENDING_RETROSPECT", text: "내려앉는 회고", family: "BITTERSWEET_UPLIFT", operator: "emotional-synthesis",
      requires: [{ path: "primitives.melody.contourSlope", max: -.25 }, { path: "moodDimensions.warmth", min: .55 },
        { path: "moodDimensions.valence", max: .58 }] },
    { id: "MODAL_DRIFT", text: "모달 부유", family: "SPACIOUS_STILLNESS", operator: "spatial-metaphor",
      requires: [{ path: "primitives.harmony.chordChangeRate", max: .22 }, { path: "primitives.harmony.modalAmbiguity", min: .5 },
        { path: "moodDimensions.spaciousness", min: .55 }] },
    { id: "LOOPING_ELATION", text: "반복되는 고양감", family: "COMPRESSED_EUPHORIA", operator: "emotional-synthesis",
      requires: [{ path: "primitives.melody.motifRecurrence", min: .55 }, { path: "moodDimensions.brightness", min: .6 },
        { path: "moodDimensions.valence", min: .6 }] }
  ]);

  function passes(value, condition) {
    if (!numeric(value)) return false;
    if (numeric(condition.min) && value < condition.min) return false;
    if (numeric(condition.max) && value > condition.max) return false;
    return true;
  }
  function strength(value, condition) {
    if (numeric(condition.min)) return clamp((value - condition.min) / Math.max(.001, 1 - condition.min) * .35 + .65);
    if (numeric(condition.max)) return clamp((condition.max - value) / Math.max(.001, condition.max) * .35 + .65);
    return .7;
  }

  function evaluate(state = {}, at = Date.now()) {
    const concepts = [], candidates = [];
    for (const rule of RULES) {
      const resolved = rule.requires.map(condition => ({ ...condition, value: read(state, condition.path) }));
      if (!resolved.every(item => passes(item.value, item))) continue;
      const axes = new Set(resolved.map(item => item.path.split(".")[0]));
      if (axes.size < 2) continue;
      const confidence = Math.min(...resolved.map(item => strength(item.value, item)));
      const anchors = resolved.map(item => item.path);
      const concept = { id: rule.id, text: rule.text, confidence, anchors, semanticFamily: rule.family,
        creativeOperator: rule.operator, semanticEpoch: Number(state.semanticEpoch) || 0,
        timestamp: at, ttlMs: 24000, expiresAt: at + 24000 };
      concepts.push(concept);
      candidates.push(Facets.token(rule.text, "mood", confidence, anchors, {
        source: "impression-synthesis", layer: "IMPRESSION", groundingScore: confidence,
        semanticFamily: rule.family, creativeOperator: rule.operator,
        conceptId: rule.id, epoch: concept.semanticEpoch, ttlMs: concept.ttlMs, expiresAt: concept.expiresAt
      }));
    }
    return { concepts, candidates };
  }

  return { evaluate, RULES, read, passes };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ImpressionSynthesizer;
