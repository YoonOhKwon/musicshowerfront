// Harmonic-motion detector (section 4). Reads the chroma vector sequence the Meyda stage already
// produces and derives how FAST and how STABLY the harmony moves, plus a major/minor/modal
// tendency and a conservative tonal center. It deliberately does not attempt chord labels: frame-
// to-frame chroma distance is enough for "stable / moderate / rapid harmonic movement", and a key
// is named only when the window's templates (or Krumhansl-Schmuckler) agree with enough margin.
// Specific modes (Dorian, Mixolydian) are never claimed from a folded 12-bin mix chroma.
//
// Every output is null until the window really supports it, and `confidence` reports how much of
// the estimate rests on a clear tonal signal rather than on noise.
const HarmonicMotion = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const MIN_FRAMES = 12;
  // Below this, the chroma vector is mostly percussive/noise energy and its frame-to-frame
  // distance says nothing about harmony.
  const MIN_TONAL_FOCUS = 0.12;

  // Scale-degree templates, all rooted on pitch class 0 and rotated at match time. Weighted so the
  // tonic/fifth/third carry more evidence than passing degrees.
  const TEMPLATES = Object.freeze({
    major:      [5, 0, 2, 0, 4, 3, 0, 4.5, 0, 2, 0, 2],
    minor:      [5, 0, 2, 4, 0, 3, 0, 4.5, 2, 0, 2, 0],
    dorian:     [5, 0, 2, 4, 0, 3, 0, 4.5, 0, 2, 2, 0],
    mixolydian: [5, 0, 2, 0, 4, 3, 0, 4.5, 0, 2, 2, 0],
    lydian:     [5, 0, 2, 0, 4, 0, 3, 4.5, 0, 2, 0, 2],
    phrygian:   [5, 2, 0, 4, 0, 3, 0, 4.5, 2, 0, 2, 0]
  });
  const MODAL_FAMILIES = Object.freeze(["dorian", "mixolydian", "lydian", "phrygian"]);

  const usable = frame => Array.isArray(frame) && frame.length === 12 && frame.every(finite) &&
    frame.some(value => value > 0);

  function normalize(frame) {
    const norm = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? frame.map(value => value / norm) : null;
  }

  function cosine(left, right) {
    let dot = 0, aa = 0, bb = 0;
    for (let index = 0; index < 12; index++) {
      dot += left[index] * right[index];
      aa += left[index] * left[index];
      bb += right[index] * right[index];
    }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }

  const median = values => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  // Shannon entropy of a pitch-class distribution, normalized to 0..1. High entropy means the
  // energy is spread across many pitch classes (chromatic/dense), low means a focused pitch set.
  function chromaEntropy(frame) {
    const total = frame.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) return null;
    let entropy = 0;
    for (const value of frame) {
      const probability = Math.max(0, value) / total;
      if (probability > 0) entropy -= probability * Math.log(probability);
    }
    return clamp(entropy / Math.log(12));
  }

  // Least-squares slope over evenly spaced samples, scaled into -1..1.
  function trend(values) {
    const count = values.length;
    if (count < 4) return null;
    const meanIndex = (count - 1) / 2;
    const meanValue = mean(values);
    let numerator = 0, denominator = 0;
    for (let index = 0; index < count; index++) {
      numerator += (index - meanIndex) * (values[index] - meanValue);
      denominator += (index - meanIndex) ** 2;
    }
    if (!denominator) return null;
    // slope is "per frame"; a full-scale swing across the window maps to +-1.
    const slope = numerator / denominator;
    return Math.max(-1, Math.min(1, slope * count));
  }

  function templateScores(frame) {
    const best = {};
    for (const [name, template] of Object.entries(TEMPLATES)) {
      let bestScore = -Infinity, bestTonic = 0;
      for (let tonic = 0; tonic < 12; tonic++) {
        const rotated = Array.from({ length: 12 }, (_, index) => template[(index - tonic + 12) % 12]);
        const score = cosine(frame, rotated);
        if (score > bestScore) { bestScore = score; bestTonic = tonic; }
      }
      best[name] = { score: bestScore, tonic: bestTonic };
    }
    return best;
  }

  // Softmax over the six family bests. Cosine scores between these templates sit within a narrow
  // band, so a small temperature is what turns "0.91 vs 0.89" into a usable preference while still
  // reporting genuine ambiguity through the entropy term.
  function modality(frame, tonalFocus) {
    const scores = templateScores(frame);
    const names = Object.keys(scores);
    const values = names.map(name => scores[name].score);
    const peak = Math.max(...values);
    const weights = values.map(value => Math.exp((value - peak) / 0.02));
    const total = weights.reduce((sum, value) => sum + value, 0);
    const probability = Object.fromEntries(names.map((name, index) => [name, weights[index] / total]));
    let entropy = 0;
    for (const value of Object.values(probability)) if (value > 0) entropy -= value * Math.log(value);
    const modalAmbiguity = clamp(entropy / Math.log(names.length));
    const modalLikelihood = clamp(MODAL_FAMILIES.reduce((sum, name) => sum + probability[name], 0));
    const majorMinorScore = Math.max(scores.major.score, scores.minor.score);
    const majorMinorDeviation = clamp(peak - majorMinorScore > 0 ? (peak - majorMinorScore) * 10 : 0);
    const majorShare = probability.major + probability.lydian + probability.mixolydian;
    const minorShare = probability.minor + probability.dorian + probability.phrygian;
    // How much of a scale is actually present. A single sustained chord gives 3-4 pitch classes,
    // and C-E-G-B fits E minor nearly as well as C major -- template scores can still look sharp
    // there, so sharpness alone would produce a confident answer to a question the signal never
    // asked. Coverage is what separates "this window contains a scale" from "this window contains
    // a chord", and a mode is only named once roughly a diatonic set has been heard.
    const peakEnergy = Math.max(...frame);
    const pitchClassCount = frame.filter(value => value >= peakEnergy * 0.34).length;
    const coverage = clamp(pitchClassCount / 7);
    // Deliberately NOT a mode name. Naming Dorian vs Mixolydian from a folded 12-bin chroma of a
    // full mix is exactly the overreach section 4-2 forbids; the aggregate "modal" is honest.
    const confidence = clamp(clamp(tonalFocus) * 0.45 + (1 - modalAmbiguity) * 0.3 + coverage * 0.25);
    const label = confidence < 0.55 || coverage < 0.7 ? null
      : modalLikelihood > 0.55 && majorMinorDeviation > 0.25 ? "modal"
        : majorShare >= minorShare ? "major" : "minor";
    return {
      modality: label,
      modeConfidence: confidence,
      modalLikelihood,
      modalAmbiguity,
      majorMinorDeviation,
      pitchClassCoverage: coverage,
      pitchClassCount,
      majorMinorLikelihood: { major: clamp(majorShare), minor: clamp(minorShare) },
      templateScores: scores
    };
  }

  const KEYS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

  function attachKey(centroid, tonalFocus, tonality) {
    const scores = tonality.templateScores || {};
    const Mir = typeof MIREngine !== "undefined" ? MIREngine : require("./mirEngine");
    let scale = null, tonic = null, margin = 0;
    if (tonality.modality === "major" && scores.major) {
      scale = "major";
      tonic = scores.major.tonic;
      margin = Math.max(0, scores.major.score - (scores.minor?.score || 0));
    } else if (tonality.modality === "minor" && scores.minor) {
      scale = "minor";
      tonic = scores.minor.tonic;
      margin = Math.max(0, scores.minor.score - (scores.major?.score || 0));
    } else {
      const guess = Mir.estimateKey(centroid, tonalFocus);
      if (guess.uncertain || !guess.key) {
        return {
          tonalCenter: null, keyScale: null, keyPitchClass: null,
          keyConfidence: guess.confidence || 0, keyMargin: guess.margin ?? null, keyUncertain: true
        };
      }
      return {
        tonalCenter: guess.key, keyScale: guess.scale,
        keyPitchClass: Number.isInteger(guess.pitchClass) ? guess.pitchClass : null,
        keyConfidence: guess.confidence, keyMargin: guess.margin ?? null, keyUncertain: false
      };
    }
    const confidence = clamp(clamp(tonalFocus) * 0.45 + margin * 5 + (tonality.modeConfidence || 0) * 0.35);
    if (!(confidence >= 0.42) || !Number.isInteger(tonic)) {
      return {
        tonalCenter: null, keyScale: null, keyPitchClass: null,
        keyConfidence: confidence, keyMargin: margin, keyUncertain: true
      };
    }
    return {
      tonalCenter: KEYS[tonic], keyScale: scale, keyPitchClass: tonic,
      keyConfidence: confidence, keyMargin: margin, keyUncertain: false
    };
  }

  function nulls(reason) {
    return {
      chordChangeRate: null, harmonicRhythm: null, harmonicStability: null, harmonicRepetition: null,
      harmonicMotionDirection: null, harmonicDensity: null, cadenceStrength: null,
      modality: null, modeConfidence: null, modalLikelihood: null, modalAmbiguity: null,
      majorMinorDeviation: null, majorMinorLikelihood: null,
      tonalCenter: null, keyScale: null, keyPitchClass: null, keyConfidence: null, keyMargin: null,
      keyUncertain: null,
      changeEvents: 0, changesPerBeat: null, sampleCount: 0, confidence: 0, reason
    };
  }

  /**
   * @param chromaFrames  oldest-to-newest 12-bin chroma vectors (Meyda `chroma`).
   * @param frameIntervalMs  spacing between those frames.
   * @param bpm  current tempo estimate; only used to express change rate per beat.
   * @param tonalFocus  0..1 confidence that the signal is pitched at all.
   */
  function analyze({ chromaFrames = [], frameIntervalMs = 100, bpm = 0, tonalFocus = 0 } = {}) {
    const frames = (Array.isArray(chromaFrames) ? chromaFrames : []).filter(usable).map(normalize).filter(Boolean);
    if (frames.length < MIN_FRAMES) return nulls("insufficient-frames");
    if (!finite(tonalFocus) || tonalFocus < MIN_TONAL_FOCUS) return nulls("untonal-signal");
    const interval = finite(frameIntervalMs) && frameIntervalMs > 0 ? frameIntervalMs : 100;

    const distances = frames.slice(1).map((frame, index) => 1 - cosine(frames[index], frame));
    const centre = median(distances);
    const deviation = median(distances.map(value => Math.abs(value - centre)));
    // Adaptive threshold: a harmonic change is a distance that stands out from this window's own
    // frame-to-frame jitter, with an absolute floor so a static pad cannot produce "changes".
    const threshold = Math.max(0.05, centre + Math.max(0.02, deviation * 1.6));
    const debounceFrames = Math.max(1, Math.round(Math.max(160, finite(bpm) && bpm > 0 ? 30000 / bpm : 200) / interval));
    let changeEvents = 0, lastEventIndex = -Infinity;
    const eventIndices = [];
    for (let index = 0; index < distances.length; index++) {
      if (distances[index] < threshold || index - lastEventIndex < debounceFrames) continue;
      changeEvents += 1;
      lastEventIndex = index;
      eventIndices.push(index + 1);
    }

    const windowSeconds = (frames.length - 1) * interval / 1000;
    const changesPerSecond = windowSeconds > 0 ? changeEvents / windowSeconds : 0;
    const changesPerBeat = finite(bpm) && bpm > 0 ? changesPerSecond / (bpm / 60) : null;
    // 2 changes/second is treated as the top of the scale: faster than that, frame-to-frame chroma
    // distance is no longer separating harmony from articulation.
    const chordChangeRate = clamp(changesPerSecond / 2);
    const harmonicRhythm = changesPerBeat === null ? chordChangeRate : clamp(changesPerBeat / 0.75);
    const harmonicStability = clamp(1 - mean(distances) * 3.2);

    // Sequence PERIODICITY, kept deliberately distinct from harmonicStability: a repeating
    // progression is the case where one particular lag matches far better than lags in general.
    // Absolute self-similarity would not work here -- all-positive chroma vectors are similar to
    // each other even when random, and a static pad would score as "repetition" too.
    let harmonicRepetition = null;
    if (frames.length >= 16) {
      const maxLag = Math.min(Math.floor(frames.length / 2), Math.round(8000 / interval));
      const perLag = [];
      for (let lag = 2; lag <= maxLag; lag++) {
        const similarities = [];
        for (let index = lag; index < frames.length; index++) similarities.push(cosine(frames[index - lag], frames[index]));
        perLag.push(mean(similarities));
      }
      if (perLag.length >= 3) {
        const best = Math.max(...perLag);
        harmonicRepetition = clamp((best - mean(perLag)) * 6);
      }
    }

    const centroid = Array.from({ length: 12 }, (_, index) => mean(frames.map(frame => frame[index])));
    const entropies = frames.map(chromaEntropy).filter(finite);
    const harmonicDensity = entropies.length ? clamp(mean(entropies)) : null;
    // Direction of harmonic TENSION, not of pitch: rising pitch-class dispersion means the harmony
    // is opening up/away from its centre, falling means it is closing back onto it. Named this way
    // because a 12-bin folded chroma has no octave, so "upward motion" is not observable.
    const harmonicMotionDirection = entropies.length >= 4 ? trend(entropies) : null;

    // Resolution tendency: after a real harmonic change, does the music land closer to the
    // window's tonal centre than it sat just before? Needs several events to mean anything.
    let cadenceStrength = null;
    if (eventIndices.length >= 3) {
      const returns = [];
      for (const index of eventIndices) {
        if (index < 1 || index >= frames.length) continue;
        const before = cosine(frames[index - 1], centroid);
        const after = cosine(frames[index], centroid);
        if (after > before) returns.push(clamp((after - before) * 4));
      }
      cadenceStrength = returns.length >= 2 ? clamp(mean(returns) * (returns.length / eventIndices.length)) : 0;
    }

    const tonality = modality(centroid, tonalFocus);
    const key = attachKey(centroid, tonalFocus, tonality);
    const confidence = clamp(clamp(tonalFocus) * 0.6 + Math.min(1, frames.length / 48) * 0.4);
    return {
      chordChangeRate, harmonicRhythm, harmonicStability, harmonicRepetition,
      harmonicMotionDirection, harmonicDensity, cadenceStrength,
      modality: tonality.modality, modeConfidence: tonality.modeConfidence,
      modalLikelihood: tonality.modalLikelihood, modalAmbiguity: tonality.modalAmbiguity,
      majorMinorDeviation: tonality.majorMinorDeviation, majorMinorLikelihood: tonality.majorMinorLikelihood,
      pitchClassCoverage: tonality.pitchClassCoverage, pitchClassCount: tonality.pitchClassCount,
      tonalCenter: key.tonalCenter, keyScale: key.keyScale, keyPitchClass: key.keyPitchClass,
      keyConfidence: key.keyConfidence, keyMargin: key.keyMargin, keyUncertain: key.keyUncertain,
      changeEvents, changesPerBeat, sampleCount: frames.length, confidence, reason: "measured"
    };
  }

  return { analyze, modality, chromaEntropy, trend, cosine, TEMPLATES, MIN_FRAMES, MIN_TONAL_FOCUS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HarmonicMotion;
