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
    constructor(axesData = {}, regionsData = {}, { historyWindowMs = 20000 } = {}) {
      this.axes = axesData?.axes || {};
      this.regions = Array.isArray(regionsData?.entries) ? regionsData.entries : [];
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

    // Vocabulary is data (data/aestheticRegions.json): each region names the axis combination it
    // speaks for, so adding a new word never requires touching this code. A region MAY also
    // require a `direction` ("rising"/"falling"/"stable") on one of its axes -- e.g. a
    // "nostalgia is deepening" phrase -- which is matched against the `direction` map from
    // trajectory() below; regions with no `direction` field are unaffected and work exactly as
    // before (value-only).
    // Section 4: the open layer is axis-based, not genre-based -- confidence here comes primarily
    // from HOW WELL the measured axes clear their thresholds (averageMargin), never gated by
    // genre confidence the way rule/relation candidates are. A confidently-known genre adds only
    // a small bonus on top; an unconfirmed or uncertain genre must still let a strongly-evidenced
    // region speak ("장르를 몰라도 인상 어휘는 나와야 한다").
    matchRegions(axes, contributingPaths, genre = {}, direction = {}) {
      const genreConfidence = genre?.uncertain ? 0 : (genre?.confidence ?? 0);
      const genreBonus = genreConfidence >= 0.5 ? Math.min(0.15, (genreConfidence - 0.5) * 0.3) : 0;
      const candidates = [];
      for (const region of this.regions) {
        const requires = region.requires || [];
        if (!requires.length || !Facets.safeText(region.text, region.category)) continue;
        const satisfied = requires.filter(req => {
          const value = axes[req.axis];
          if (typeof value !== "number" || value < (req.min ?? 0) || value > (req.max ?? 1)) return false;
          if (req.direction && direction[req.axis] !== req.direction) return false;
          return true;
        });
        const minAxes = Number.isFinite(region.minAxes) ? region.minAxes : requires.length;
        if (satisfied.length < minAxes) continue;
        const margins = satisfied.map(req => {
          const min = req.min ?? 0, max = req.max ?? 1;
          return clamp((axes[req.axis] - min) / Math.max(0.001, max - min));
        });
        const averageMargin = margins.reduce((sum, x) => sum + x, 0) / margins.length;
        // Selectivity is an explicit, genre-independent gate on the margin itself (not folded
        // into the confidence formula) -- a region barely clearing its min thresholds should not
        // speak just because genre happens to be confident. This keeps candidate volume in check
        // regardless of how the (separate) genre bonus below is tuned.
        if (averageMargin < 0.35) continue;
        const confidence = Math.min(0.84, clamp(0.4 + averageMargin * 0.4 + genreBonus));
        if (confidence < 0.45) continue;
        const anchorPaths = [...new Set(satisfied.flatMap(req => contributingPaths[req.axis] || []))];
        candidates.push(Facets.token(region.text, region.category, confidence,
          ["primaryGenre", ...anchorPaths].slice(0, 6),
          { source: "aesthetic-axis", kind: "aesthetic", relationFamily: "AESTHETIC_ASSOCIATION",
            relationScore: confidence, axes: satisfied.map(req => req.axis) }));
      }
      return candidates.slice(0, 14);
    }

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
      const candidates = this.matchRegions(axes, contributingPaths, genre, direction);
      return { axes, contributingPaths, genreMatch, delta, direction, candidates, axisSignature: axisSignature(axes) };
    }
  }

  return { Engine, genrePriorResult, axisSignature };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AestheticAxisEngine;
