const RhythmicGrammar = (() => {
  const detectorCapabilities = Object.freeze({
    "productionEvidence.filterSweep": { min: 0, max: 0.92, nullable: true, method: "centroid trajectory" },
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
      groovePushPull: null, kickPeriodicity: null, rhythmicEntropy: null, beatGridConfidence: null,
      kickOccupancy: null, kickRegularity: null, backbeat: null, offbeatRate: null,
      kickPattern: null, candidates: [] };
    // Moderate beat confidence still contains useful phase evidence. It reduces the grammar's
    // confidence, but no longer nulls every field as happened in the Future Funk feedback trace.
    if (recent.length < 8 || bpm < 50 || bpm > 220 || confidence < 0.3) return result;
    const period = 60000 / bpm;
    const lows = recent.filter(x => x.onsetClass === "kick" || x.lowImpact >= 0.55);
    const lowIntervals = lows.slice(1).map((x, i) => x.at - lows[i].at);
    const reliability = 0.55 + Facets.clamp(confidence) * 0.45;
    const reference = lows[0]?.at ?? recent[0].at;
    const phaseDistance = event => {
      const beats = (event.at - reference) / period;
      return Math.abs(beats - Math.round(beats));
    };
    const beatGridAligned = recent.filter(event => phaseDistance(event) <= 0.16).length / recent.length;
    result.beatGridConfidence = Facets.clamp(beatGridAligned * reliability);
    if (lows.length >= 4) {
      const beatIndices = lows.filter(event => phaseDistance(event) <= 0.18)
        .map(event => Math.round((event.at - reference) / period));
      const uniqueBeats = new Set(beatIndices);
      const span = beatIndices.length ? Math.max(...beatIndices) - Math.min(...beatIndices) + 1 : 0;
      const occupancy = span >= 4 ? uniqueBeats.size / span : 0;
      const barSlots = new Set(beatIndices.map(index => ((index % 4) + 4) % 4));
      const slotCoverage = barSlots.size / 4;
      const alignedKicks = lows.filter(event => phaseDistance(event) <= 0.18).length / lows.length;
      result.kickOccupancy = Facets.clamp(occupancy);
      result.fourOnFloor = Facets.clamp((occupancy * 0.5 + slotCoverage * 0.25 + alignedKicks * 0.25) * reliability);
      result.kickPattern = result.fourOnFloor >= 0.72 ? "four-on-the-floor" : occupancy < 0.72 ? "broken-or-sparse" : "regular";
    }
    // A kick-like pulse can be genuinely periodic without being aligned to every beat (half-time
    // feels) — this measures the REGULARITY of the low-impact onset train on its own terms.
    if (lowIntervals.length >= 6) {
      const lowCenter = mean(lowIntervals);
      const lowVariability = lowCenter > 0
        ? Math.sqrt(mean(lowIntervals.map(x => (x - lowCenter) ** 2))) / lowCenter : 1;
      result.kickPeriodicity = Facets.clamp((1 - lowVariability) * reliability);
      result.kickRegularity = result.kickPeriodicity;
      // Half/double-time perception: compare the felt low-onset spacing to the detected beat
      // period, not to genre — a pulse landing every ~2 beats reads as half-time regardless of
      // what the track is labelled; one landing twice as often as the beat reads as double-time.
      const halfRatio = Facets.clamp(1 - Math.abs(lowCenter / period - 2) / 0.6);
      const doubleRatio = Facets.clamp(1 - Math.abs(lowCenter / period - 0.5) / 0.3);
      result.halfTimeLikelihood = lowIntervals.length >= 6 ? Facets.clamp(halfRatio * reliability) : null;
      result.doubleTimeLikelihood = lowIntervals.length >= 6 ? Facets.clamp(doubleRatio * reliability) : null;
    }
    const intervals = recent.slice(1).map((x, i) => x.at - recent[i].at);
    const swingPairs = [];
    for (let i = 0; i + 1 < intervals.length; i += 2) {
      const ratio = Math.max(intervals[i], intervals[i + 1]) / Math.max(1, Math.min(intervals[i], intervals[i + 1]));
      const pairPeriod = intervals[i] + intervals[i + 1];
      swingPairs.push(ratio >= 1.35 && ratio <= 2.3 && Math.abs(pairPeriod / period - 1) < 0.18 ? 1 : 0);
    }
    result.swing = Facets.clamp(mean(swingPairs) * reliability);
    result.subdivisionRatio = subdivisionRatio(recent);
    result.rhythmicEntropy = intervalEntropy(intervals);
    const accent = accentPeriodicity(recent);
    result.accentPeriodicity = accent.period;
    result.accentPeriodicityConfidence = accent.confidence;
    const phase = event => (((event.at - reference) / period) % 1 + 1) % 1;
    const offbeats = recent.filter(event => Math.abs(phase(event) - 0.5) <= 0.16 &&
      (event.onsetClass === "hat" || event.highImpact >= 0.45 || event.strength >= 0.72));
    const displaced = recent.filter(event => {
      const value = phase(event);
      const nearestEighth = Math.round(value * 2) / 2;
      return Math.abs(value - nearestEighth) > 0.12 && event.strength >= 0.62;
    });
    result.offbeatRate = Facets.clamp(offbeats.length / Math.max(1, recent.length));
    result.syncopation = Facets.clamp((offbeats.length * 0.7 + displaced.length) / recent.length * 2.1) * reliability;
    const backbeatCandidates = recent.filter(event => event.onsetClass === "backbeat" ||
      (Number.isFinite(event.midImpact) && event.midImpact >= 0.45));
    if (backbeatCandidates.length >= 4) {
      const backbeatHits = backbeatCandidates.filter(event => {
        const index = Math.round((event.at - reference) / period);
        return phaseDistance(event) <= 0.18 && (((index % 4) + 4) % 4 === 1 || ((index % 4) + 4) % 4 === 3);
      });
      result.backbeat = Facets.clamp(backbeatHits.length / backbeatCandidates.length * reliability);
    }
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
    // Broken beat is a KICK-GRAMMAR claim. Generic onset-interval variability is insufficient:
    // require missing/displaced kick slots or low-end irregularity and explicitly oppose a
    // strong four-on-the-floor reading.
    if (lows.length >= 6) {
      const kickOffGrid = lows.filter(event => phaseDistance(event) > 0.18).length / lows.length;
      const missing = 1 - (result.kickOccupancy ?? 0);
      const regularity = result.kickRegularity ?? 0;
      const structuralBreak = Math.max(missing, kickOffGrid, 1 - regularity);
      result.brokenBeat = structuralBreak >= 0.24
        ? Facets.clamp((missing * 0.38 + kickOffGrid * 0.32 + (1 - regularity) * 0.2 + (result.syncopation || 0) * 0.1) *
          reliability * (1 - (result.fourOnFloor || 0) * 0.55))
        : 0;
    }
    result.confidence = confidence;
    result.candidates = candidatesFromEvidence(result);
    return result;
  }
  function detectFilterSweep(features = {}, frames = []) {
    const recent = frames.slice(-8).filter(frame => Number.isFinite(frame.centroid));
    if (recent.length < 6 || Math.abs(features.deltaRms || 0) >= 0.025) return null;
    const changes = recent.slice(1).map((frame, index) => frame.centroid - recent[index].centroid);
    const direction = Math.sign(recent.at(-1).centroid - recent[0].centroid);
    if (!direction) return null;
    const directed = changes.map(change => change * direction);
    const monotonicRatio = directed.filter(change => change > 45).length / directed.length;
    const travel = Math.abs(recent.at(-1).centroid - recent[0].centroid);
    const meanStep = mean(directed.map(value => Math.max(0, value)));
    const reversal = mean(directed.filter(value => value < 0).map(Math.abs));
    if (monotonicRatio < 0.72 || travel < 700 || meanStep < 70 || reversal > meanStep * 0.45) return null;
    const trajectoryStrength = Facets.clamp((travel - 500) / 2200);
    const stepStrength = Facets.clamp((meanStep - 45) / 260);
    return Facets.clamp(0.52 + monotonicRatio * 0.2 + trajectoryStrength * 0.13 + stepStrength * 0.07);
  }
  function production(features = {}, frames = [], context = {}) {
    const filterSweep = detectFilterSweep(features, frames);
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
  // beatConfidence used to hard-gate at 0.6 -- the same all-or-nothing cutoff analyze() had for
  // its own fields until the Future Funk feedback trace showed moderate confidence (0.3-0.6) still
  // carries real phase evidence. This detector claims something MORE specific than analyze()'s
  // rhythm fields (that the ducking is beat-ALIGNED, not just present), so it keeps a floor
  // analyze() no longer has -- but the floor is 0.3, not 0.6, and confidence now scales the
  // reported strength (reliability) instead of silently discarding real duck-shape evidence.
  function detectSidechain(envelope, beatTimestamps, beatConfidence) {
    if (!Array.isArray(envelope) || !Array.isArray(beatTimestamps) || !(beatConfidence >= 0.3)) return null;
    const reliability = 0.6 + Facets.clamp(beatConfidence) * 0.4;
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
    return Facets.clamp((duckDepth * 0.5 + recovery * 0.3 + consistency * 0.2) * reliability);
  }
  return { analyze, production, detectFilterSweep, detectSidechain, subdivisionRatio, accentPeriodicity, candidatesFromEvidence, detectorCapabilities };
})();
if (typeof module !== "undefined" && module.exports) module.exports = RhythmicGrammar;
