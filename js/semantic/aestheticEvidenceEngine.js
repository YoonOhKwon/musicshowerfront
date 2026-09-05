// Evidence-gated aesthetic association scores (kawaii/magical-girl/anime/y2k) -- the legacy
// 4-label contract that data/genreContextKnowledge.json's own candidate rules still read as
// state.aestheticEvidence.{kawaii,magicalGirl,anime,y2k}. Previously these were a hardcoded
// genre-name-list + threshold ladder (KAWAII_ADJACENT/Y2K_ADJACENT); that couldn't scale and
// produced the same wording for every track that cleared the same fixed bar. They are now
// derived from AestheticAxisEngine's continuous glossiness/artificiality/drive/syncopation axes (see
// aestheticAxisEngine.js, data/aestheticAxes.json) so the SCORE varies smoothly with the actual
// evidence -- a genre-prior match on the contributing axis is still required (never let raw
// brightness/production alone impersonate a scene-specific label; see round-19 requiredContext
// gating for the same anti-leakage principle applied to idioms). genreContextEngine.js reads
// this output; before this engine existed, state.aestheticEvidence was never written and those
// gates could never pass.
const AestheticEvidence = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const clamp = Facets.clamp;

  class Engine {
    constructor(axisEngine = null) { this.axisEngine = axisEngine; }

    evaluate(state = {}) {
      const result = { kawaii: null, magicalGirl: null, anime: null, y2k: null };
      const genre = state.genre || {};
      if (genre.uncertain || !(genre.confidence >= 0.5) || !this.axisEngine) return result;
      const mood = state.moodDimensions || {};
      const instruments = state.instrumentationEvidence || {};
      const brightness = mood.brightness;
      const { axes, genreMatch } = this.axisEngine.evaluateAxes(state, genre);

      if (axes.glossiness !== null && axes.artificiality !== null && (genreMatch.glossiness || genreMatch.artificiality)) {
        const kawaii = clamp(axes.glossiness * 0.55 + axes.artificiality * 0.45);
        if (kawaii >= 0.55) result.kawaii = kawaii;
      }

      if (result.kawaii !== null && Number.isFinite(instruments.strings) && instruments.strings >= 0.35 &&
          Number.isFinite(brightness) && brightness >= 0.68) {
        result.magicalGirl = clamp(result.kawaii * 0.6 + instruments.strings * 0.2 + brightness * 0.2);
      }

      // STEP 2 (aestheticAxisEngine.js): the old combined "motion" axis was split into drive
      // (steady propulsion: eurodance/trance/electroclash/y2k priors) and syncopation (2-step
      // displacement: uk garage/2-step/speed garage/garage house priors) -- both halves of the
      // original Y2K-club-era lineage this legacy score names, so either genre-prior match still
      // licenses it, using whichever of the two axes actually resolved and matched.
      const motionAxis = genreMatch.drive && axes.drive !== null ? axes.drive
        : genreMatch.syncopation && axes.syncopation !== null ? axes.syncopation : null;
      if (motionAxis !== null && Number.isFinite(brightness)) {
        const y2k = clamp(motionAxis * 0.7 + brightness * 0.3);
        if (y2k >= 0.5) result.y2k = y2k;
      }

      if (result.magicalGirl !== null && result.magicalGirl >= 0.6) result.anime = result.magicalGirl;
      else if (result.kawaii !== null && result.kawaii >= 0.68) result.anime = clamp(result.kawaii * 0.9);

      return result;
    }
  }
  return { Engine };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AestheticEvidence;
