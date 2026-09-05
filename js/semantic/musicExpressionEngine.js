// Literal descriptors; normalized dimensions are 0..1. Db values are digital, not SPL/LUFS.
const MusicExpressionEngine = (() => {
  const clamp = x => Math.min(1, Math.max(0, Number(x) || 0));
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const db = x => 20 * Math.log10(Math.max(1e-6, x));
  const aliases = { "고음압": "높은 음압", "큰 음압": "높은 음압", "매우 높은 라우드니스": "높은 음압",
    "긴장됨": "긴장감", "긴장된 분위기": "긴장감", "차가운 분위기": "차가움", "잔잔한 분위기": "차분함",
    "쓸쓸한 분위기": "쓸쓸함", "강한 베이스": "강한 저역", "몽환적인 분위기": "몽환적" };
  const vocabulary = {
    // Delta/transition words only — "what just changed", the one thing LIVE actually means.
    live: ["에너지 상승", "에너지 하강", "저역 유입", "저역 감소", "밝아진 고역", "어두워진 음색", "촘촘해진 리듬", "리듬 변화", "음압 상승", "음압 하강", "급격한 상승", "급격한 하강", "강한 드롭", "구간 전환", "드롭 진입", "브레이크", "빌드업"],
    // Current-state descriptors: how the track measures right now, not what changed.
    rhythm: ["빠른 리듬", "느린 리듬", "촘촘한 리듬", "적은 트랜지언트", "반복되는 펄스", "잘게 쪼개진 비트"],
    dynamics: ["거친 질감", "부드러운 질감", "밝은 음색", "어두운 음색", "강한 저역", "중역 중심", "고역 중심", "높은 밀도", "낮은 밀도", "강한 어택", "부드러운 어택", "긴 서스테인", "빠른 화성 이동", "안정된 화성",
      "높은 음압", "낮은 음압", "강한 압축", "약한 압축", "넓은 다이내믹", "좁은 다이내믹", "강한 피크", "부드러운 피크", "강한 펌핑", "약한 펌핑", "높은 에너지", "낮은 에너지", "잔잔한 구간"],
    mood: ["차분함", "긴장감", "쓸쓸함", "따뜻함", "차가움", "몽환적", "경쾌함", "어두움", "밝음", "우울함", "불안함", "평온함", "신비로움", "공허함", "부드러움", "공격적", "무거움", "가벼움", "들뜸", "절제됨", "격렬함", "감성적", "서늘함", "편안함", "황홀함", "불길함", "웅장함"]
  };
  const canonical = text => aliases[String(text || "").trim()] || String(text || "").trim();
  const semanticKey = text => canonical(text).toLowerCase();
  function measure(samples = []) {
    let squares = 0, peak = 0;
    for (const x of samples) { squares += x * x; peak = Math.max(peak, Math.abs(x)); }
    const rms = Math.sqrt(squares / Math.max(1, samples.length));
    return { rms, peak, rmsDb: db(rms), peakDb: db(peak), crestFactorDb: rms > 1e-6 ? db(peak / rms) : 0 };
  }
  function measureSpectrum(spectrum, sampleRate, fftSize) {
    let total = 0, weighted = 0, magnitudeSum = 0, logSum = 0, count = 0;
    let bass = 0, mid = 0, high = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const hz = i * sampleRate / fftSize;
      if (hz < 20 || hz > 20000) continue;
      // Analyser byte bins are log-scaled display data, not linear spectral energy.
      const magnitude = Number.isFinite(spectrum[i]) ? 10 ** (spectrum[i] / 20) : 0;
      const power = magnitude * magnitude;
      total += power; weighted += hz * magnitude; magnitudeSum += magnitude;
      logSum += Math.log(Math.max(1e-12, magnitude)); count++;
      if (hz < 250) bass += power; else if (hz < 2000) mid += power; else high += power;
    }
    return { centroid: magnitudeSum > 1e-9 ? weighted / magnitudeSum : 0,
      flatness: magnitudeSum > 1e-9 ? Math.exp(logSum / Math.max(1, count)) / (magnitudeSum / count) : 0,
      bass: total > 1e-12 ? bass / total : 0, mid: total > 1e-12 ? mid / total : 0, high: total > 1e-12 ? high / total : 0 };
  }
  class FeatureHistory {
    constructor({ intervalMs = 500, windowMs = 45000, capacity = 90 } = {}) {
      Object.assign(this, { intervalMs, windowMs, capacity }); this.reset();
    }
    reset() { this.frames = []; this.current = null; this.lastAt = -Infinity; this.startedAt = null; }
    update(audio = {}, at = Date.now()) {
      if (at - this.lastAt < this.intervalMs) return this.current;
      if (this.startedAt === null) this.startedAt = at;
      const baseline = this.frames.filter(f => at - f.at <= 2500);
      this.frames.push({ ...audio, at });
      this.frames = this.frames.filter(f => at - f.at <= this.windowMs).slice(-this.capacity);
      this.lastAt = at;
      const short = this.frames.filter(f => at - f.at <= 6000);
      const levels = short.map(f => db(f.rms || 0)).sort((a, b) => a - b);
      const rangeDb = levels.length >= 6 ? levels[Math.floor((levels.length - 1) * 0.9)] - levels[Math.floor((levels.length - 1) * 0.1)] : null;
      const deltas = {};
      const fields = { Rms: "rms", Peak: "peak", Centroid: "centroid", Flux: "flux", LowEnergy: "bass", MidEnergy: "mid", HighEnergy: "high", TransientDensity: "transientDensity", Energy: "energy" };
      for (const [name, key] of Object.entries(fields)) deltas["delta" + name] = baseline.length >= 3 ? (audio[key] || 0) - mean(baseline.map(f => f[key] || 0)) : 0;
      deltas.deltaDynamicRange = rangeDb !== null && Number.isFinite(this.current?.dynamicRangeDb) ? rangeDb - this.current.dynamicRangeDb : 0;
      const rms = audio.rms || 0;
      const crestFactorDb = rms > 1e-6 ? db(Math.max(rms, audio.peak || 0) / rms) : 0;
      const energyMean = mean(short.map(f => f.energy || 0));
      this.current = { ...audio, ...deltas, sampledAt: at, observationSeconds: (at - this.startedAt) / 1000,
        sampleCount: this.frames.length, rmsDb: db(rms), peakDb: db(audio.peak || 0), crestFactorDb,
        shortTermLoudnessDb: db(Math.sqrt(mean(short.map(f => (f.rms || 0) ** 2)))), dynamicRangeDb: rangeDb,
        // A low crest alone (such as a sine wave) is not evidence of compression.
        compressionEstimate: short.length >= 6 && rms > 0.09 && audio.flatness > 0.025 ? clamp((12 - crestFactorDb) / 10) * clamp((8 - rangeDb) / 6) : null,
        energyVariance: mean(short.map(f => ((f.energy || 0) - energyMean) ** 2)),
        dropScore: baseline.length >= 3 && rms > 0.04 ? clamp(Math.max(0, deltas.deltaEnergy) * 2.6 + Math.max(0, deltas.deltaLowEnergy) * 0.8) : 0,
        changing: Math.abs(deltas.deltaEnergy) > 0.09 || Math.abs(deltas.deltaRms) > 0.035, audible: rms > 0.001 };
      return this.current;
    }
    summary() {
      const result = { windowSeconds: this.frames.length > 1 ? (this.frames.at(-1).at - this.frames[0].at) / 1000 : 0, sampleCount: this.frames.length };
      for (const key of ["rms", "peak", "energy", "centroid", "flatness", "flux", "zcr", "bass", "mid", "high", "bpm", "beatConfidence", "tempoStability", "onsetRate", "transientDensity", "harmonicMovement"])
        result[key] = mean(this.frames.map(f => Number(f[key]) || 0));
      return result;
    }
  }
  function generate(state = {}) {
    const a = state.expressionFeatures || state.audio || {}, c = state.trackCharacter || {};
    if (!a.sampleCount && !a.rms && !(c.confidence > 0.12)) return [];
    const target = new Map();
    const add = (text, category, weight = 0.8, extra = {}) => {
      const layer = extra.layer || (category === "live" ? "LIVE" : category === "genre" ? "CONTEXT" : category === "mood" ? "IMPRESSION" : "FACT");
      const source = extra.source || (layer === "LIVE" ? "live" : category === "genre" ? "genre" : category === "mood" ? "impression" : "primitive");
      target.set(semanticKey(text), { text, category,
      weight, confidence: weight, kind: category === "genre" ? "style" : "descriptor", role: "none", anchors: [],
      type: text.includes(" ") ? "fragment" : "single", perspective: category, layer, source,
      semanticKey: semanticKey(text), ...extra });
    };
    if (a.audible === false) { add("낮은 음압", "dynamics"); add("낮은 에너지", "dynamics"); return [...target.values()]; }
    const genre = state.genre || {};
    if (!genre.uncertain && genre.primary && genre.confidence >= 0.55) add(genre.primary, "genre", genre.confidence,
      { role: "primary", anchors: ["genreEvidence.0.confidence", "rhythm.pulseRegularity"],
        relationFamily: "PRIMARY_GENRE", relationScore: genre.confidence });
    // Neighborhood similarity scores are not calibrated genre confidence.
    for (const item of (genre.secondary || []).slice(0, 2))
      if (item?.confidence >= 0.65 && item?.label) add(item.label, "genre", item.confidence,
        { role: "secondary", anchors: ["genreEvidence.1.confidence", "timbre.roughness"],
          relationFamily: "ADJACENCY", relationScore: item.confidence });
    const r = c.rhythm || {}, t = c.timbre || {}, x = c.texture || {}, h = c.harmony || {};
    // Everything below reads an ABSOLUTE current measurement, not a before/after delta — so it
    // describes what the track IS right now (FACT), never what just changed (LIVE, further down).
    const density = a.transientDensity ?? r.onsetDensity;
    const densityAnchors = ["measurements.transientDensity", "rhythm.onsetDensity"];
    if (density > 0.65) add("촘촘한 리듬", "rhythm", 0.8, { anchors: densityAnchors });
    else if (density < 0.18) add("적은 트랜지언트", "rhythm", 0.8, { anchors: densityAnchors });
    const pulseAnchors = ["measurements.beatConfidence", "rhythm.pulseRegularity"];
    if ((a.beatConfidence ?? r.pulseRegularity) > 0.65) {
      add("반복되는 펄스", "rhythm", 0.8, { anchors: pulseAnchors });
      if ((a.bpm || r.bpm) > 155) add("빠른 리듬", "rhythm", 0.8, { anchors: ["measurements.bpm", "rhythm.tempo"] });
      else if ((a.bpm || r.bpm) < 92) add("느린 리듬", "rhythm", 0.8, { anchors: ["measurements.bpm", "rhythm.tempo"] });
    }
    if (r.breakbeatLikelihood > 0.7 && density > 0.55) add("잘게 쪼개진 비트", "rhythm", 0.8, { anchors: ["rhythm.brokenPulse", ...densityAnchors] });
    const brightness = Number.isFinite(a.centroid) ? clamp(a.centroid / 8000) : t.brightness;
    const brightnessAnchors = ["measurements.centroid", "timbre.brightness"];
    if (brightness > 0.68) add("밝은 음색", "dynamics", 0.8, { anchors: brightnessAnchors });
    else if (brightness < 0.28) add("어두운 음색", "dynamics", 0.8, { anchors: brightnessAnchors });
    if (t.roughness > 0.7) add("거친 질감", "dynamics", 0.8, { anchors: ["timbre.roughness"] });
    else if (t.roughness < 0.25) add("부드러운 질감", "dynamics", 0.8, { anchors: ["timbre.roughness"] });
    if (t.transientSharpness > 0.7) add("강한 어택", "dynamics", 0.8, { anchors: ["timbre.transientEdge"] });
    else if (t.transientSharpness < 0.25) add("부드러운 어택", "dynamics", 0.8, { anchors: ["timbre.transientEdge"] });
    if (x.sustainedness > 0.72) add("긴 서스테인", "dynamics", 0.8, { anchors: ["texture.sustain"] });
    const total = (a.bass || 0) + (a.mid || 0) + (a.high || 0);
    const balanceAnchors = ["measurements.bass", "measurements.mid", "measurements.high"];
    if (total > 0.03) {
      if (a.bass / total > 0.5) add("강한 저역", "dynamics", 0.8, { anchors: balanceAnchors });
      else if (a.mid / total > 0.5) add("중역 중심", "dynamics", 0.8, { anchors: balanceAnchors });
      else if (a.high / total > 0.5) add("고역 중심", "dynamics", 0.8, { anchors: balanceAnchors });
    }
    const spectralDensity = Number.isFinite(a.energy) ? clamp(a.energy * 1.8) : x.density;
    const spectralDensityAnchors = ["measurements.energy", "texture.density"];
    if (spectralDensity > 0.72) add("높은 밀도", "dynamics", 0.8, { anchors: spectralDensityAnchors });
    else if (spectralDensity < 0.25) add("낮은 밀도", "dynamics", 0.8, { anchors: spectralDensityAnchors });
    const harmonyAnchors = ["harmony.harmonicMotion", "harmony.tonalFocus"];
    if (h.harmonicMotion > 0.72) add("빠른 화성 이동", "dynamics", 0.8, { anchors: harmonyAnchors });
    else if (h.harmonicMotion < 0.2 && h.tonalness > 0.6) add("안정된 화성", "dynamics", 0.8, { anchors: harmonyAnchors });
    if (a.rms > 0.14) add("높은 음압", "dynamics", 0.9, { anchors: ["measurements.rms"] });
    else if (a.rms < 0.04) add("낮은 음압", "dynamics", 0.9, { anchors: ["measurements.rms"] });
    if (a.energy > 0.42) add("높은 에너지", "dynamics", 0.8, { anchors: ["measurements.energy"] });
    else if (a.energy < 0.13) add("낮은 에너지", "dynamics", 0.8, { anchors: ["measurements.energy"] });
    if (a.dynamicRangeDb > 10) add("넓은 다이내믹", "dynamics");
    else if (Number.isFinite(a.dynamicRangeDb) && a.dynamicRangeDb < 3) add("좁은 다이내믹", "dynamics");
    if (a.compressionEstimate > 0.72) add("강한 압축", "dynamics");
    if (a.crestFactorDb > 14 && a.peak > 0.2) add("강한 피크", "dynamics");
    if (a.pumping > 0.7 && a.beatConfidence > 0.65) add("강한 펌핑", "dynamics");
    const ttlByDelta = { deltaEnergy: 1800, deltaRms: 1500, deltaLowEnergy: 2200,
      deltaCentroid: 1600, deltaTransientDensity: 1700 };
    const deltaMeta = (key, currentKey) => ({ layer: "LIVE", source: "live", deltaSource: key,
      ttlMs: ttlByDelta[key] || 1800,
      previousValue: Number.isFinite(a[currentKey]) && Number.isFinite(a[key]) ? a[currentKey] - a[key] : null,
      currentValue: Number.isFinite(a[currentKey]) ? a[currentKey] : null,
      deltaMagnitude: Math.abs(Number(a[key]) || 0), anchors: ["measurements." + key, "measurements." + currentKey] });
    for (const [key, currentKey, threshold, up, down, cat] of [
      ["deltaEnergy", "energy", 0.09, "에너지 상승", "에너지 하강", "live"], ["deltaRms", "rms", 0.035, "음압 상승", "음압 하강", "dynamics"],
      ["deltaLowEnergy", "bass", 0.12, "저역 유입", "저역 감소", "live"], ["deltaCentroid", "centroid", 900, "밝아진 고역", "어두워진 음색", "live"],
      ["deltaTransientDensity", "transientDensity", 0.18, "촘촘해진 리듬", "리듬 변화", "live"]]) {
      if (a[key] > threshold) add(up, cat, 0.97, deltaMeta(key, currentKey));
      else if (a[key] < -threshold) add(down, cat, 0.97, deltaMeta(key, currentKey));
    }
    if (a.deltaEnergy > 0.22) add("급격한 상승", "dynamics", 1, deltaMeta("deltaEnergy", "energy"));
    else if (a.deltaEnergy < -0.22) add("급격한 하강", "dynamics", 1, deltaMeta("deltaEnergy", "energy"));
    if (a.dropScore > 0.68 && a.deltaEnergy > 0.09) {
      const meta = { ...deltaMeta("deltaEnergy", "energy"), deltaSource: "dropScore", deltaMagnitude: a.dropScore,
        ttlMs: 3200, anchors: ["measurements.dropScore", "measurements.deltaEnergy"] };
      add("강한 드롭", "dynamics", 1, meta); add("드롭 진입", "live", 1, meta);
    }
    if (state.novelty?.transitionDetected && a.changing) add("구간 전환", "live", 0.96,
      { ...deltaMeta("deltaEnergy", "energy"), deltaSource: "sectionNovelty",
        ttlMs: 3000, deltaMagnitude: state.novelty.score || Math.abs(a.deltaEnergy || 0), anchors: ["currentSection.novelty", "measurements.deltaEnergy"] });
    if (a.deltaEnergy > 0.04 && c.structure?.buildupLikelihood > 0.68) add("빌드업", "live", 0.94,
      { ...deltaMeta("deltaEnergy", "energy"), ttlMs: 2600, anchors: ["measurements.deltaEnergy", "currentSection.buildup"] });
    if (a.deltaEnergy < -0.09 && c.structure?.breakdownLikelihood > 0.6) add("브레이크", "live", 0.94,
      { ...deltaMeta("deltaEnergy", "energy"), ttlMs: 2600, anchors: ["measurements.deltaEnergy", "currentSection.breakdown"] });
    const m = state.moodDimensions || state.mood?.fused || state.mood?.local || {};
    const arousal = Number.isFinite(a.rms) && Number.isFinite(a.energy) ? clamp(a.rms * 3.2 + a.energy * 1.35) : m.arousal;
    const warmth = m.warmth ?? t.warmth, tension = m.tension;
    if (arousal < 0.34) add("차분함", "mood"); if (arousal > 0.82) add("격렬함", "mood");
    if (tension > 0.62) add("긴장감", "mood"); else if (tension < 0.28 && arousal < 0.45) add("평온함", "mood");
    if (warmth > 0.68) add("따뜻함", "mood"); else if (warmth < 0.32) add("차가움", "mood");
    if (brightness > 0.68) add("밝음", "mood"); else if (brightness < 0.28) add("어두움", "mood");
    if (m.valence < 0.38 && arousal < 0.5) add("쓸쓸함", "mood");
    if (m.valence > 0.62 && arousal > 0.55) add("경쾌함", "mood");
    if (m.valence > 0.65 && arousal > 0.75) add("들뜸", "mood");
    if (m.valence < 0.38 && tension > 0.62) add("불안함", "mood");
    if (x.sustainedness > 0.72 && arousal < 0.45 && m.spaciousness > 0.62) add("몽환적", "mood");
    if (arousal > 0.72 && t.roughness > 0.72) add("공격적", "mood");
    if (m.weight > 0.65 && arousal > 0.45) add("무거움", "mood");
    else if (m.weight < 0.2 && arousal < 0.45) add("가벼움", "mood");
    if (m.aggression > 0.72 && arousal > 0.65) add("공격적", "mood");
    return [...target.values()].slice(0, 40);
  }
  return { generate, FeatureHistory, measure, measureSpectrum, canonical, semanticKey, vocabulary };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MusicExpressionEngine;
