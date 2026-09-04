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

  function estimateKey(chroma = [], tonalFocus = 0) {
    if (chroma.length !== 12 || !chroma.every(Number.isFinite) || tonalFocus < 0.16) {
      return { key: null, scale: null, confidence: 0, method: "chroma-template", uncertain: true };
    }
    const scores = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      scores.push({ key: KEYS[tonic], scale: "major", score: cosine(chroma, rotate(MAJOR, tonic)) });
      scores.push({ key: KEYS[tonic], scale: "minor", score: cosine(chroma, rotate(MINOR, tonic)) });
    }
    scores.sort((a, b) => b.score - a.score);
    const margin = Math.max(0, scores[0].score - scores[1].score);
    const confidence = clamp(tonalFocus * 0.65 + margin * 3.5);
    return { ...scores[0], confidence, margin, method: "chroma-template", uncertain: confidence < 0.42 };
  }

  class Engine {
    constructor({ historyMs = 5000 } = {}) { this.historyMs = historyMs; this.reset(); }
    reset() { this.observations = []; this.current = null; }
    update({ bpm = 0, beatConfidence = 0, chroma = [], tonalFocus = 0, rhythmicGrammar = {} } = {}, at = Date.now()) {
      this.observations = this.observations.filter(item => at - item.at <= this.historyMs);
      this.observations.push({ at, bpm: Number(bpm) || 0, confidence: clamp(beatConfidence) });
      const trusted = this.observations.filter(item => item.bpm >= 50 && item.confidence >= 0.45);
      const bpmValues = trusted.map(item => item.bpm);
      const bpmMean = mean(bpmValues);
      const deviation = Math.sqrt(mean(bpmValues.map(value => (value - bpmMean) ** 2)));
      const stability = bpmValues.length >= 2 ? clamp(1 - deviation / Math.max(1, bpmMean * 0.08)) : 0;
      this.current = {
        resolution: "musical",
        windowMs: this.historyMs,
        tempo: { bpm: bpmMean || Number(bpm) || 0, confidence: clamp(mean(trusted.map(x => x.confidence)) * (0.65 + stability * 0.35)), stability },
        tonal: estimateKey(chroma, tonalFocus),
        chroma: { vector: chroma.slice(0, 12), confidence: clamp(tonalFocus) },
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
  return { Engine, estimateKey };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MIREngine;
