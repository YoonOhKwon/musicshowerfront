// Continuous aesthetic axis vector, replacing the old discrete kawaii/y2k-style if-ladders.
// A handful of hardcoded genre-name arrays cannot scale to "reveal genre aesthetic identity
// through words" -- vocabulary needs to grow via data (data/aestheticRegions.json), and the
// axes it keys off need to vary smoothly with the actual evidence (data/aestheticAxes.json),
// not flip between two fixed values at a threshold. Each axis is a weighted combination of
// ALREADY-measured signals only -- this engine invents no new detectors.
const AestheticAxisEngine = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = Facets.clamp;

  function genreLabels(genre = {}) {
    return [genre.primary, genre.family, ...(genre.secondary || []).map(x => x?.label),
      ...(genre.fineCandidates || []).map(x => (typeof x === "string" ? x : x?.label))]
      .filter(Boolean).map(x => String(x).toLowerCase());
  }

  // A genre-prior component is never "missing evidence" once genre itself is known -- an
  // unmatched genre is a real answer (this style has no prior on this axis), so it resolves to
  // 0, not null. Only a genuinely unresolved/uncertain genre makes the component unavailable.
  function genrePriorResult(priors, genre) {
    if (!genre || genre.uncertain || !genre.primary) return { value: null, matched: false };
    const labels = genreLabels(genre);
    const matchKey = Object.keys(priors || {}).find(name => labels.some(label => label.includes(name.toLowerCase())));
    return { value: matchKey ? priors[matchKey] : 0, matched: Boolean(matchKey) };
  }

  class Engine {
    constructor(axesData = {}, regionsData = {}) {
      this.axes = axesData?.axes || {};
      this.regions = Array.isArray(regionsData?.entries) ? regionsData.entries : [];
    }

    // Returns, per declared axis: a 0-1 value (or null if EVERY contributing signal is
    // unavailable -- never 0-filled), the raw paths that actually contributed (future anchors),
    // and whether a genre-prior component for that axis actually matched a known label (used by
    // callers, e.g. aestheticEvidenceEngine.js, that still need genre grounding before speaking).
    evaluateAxes(state = {}, genre = {}) {
      const axes = {};
      const contributingPaths = {};
      const genreMatch = {};
      for (const [name, def] of Object.entries(this.axes)) {
        let weightedSum = 0;
        let weightTotal = 0;
        let measuredWeightTotal = 0;
        const paths = [];
        let matched = false;
        for (const component of def.components || []) {
          let value = null;
          if (typeof component.path === "string") value = Facets.read(state, component.path);
          else if (component.genrePriors) {
            const result = genrePriorResult(component.genrePriors, genre);
            value = result.value;
            if (result.matched) matched = true;
          }
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
          if (component.invert) value = 1 - value;
          const weight = Number.isFinite(component.weight) ? component.weight : 0;
          weightedSum += value * weight;
          weightTotal += weight;
          if (component.path) measuredWeightTotal += weight;
          paths.push(component.path || "genre.primary");
        }
        // A genre label alone is never grounding: at least one REAL measured signal must
        // contribute, or the axis stays null. Otherwise a confidently-known genre with zero
        // acoustic evidence could still produce a number -- exactly the "fill unmeasured audio
        // characteristics from genre stereotypes" failure the project rules forbid.
        axes[name] = weightTotal > 0 && measuredWeightTotal > 0 ? clamp(weightedSum / weightTotal) : null;
        contributingPaths[name] = [...new Set(paths)];
        genreMatch[name] = matched;
      }
      return { axes, contributingPaths, genreMatch };
    }

    // Vocabulary is data (data/aestheticRegions.json): each region names the axis combination it
    // speaks for, so adding a new word never requires touching this code.
    matchRegions(axes, contributingPaths, genreConfidence) {
      const candidates = [];
      for (const region of this.regions) {
        const requires = region.requires || [];
        if (!requires.length || !Facets.safeText(region.text, region.category)) continue;
        const satisfied = requires.filter(req => {
          const value = axes[req.axis];
          return typeof value === "number" && value >= (req.min ?? 0) && value <= (req.max ?? 1);
        });
        const minAxes = Number.isFinite(region.minAxes) ? region.minAxes : requires.length;
        if (satisfied.length < minAxes) continue;
        const margins = satisfied.map(req => {
          const min = req.min ?? 0, max = req.max ?? 1;
          return clamp((axes[req.axis] - min) / Math.max(0.001, max - min));
        });
        const averageMargin = margins.reduce((sum, x) => sum + x, 0) / margins.length;
        const confidence = Math.min(0.84, clamp((genreConfidence ?? 0.6) * (0.6 + averageMargin * 0.24)));
        if (confidence < 0.45) continue;
        const anchorPaths = [...new Set(satisfied.flatMap(req => contributingPaths[req.axis] || []))];
        candidates.push(Facets.token(region.text, region.category, confidence,
          ["primaryGenre", ...anchorPaths].slice(0, 6),
          { source: "aesthetic-axis", kind: "aesthetic", relationFamily: "AESTHETIC_ASSOCIATION",
            relationScore: confidence, axes: satisfied.map(req => req.axis) }));
      }
      return candidates.slice(0, 14);
    }

    evaluate(state = {}, genre = {}) {
      const { axes, contributingPaths, genreMatch } = this.evaluateAxes(state, genre);
      const candidates = this.matchRegions(axes, contributingPaths, genre.confidence);
      return { axes, contributingPaths, genreMatch, candidates };
    }
  }

  return { Engine, genrePriorResult };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AestheticAxisEngine;
