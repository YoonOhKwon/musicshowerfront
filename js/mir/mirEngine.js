const MIREngine = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const KEYS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function cosine(left, right) {
    let dot = 0, aa = 0, bb = 0;
    for (let index = 0; index < 12; index++) {
      dot += left[index] * right[index]; aa += left[index] ** 2; bb += right[index] ** 2;
    }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }

  function rotate(profile, tonic) {
    return Array.from({ length: 12 }, (_, index) => profile[(index - tonic + 12) % 12]);
  }

  function usableChroma(chroma) {
    return Array.isArray(chroma) && chroma.length === 12 && chroma.every(Number.isFinite) && chroma.some(value => value > 0);
  }

  function meanChroma(frames) {
    if (!frames.length) return [];
    const vector = Array.from({ length: 12 }, (_, index) => mean(frames.map(frame => frame[index])));
    const total = vector.reduce((sum, value) => sum + Math.max(0, value), 0);
    return total > 0 ? vector.map(value => Math.max(0, value) / total) : vector;
  }

  function estimateKey(chroma = [], tonalFocus = 0) {
    if (!usableChroma(chroma) || tonalFocus < 0.16) {
      return { key: null, scale: null, pitchClass: null, confidence: 0, method: "chroma-template", uncertain: true };
    }
    const scores = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      scores.push({ key: KEYS[tonic], scale: "major", score: cosine(chroma, rotate(MAJOR, tonic)), pitchClass: tonic });
      scores.push({ key: KEYS[tonic], scale: "minor", score: cosine(chroma, rotate(MINOR, tonic)), pitchClass: tonic });
    }
    scores.sort((a, b) => b.score - a.score);
    const margin = Math.max(0, scores[0].score - scores[1].score);
    const confidence = clamp(tonalFocus * 0.65 + margin * 3.5);
    return { ...scores[0], confidence, margin, method: "chroma-template", uncertain: confidence < 0.42 };
  }

  class Engine {
    constructor({ historyMs = 5000 } = {}) { this.historyMs = historyMs; this.reset(); }
    reset() { this.observations = []; this.chromaFrames = []; this.current = null; }
    update({ bpm = 0, beatConfidence = 0, chroma = [], harmonicChroma = null, tonalFocus = 0, rhythmicGrammar = {} } = {}, at = Date.now()) {
      this.observations = this.observations.filter(item => at - item.at <= this.historyMs);
      this.chromaFrames = this.chromaFrames.filter(item => at - item.at <= this.historyMs);
      this.observations.push({ at, bpm: Number(bpm) || 0, confidence: clamp(beatConfidence) });
      const chosen = usableChroma(harmonicChroma) ? harmonicChroma : chroma;
      if (usableChroma(chosen)) this.chromaFrames.push({ at, chroma: chosen.slice(0, 12) });
      const trusted = this.observations.filter(item => item.bpm >= 50 && item.confidence >= 0.45);
      const bpmValues = trusted.map(item => item.bpm);
      const bpmMean = mean(bpmValues);
      const deviation = Math.sqrt(mean(bpmValues.map(value => (value - bpmMean) ** 2)));
      const stability = bpmValues.length >= 2 ? clamp(1 - deviation / Math.max(1, bpmMean * 0.08)) : 0;
      const keyChroma = this.chromaFrames.length >= 4 ? meanChroma(this.chromaFrames.map(item => item.chroma)) : chosen;
      this.current = {
        resolution: "musical",
        windowMs: this.historyMs,
        tempo: { bpm: bpmMean || Number(bpm) || 0, confidence: clamp(mean(trusted.map(x => x.confidence)) * (0.65 + stability * 0.35)), stability },
        tonal: estimateKey(keyChroma, tonalFocus),
        chroma: { vector: (usableChroma(chosen) ? chosen : chroma).slice(0, 12), confidence: clamp(tonalFocus),
          source: usableChroma(harmonicChroma) ? "hpss-harmonic" : "meyda" },
        rhythm: {
          fourOnFloor: rhythmicGrammar.fourOnFloor ?? null,
          swing: rhythmicGrammar.swing ?? null,
          syncopation: rhythmicGrammar.syncopation ?? null,
          brokenBeat: rhythmicGrammar.brokenBeat ?? null,
          confidence: rhythmicGrammar.confidence || 0
        },
        sources: ["Meyda chroma", "beat/onset history", "rhythm grammar"],
        essentiaFrontend: "MusiCNN mel extraction runs in the ML worker",
        updatedAt: at
      };
      return this.current;
    }
  }
  return { Engine, estimateKey, KEYS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MIREngine;
