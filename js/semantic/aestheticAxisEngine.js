// Continuous aesthetic axis vector, replacing the old discrete kawaii/y2k-style if-ladders.
// A handful of hardcoded genre-name arrays cannot scale to "reveal genre aesthetic identity
// through words" -- vocabulary needs to grow via data (data/aestheticRegions.json), and the
// axes it keys off need to vary smoothly with the actual evidence (data/aestheticAxes.json),
// not flip between two fixed values at a threshold. Each axis is a weighted combination of
// ALREADY-measured signals only -- this engine invents no new detectors.
const AestheticAxisEngine = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = Facets.clamp;

  // Section 5: a coarse, deterministic fingerprint of "which axis territory is the track in right
  // now" -- three bands per axis (same low/mid/high bucketing languageDiversityMetrics.js's
  // axisCoverage() uses), sorted by axis name so equal axis states always produce the identical
  // string. Deliberately coarser than a full snapshot fingerprint: the runtime LLM call gate
  // (phrasePoolEngine.js) uses this to recognize "we've already been in roughly this aesthetic
  // territory recently" even when the exact measured values drift slightly, so a real re-entry
  // into the same territory can reuse cached local coverage instead of re-triggering a call.
  function axisSignature(axes = {}, bins = 3) {
    return Object.keys(axes).sort().map(name => {
      const value = axes[name];
      if (typeof value !== "number" || !Number.isFinite(value)) return `${name}:null`;
      return `${name}:${Math.min(bins - 1, Math.floor(clamp(value) * bins))}`;
    }).join("|");
  }

  function genreLabels(genre = {}) {
    // fineCandidates is now taxonomy-only (GenreHypotheses' explicit hierarchy children);
    // relatedCandidates is the broader neighborhood-search alternatives list that used to share
    // this field. Both are genuine genre-label sources for prior matching, so both are read.
    return [genre.primary, genre.family, ...(genre.secondary || []).map(x => x?.label),
      ...(genre.fineCandidates || []).map(x => (typeof x === "string" ? x : x?.label)),
      ...(genre.relatedCandidates || []).map(x => (typeof x === "string" ? x : x?.label))]
      .filter(Boolean).map(x => String(x).toLowerCase());
  }

  // A genre NOT in this axis's prior table is not "this style scores 0 on this axis" -- the
  // table only lists genres someone actually researched a prior for. An unmatched genre means
  // "no prior information for this genre on this axis", which is the textbook definition of an
  // unmeasurable value: null, never 0 (project rule 1). Filling it with 0 silently caps every
  // untabled genre's weighted average below what the genre-prior weight alone can reach (e.g.
  // nostalgia's 0.40 genre-prior weight structurally capped the whole axis at 0.60 for any of the
  // ~ Discogs 400 genres outside its 8-entry prior table -- worse than genre being unconfirmed,
  // which lets the same axis reach 1.0 from measured signal alone). Only a genuinely unresolved/
  // uncertain genre makes the component unavailable in that OTHER sense; both cases now resolve
  // to the same outcome -- null, excluded from the weighted average -- which is the correct fix,
  // not a coincidence: "genre known but untabled" and "genre unknown" are both "no prior here".
  function genrePriorResult(priors, genre) {
    if (!genre || genre.uncertain || !genre.primary) return { value: null, matched: false };
    const labels = genreLabels(genre);
    const matchKey = Object.keys(priors || {}).find(name => labels.some(label => label.includes(name.toLowerCase())));
    return { value: matchKey ? priors[matchKey] : null, matched: Boolean(matchKey) };
  }

  class Engine {
    constructor(axesData = {}, _unusedRegionsData = {}, { historyWindowMs = 20000 } = {}) {
      this.axes = axesData?.axes || {};
      // No region vocabulary: this engine measures axes, it does not name them.
      this.regions = [];
      // Trajectory memory: a short rolling history of past axis vectors, so evaluate() can also
      // report how each axis has moved over the trailing window ("nostalgia is deepening"), not
      // just where it currently sits. Bounded by both age and count so a long session never grows
      // this unboundedly.
      this.historyWindowMs = historyWindowMs;
      this.history = [];
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

    // matchRegions() lived here, turning the measured axis vector into words by looking the
    // combination up in data/aestheticRegions.json -- 27 hand-authored Korean phrases. The axes
    // themselves are real local measurement and stay; the NAMING is what has been removed, for
    // the same reason the hardcoded genre rules were. AESTHETIC and IMPRESSION belong to Music
    // Flamingo's direct listening, so a phrase reaches the screen because a listener said it,
    // never because a feature vector cleared thresholds someone wrote down in advance.


    // Compares the current axis vector against the OLDEST sample still inside historyWindowMs,
    // so "delta" means "change over roughly the trailing window", not frame-to-frame jitter. If
    // the poll rate is coarser than the window (or history is still short), no sample is that
    // recent-yet-old-enough -- fall back to the single most recent prior sample instead, since
    // that is always the closest available approximation, whether we have too little history
    // (bootstrapping) or the window is simply narrower than the polling interval. Both delta and
    // direction stay null wherever either side is null -- a missing baseline must never be
    // treated as 0 movement.
    trajectory(axes, at = Date.now()) {
      const cutoff = at - this.historyWindowMs;
      const baseline = this.history.find(entry => entry.at >= cutoff) || this.history.at(-1) || null;
      const delta = {};
      const direction = {};
      for (const name of Object.keys(this.axes)) {
        const current = axes[name];
        const previous = baseline ? baseline.axes[name] : null;
        if (typeof current !== "number" || typeof previous !== "number") {
          delta[name] = null;
          direction[name] = null;
          continue;
        }
        // Both sides are already clamped to [0, 1], so the difference is naturally in [-1, 1] --
        // no further clamping needed.
        const change = current - previous;
        delta[name] = change;
        direction[name] = Math.abs(change) < 0.05 ? "stable" : change > 0 ? "rising" : "falling";
      }
      return { delta, direction };
    }

    recordHistory(axes, at = Date.now()) {
      this.history.push({ at, axes });
      // Bounded by age (generously, so an unusually slow poll rate still finds a baseline) AND by
      // count, so a long session's history array never grows without limit.
      const cutoff = at - this.historyWindowMs * 6;
      this.history = this.history.filter(entry => entry.at >= cutoff).slice(-64);
    }

    evaluate(state = {}, genre = {}, at = Date.now()) {
      const { axes, contributingPaths, genreMatch } = this.evaluateAxes(state, genre);
      const { delta, direction } = this.trajectory(axes, at);
      this.recordHistory(axes, at);
      // No candidates: the axis vector is evidence, not vocabulary. phrasePoolEngine's LLM gate
      // and the replay reporting both read `axes`/`axisSignature`, which are unaffected.
      return { axes, contributingPaths, genreMatch, delta, direction, candidates: [],
        axisSignature: axisSignature(axes) };
    }
  }

  return { Engine, genrePriorResult, axisSignature };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AestheticAxisEngine;
