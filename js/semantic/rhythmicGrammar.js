const RhythmicGrammar = (() => {
  const detectorCapabilities = Object.freeze({
    "productionEvidence.filterSweep": { min: 0, max: 0.74, nullable: true, method: "centroid trajectory" },
    "productionEvidence.sidechain": { min: 0, max: 1, nullable: true, method: "beat-aligned envelope" },
    "productionEvidence.sampleBased": { min: 0, max: 0.9, nullable: true, method: "repetition + master brightness" },
    "productionEvidence.vocalChop": { min: 0, max: 0.86, nullable: true, method: "voice confidence + onset rate" },
    "productionEvidence.stereoWidth": { available: false, nullable: true },
    "productionEvidence.reverb": { available: false, nullable: true },
    "productionEvidence.distortion": { available: false, nullable: true }
  });
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const median = xs => {
    if (!xs.length) return null;
    const values = xs.slice().sort((a, b) => a - b), middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  };
  function candidatesFromEvidence(result = {}) {
    const candidates = [];
    const add = (text, confidence, anchors) => candidates.push(Facets.token(text, "rhythm", confidence, anchors, { source: "rhythm" }));
    if (result.fourOnFloor >= 0.72) add("4/4 플로어", result.fourOnFloor,
      ["rhythmicGrammar.fourOnFloor", "rhythmicGrammar.onsetCount"]);
    if (result.swing >= 0.62) add("스윙 필", result.swing,
      ["rhythmicGrammar.swing", "rhythmicGrammar.onsetCount"]);
    if (result.syncopation >= 0.62) add("싱코페이션", result.syncopation,
      ["rhythmicGrammar.syncopation", "rhythmicGrammar.onsetCount"]);
    if (result.brokenBeat >= 0.68) add("브레이크비트", result.brokenBeat,
      ["rhythmicGrammar.brokenBeat", "rhythmicGrammar.onsetCount"]);
    if (result.brokenBeat >= 0.68 && result.swing >= 0.58 && !(result.fourOnFloor >= 0.55)) add("2-Step",
      Math.min(result.brokenBeat, result.swing),
      ["rhythmicGrammar.brokenBeat", "rhythmicGrammar.swing", "rhythmicGrammar.fourOnFloor"]);
    return candidates;
  }
  function subdivisionRatio(events = []) {
    const intervals = events.slice(1).map((event, index) => event.at - events[index].at).filter(value => value > 0);
    const ratios = [];
    for (let index = 0; index + 1 < intervals.length; index += 2) {
      ratios.push(Math.max(intervals[index], intervals[index + 1]) / Math.max(1, Math.min(intervals[index], intervals[index + 1])));
    }
    return ratios.length >= 2 ? median(ratios) : null;
  }
  function accentPeriodicity(events = []) {
    if (events.length < 12) return { period: null, confidence: 0 };
    const strengths = events.map(event => Number(event.strength) || 0);
    let best = { period: null, confidence: 0 };
    for (let period = 2; period <= 9; period++) {
      if (strengths.length < period * 2) continue;
      const left = strengths.slice(period), right = strengths.slice(0, -period);
      const leftMean = mean(left), rightMean = mean(right);
      let numerator = 0, aa = 0, bb = 0;
      for (let index = 0; index < left.length; index++) {
        const a = left[index] - leftMean, b = right[index] - rightMean;
        numerator += a * b; aa += a * a; bb += b * b;
      }
      const correlation = aa && bb ? Math.max(0, numerator / Math.sqrt(aa * bb)) : 0;
      if (correlation > best.confidence) best = { period, confidence: correlation };
    }
    return best.confidence >= 0.35 ? best : { period: null, confidence: best.confidence };
  }
  // Shannon entropy (base 2, normalised to 0..1) of the onset-interval histogram: a real measure
  // of how unpredictable the rhythmic spacing is, replacing a pass-through of an unrelated
  // upstream "complexity" field with something this module actually computes from the events.
  function intervalEntropy(intervals = []) {
    if (intervals.length < 6) return null;
    const positive = intervals.filter(value => value > 0);
    if (positive.length < 6) return null;
    const centerValue = median(positive) || mean(positive);
    if (!(centerValue > 0)) return null;
    const BINS = 6;
    const counts = new Array(BINS).fill(0);
    for (const value of positive) {
      const ratio = value / centerValue;
      const bin = ratio < 0.6 ? 0 : ratio < 0.85 ? 1 : ratio < 1.15 ? 2 : ratio < 1.6 ? 3 : ratio < 2.4 ? 4 : 5;
      counts[bin]++;
    }
    const total = positive.length;
    let entropy = 0;
    for (const count of counts) {
      if (!count) continue;
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
    return Facets.clamp(entropy / Math.log2(BINS));
  }

  function analyze(events = [], bpm = 0, confidence = 0, at = Date.now()) {
    const recent = events.filter(x => Number.isFinite(x.at) && at - x.at <= 10000 && x.at <= at).slice(-96).sort((a, b) => a.at - b.at);
    const result = { confidence: 0, onsetCount: recent.length, fourOnFloor: null, swing: null, syncopation: null,
      brokenBeat: null, subdivisionRatio: null, accentPeriodicity: null, accentPeriodicityConfidence: 0,
      accentPlacement: null, halfTimeLikelihood: null, doubleTimeLikelihood: null, microTimingDeviation: null,
      groovePushPull: null, kickPeriodicity: null, rhythmicEntropy: null, candidates: [] };
    if (recent.length < 8 || bpm < 50 || bpm > 220 || confidence < 0.6) return result;
    const period = 60000 / bpm;
    const lows = recent.filter(x => x.lowImpact >= 0.55);
    const lowIntervals = lows.slice(1).map((x, i) => x.at - lows[i].at);
    const aligned = lowIntervals.length ? mean(lowIntervals.map(x => Math.abs(x / period - 1) < 0.14 ? 1 : 0)) : 0;
    result.fourOnFloor = lows.length >= 8 ? Facets.clamp(aligned * confidence) : null;
    // A kick-like pulse can be genuinely periodic without being aligned to every beat (half-time
    // feels) — this measures the REGULARITY of the low-impact onset train on its own terms.
    if (lowIntervals.length >= 6) {
      const lowCenter = mean(lowIntervals);
      const lowVariability = lowCenter > 0
        ? Math.sqrt(mean(lowIntervals.map(x => (x - lowCenter) ** 2))) / lowCenter : 1;
      result.kickPeriodicity = Facets.clamp((1 - lowVariability) * confidence);
      // Half/double-time perception: compare the felt low-onset spacing to the detected beat
      // period, not to genre — a pulse landing every ~2 beats reads as half-time regardless of
      // what the track is labelled; one landing twice as often as the beat reads as double-time.
      const halfRatio = Facets.clamp(1 - Math.abs(lowCenter / period - 2) / 0.6);
      const doubleRatio = Facets.clamp(1 - Math.abs(lowCenter / period - 0.5) / 0.3);
      result.halfTimeLikelihood = lowIntervals.length >= 6 ? Facets.clamp(halfRatio * confidence) : null;
      result.doubleTimeLikelihood = lowIntervals.length >= 6 ? Facets.clamp(doubleRatio * confidence) : null;
    }
    const intervals = recent.slice(1).map((x, i) => x.at - recent[i].at);
    const swingPairs = [];
    for (let i = 0; i + 1 < intervals.length; i += 2) {
      const ratio = Math.max(intervals[i], intervals[i + 1]) / Math.max(1, Math.min(intervals[i], intervals[i + 1]));
      const pairPeriod = intervals[i] + intervals[i + 1];
      swingPairs.push(ratio >= 1.35 && ratio <= 2.3 && Math.abs(pairPeriod / period - 1) < 0.18 ? 1 : 0);
    }
    result.swing = mean(swingPairs) * confidence;
    result.subdivisionRatio = subdivisionRatio(recent);
    result.rhythmicEntropy = intervalEntropy(intervals);
    const accent = accentPeriodicity(recent);
    result.accentPeriodicity = accent.period;
    result.accentPeriodicityConfidence = accent.confidence;
    const reference = lows[0]?.at ?? recent[0].at;
    const offbeats = recent.filter(x => {
      const phase = ((x.at - reference) / period) % 1;
      return phase > 0.18 && phase < 0.82 && x.strength >= 0.65;
    });
    result.syncopation = Facets.clamp(offbeats.length / recent.length * 1.6) * confidence;
    const strong = recent.filter(x => x.strength >= 0.65);
    result.accentPlacement = strong.length ? mean(strong.map(x => {
      const phase = (((x.at - reference) / period) % 1 + 1) % 1;
      return Math.min(phase, 1 - phase) * 2;
    })) : null;
    // Signed deviation of strong onsets from the nearest 16th-note grid point: negative means
    // onsets consistently land AHEAD of the grid (pushed/rushed), positive means BEHIND (laid
    // back). Distinct from brokenBeat's unsigned interval variability.
    if (strong.length >= 6) {
      const deviations = strong.map(x => {
        const phase = (((x.at - reference) / period) % 1 + 1) % 1;
        const nearestGrid = Math.round(phase * 4) / 4;
        let delta = phase - nearestGrid;
        if (delta > 0.5) delta -= 1; else if (delta < -0.5) delta += 1;
        return delta;
      });
      // Deviations are bounded to +-0.125 of a beat (half the 16th-note grid spacing); scale by 8
      // so a fully-committed push or pull reaches the +-1 ends of the signed range.
      result.groovePushPull = Math.max(-1, Math.min(1, mean(deviations) * 8));
      result.microTimingDeviation = Facets.clamp(mean(deviations.map(Math.abs)) * 8) * confidence;
    }
    const center = mean(intervals);
    const variability = Math.sqrt(mean(intervals.map(x => (x - center) ** 2))) / Math.max(1, center);
    result.brokenBeat = Facets.clamp(variability * 1.8) * confidence;
    result.confidence = confidence;
    result.candidates = candidatesFromEvidence(result);
    return result;
  }
  function production(features = {}, frames = [], context = {}) {
    const recent = frames.slice(-6);
    const changes = recent.slice(1).map((f, i) => f.centroid - recent[i].centroid);
    const consistent = changes.length >= 4 && (changes.every(x => x > 100) || changes.every(x => x < -100));
    const filterSweep = consistent && Math.abs(features.deltaRms || 0) < 0.025 && Math.abs(features.deltaCentroid || 0) > 900 ? 0.74 : null;
    const sidechain = detectSidechain(context.envelope, context.beatTimestamps, context.beatConfidence);
    const sampleBased = Number.isFinite(context.repetition) && Number.isFinite(context.masterBrightness) &&
      context.repetition >= 0.75 && context.masterBrightness <= 0.4
      ? Math.min(0.9, Facets.clamp(context.repetition * 0.6 + (1 - context.masterBrightness) * 0.4)) : null;
    const vocalChop = Number.isFinite(context.voiceConfidence) && Number.isFinite(context.onsetRate) &&
      context.voiceConfidence >= 0.6 && context.onsetRate > 2.5
      ? Math.min(0.86, Facets.clamp(context.voiceConfidence * 0.5 + Facets.clamp((context.onsetRate - 1.5) / 3) * 0.5)) : null;
    return { filterSweep, pumping: features.pumping ?? null, sidechain, sampleBased, vocalChop,
      stereoWidth: null, reverb: null, distortion: null, sourceSeparation: false };
  }
  // Averages the beat-relative energy trajectory across recent beat windows and looks for the
  // duck-then-recover shape characteristic of sidechain ducking, not just generic energy variance.
  function detectSidechain(envelope, beatTimestamps, beatConfidence) {
    if (!Array.isArray(envelope) || !Array.isArray(beatTimestamps) || !(beatConfidence >= 0.6)) return null;
    const beats = beatTimestamps.filter(Number.isFinite).sort((a, b) => a - b);
    if (beats.length < 7) return null;
    const BUCKETS = 8;
    const windows = [];
    for (let index = 0; index + 1 < beats.length && windows.length < 12; index++) {
      const start = beats[index], end = beats[index + 1];
      const span = end - start;
      if (span < 180 || span > 2200) continue;
      const inWindow = envelope.filter(sample => sample.at >= start && sample.at < end);
      if (inWindow.length < BUCKETS) continue;
      const buckets = new Array(BUCKETS).fill(0);
      const counts = new Array(BUCKETS).fill(0);
      for (const sample of inWindow) {
        const phase = (sample.at - start) / span;
        const bucket = Math.min(BUCKETS - 1, Math.floor(phase * BUCKETS));
        buckets[bucket] += sample.value; counts[bucket] += 1;
      }
      if (counts.some(count => count === 0)) continue;
      windows.push(buckets.map((sum, i) => sum / counts[i]));
    }
    if (windows.length < 6) return null;
    const shape = new Array(BUCKETS).fill(0).map((_, bucket) => mean(windows.map(w => w[bucket])));
    const peak = Math.max(shape[0], 1e-6);
    const trough = Math.min(...shape.slice(1, 4));
    const tail = mean(shape.slice(-2));
    const duckDepth = Facets.clamp((peak - trough) / peak);
    const recovery = Facets.clamp((tail - trough) / Math.max(1e-6, peak - trough));
    const duckDepths = windows.map(w => (Math.max(w[0], 1e-6) - Math.min(...w.slice(1, 4))) / Math.max(w[0], 1e-6));
    const consistency = Facets.clamp(1 - (Math.sqrt(mean(duckDepths.map(x => (x - duckDepth) ** 2))) / Math.max(0.05, duckDepth)));
    if (duckDepth < 0.22 || recovery < 0.35) return null;
    return Facets.clamp(duckDepth * 0.5 + recovery * 0.3 + consistency * 0.2);
  }
  return { analyze, production, subdivisionRatio, accentPeriodicity, candidatesFromEvidence, detectorCapabilities };
})();
if (typeof module !== "undefined" && module.exports) module.exports = RhythmicGrammar;
