// Evidence is judged by DIRECTION, not by distance from 0.5.
// A phrase claims something ("밝은", "차분한", "저역 중심"); this module reads what the snapshot
// actually measured for that feature and reports whether the measurement supports or contradicts
// the claim. Strong-but-opposite values must lower a candidate, never raise it.
const EvidenceCompatibility = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  // semanticSnapshot.js stores Track Character as level words; measurements stay numeric.
  const LEVELS = { "very low": 0.1, low: 0.27, medium: 0.47, high: 0.68, "very high": 0.88 };
  const TEMPO = { "very slow": 0.1, slow: 0.3, medium: 0.5, fast: 0.72, "very fast": 0.9 };

  // featureKey -> ordered candidate paths. `scale` normalises raw units into 0..1.
  const FEATURE_PATHS = {
    brightness: [["moodDimensions.brightness"], ["timbre.brightness"], ["production.masterBrightness"], ["measurements.centroid", 8000]],
    warmth: [["moodDimensions.warmth"], ["timbre.warmth"]],
    bassWeight: [["production.subWeight"], ["moodDimensions.weight"], ["measurements.bass"]],
    highEnergy: [["measurements.high"]],
    density: [["texture.density"], ["measurements.transientDensity"], ["primitives.pulse.densityPerPulse"]],
    energy: [["measurements.energy"], ["moodDimensions.arousal"]],
    arousal: [["moodDimensions.arousal"], ["measurements.energy"]],
    tempo: [["rhythm.tempo"], ["measurements.bpm", 200]],
    spaciousness: [["space.spaciousness"], ["moodDimensions.spaciousness"]],
    roughness: [["timbre.roughness"], ["moodDimensions.aggression"]],
    aggression: [["moodDimensions.aggression"], ["timbre.roughness"]],
    pulseRegularity: [["rhythm.pulseRegularity"], ["primitives.pulse.pulseRegularity"], ["rhythmicGrammar.fourOnFloor"]],
    sustain: [["texture.sustain"], ["primitives.articulation.noteLengthRatio"]],
    attack: [["timbre.transientEdge"], ["primitives.articulation.attackSharpness"], ["measurements.transientDensity"]],
    valence: [["moodDimensions.valence"]],
    tension: [["moodDimensions.tension"]],
    sampleBased: [["productionEvidence.sampleBased"]],
    swing: [["rhythmicGrammar.swing"], ["primitives.pulse.subdivisionRatio", 2]],
    syncopation: [["rhythmicGrammar.syncopation"]]
  };

  // Claim vocabulary: what a phrase asserts about the music, in either language.
  // Only direction-bearing words appear here; neutral musical nouns claim nothing.
  const CLAIMS = [
    [/밝|투명|선명|bright|shimmer/, { brightness: "high" }],
    [/어둡|어두운|음침|dark|murky/, { brightness: "low" }],
    [/따뜻|온기|포근|warm/, { warmth: "high" }],
    [/차가운|차갑|서늘|한기|cold|icy/, { warmth: "low" }],
    [/저역|서브베이스|sub.?bass|묵직|무거운|low.?end/, { bassWeight: "high" }],
    [/고역|공기감|airy|treble/, { highEnergy: "high" }],
    [/조밀|촘촘|빽빽|겹겹|레이어드|dense|layered/, { density: "high" }],
    [/희박|성긴|여백|비워|sparse|minimal/, { density: "low" }],
    [/차분|고요|정적|잔잔|느긋|calm|still|quiet/, { energy: "low", arousal: "low" }],
    [/격렬|강렬|폭발|질주|고조|intense|energetic|driving/, { energy: "high", arousal: "high" }],
    [/빠른|급박|fast|rapid/, { tempo: "high" }],
    [/느린|완만|slow/, { tempo: "low" }],
    [/부유|떠오|공간감|잔향|넓은|floating|spacious|reverb/, { spaciousness: "high" }],
    [/타이트|건조|밀착|dry|tight/, { spaciousness: "low" }],
    [/거친|공격적|왜곡|rough|aggressive|distort/, { roughness: "high", aggression: "high" }],
    [/부드러운|매끄러운|유려|smooth|gentle|soft/, { roughness: "low" }],
    [/정박|규칙적|기계적|steady|straight|metronomic/, { pulseRegularity: "high" }],
    [/불규칙|어긋|엇갈|불안정|broken|irregular/, { pulseRegularity: "low" }],
    [/지속|서스테인|레가토|길게 늘|sustain|legato|drone/, { sustain: "high" }],
    [/스타카토|끊어|짧은 음|타격적|staccato/, { sustain: "low" }],
    [/날카로운|선명한 어택|타격|sharp|percussive|attack/, { attack: "high" }],
    [/애상|쓸쓸|멜랑|우울|슬픈|melanchol|somber/, { valence: "low" }],
    [/경쾌|들뜬|낙관|달콤|화사|upbeat|sweet|bright mood/, { valence: "high" }],
    [/긴장|불안|조여|tense|anxious/, { tension: "high" }],
    [/이완|풀어|편안|relaxed/, { tension: "low" }],
    [/샘플|sampl|찹|chop/, { sampleBased: "high" }],
    [/스윙|셔플|swing|shuffle/, { swing: "high" }],
    [/싱코페이|엇박|syncopat/, { syncopation: "high" }]
  ];

  function normalize(raw, scale) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "string") {
      const key = raw.toLowerCase();
      if (Object.hasOwn(LEVELS, key)) return LEVELS[key];
      if (Object.hasOwn(TEMPO, key)) return TEMPO[key];
      return null;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    return clamp(scale ? raw / scale : raw);
  }

  function readPath(snapshot, path) {
    return String(path).split(".").reduce((value, key) =>
      value && Object.hasOwn(value, key) ? value[key] : undefined, snapshot);
  }

  function readFeature(snapshot, feature) {
    for (const [path, scale] of FEATURE_PATHS[feature] || []) {
      const value = normalize(readPath(snapshot, path), scale);
      if (value !== null) return { value, path };
    }
    return null;
  }

  // What does this phrase claim about measurable features?
  function claimProfile(text) {
    const source = String(text || "");
    const profile = {};
    for (const [pattern, claims] of CLAIMS) {
      if (!pattern.test(source)) continue;
      for (const [feature, direction] of Object.entries(claims)) {
        // An earlier, more specific claim wins over a later generic one.
        if (!Object.hasOwn(profile, feature)) profile[feature] = direction;
      }
    }
    return profile;
  }

  // support: how well the measurement agrees with the claimed direction (0..1)
  // contradiction: how strongly it points the opposite way (0..1)
  function compare(value, direction) {
    const agreement = direction === "low" ? 1 - value : value;
    return { support: clamp(agreement), contradiction: agreement < 0.35 ? clamp((0.35 - agreement) / 0.35) : 0 };
  }

  function assess(text, snapshot = {}) {
    const profile = claimProfile(text);
    const details = [];
    for (const [feature, direction] of Object.entries(profile)) {
      const reading = readFeature(snapshot, feature);
      if (!reading) continue;
      const { support, contradiction } = compare(reading.value, direction);
      details.push({ feature, direction, value: reading.value, path: reading.path, support, contradiction });
    }
    if (!details.length) return { checked: 0, support: null, contradiction: 0, claims: profile, details };
    const support = details.reduce((sum, item) => sum + item.support, 0) / details.length;
    // One clear contradiction matters more than an average that hides it.
    const contradiction = details.reduce((worst, item) => Math.max(worst, item.contradiction), 0);
    return { checked: details.length, support: clamp(support), contradiction: clamp(contradiction), claims: profile, details };
  }

  return { assess, claimProfile, compare, readFeature, normalize, FEATURE_PATHS, CLAIMS, LEVELS, TEMPO };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EvidenceCompatibility;
