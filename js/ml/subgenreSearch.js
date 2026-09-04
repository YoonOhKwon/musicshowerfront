const SubgenreSearch = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const normalize = value => String(value || "").toLowerCase();

  class Searcher {
    constructor(neighborhoods = {}) {
      this.neighborhoods = neighborhoods;
    }

    search({ topK = [], character = {}, limit = 6 } = {}) {
      const labels = new Map(topK.map(item => [normalize(item.label), Number(item.confidence) || 0]));
      const rhythm = character.rhythm || {};
      const actual = {
        breakbeat: clamp(rhythm.breakbeatLikelihood),
        regularity: clamp(rhythm.pulseRegularity),
        speed: clamp(((rhythm.bpm || 90) - 65) / 130),
        roughness: clamp(character.timbre?.roughness),
        space: clamp(character.space?.spaciousness)
      };
      const output = new Map();
      for (const [neighborhood, definition] of Object.entries(this.neighborhoods)) {
        const triggerScore = Math.max(0, ...(definition.triggers || []).map(label => labels.get(normalize(label)) || 0));
        if (!triggerScore) continue;
        const cues = definition.character || {};
        const cueKeys = Object.keys(cues);
        const characterFit = cueKeys.length
          ? 1 - cueKeys.reduce((sum, key) => sum + Math.abs(actual[key] - cues[key]), 0) / cueKeys.length
          : 0.5;
        for (const candidate of definition.candidates || []) {
          const baseEvidence = labels.get(normalize(candidate)) || 0;
          const score = clamp(triggerScore * 2.8 + baseEvidence * 2.2 + characterFit * 0.28);
          const previous = output.get(candidate);
          if (!previous || score > previous.score) {
            output.set(candidate, { label: candidate, score, neighborhood, source: "coarse-to-fine" });
          }
        }
      }
      return [...output.values()].sort((left, right) => right.score - left.score).slice(0, limit);
    }
  }

  return { Searcher };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SubgenreSearch;
