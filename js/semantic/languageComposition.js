// Slow-tick composition: claims, composed FACT and LIVE events. AESTHETIC/IMPRESSION
// are intentionally absent: their semantic source is Music Flamingo, not local rules.
const LanguageComposition = (() => {
  const Claims = typeof VerifiedClaims !== "undefined" ? VerifiedClaims : require("./verifiedClaimStore");
  const Firewall = typeof ContextFirewall !== "undefined" ? ContextFirewall : require("./contextFirewall");
  const Facts = typeof FactComposer !== "undefined" ? FactComposer : require("./factComposer");
  const Live = typeof LiveEventGrammar !== "undefined" ? LiveEventGrammar : require("./liveEventGrammar");
  const Lexicon = typeof ContextLexicalExpansion !== "undefined" ? ContextLexicalExpansion : require("./contextLexicalExpansion");
  const Surface = typeof LocalSurfaceRealizer !== "undefined" ? LocalSurfaceRealizer : require("./localSurfaceRealizer");

  function apply(state = {}) {
    state.verifiedClaims = Claims.collect(state);
    if (state.genreContextEvidence?.candidates) {
      state.genreContextEvidence = Firewall.admit(state.genreContextEvidence, state);
      state.genreContextEvidence.candidates = Lexicon.expand(state.genreContextEvidence.candidates, state);
      state.verifiedClaims = Claims.collect(state);
    }
    state.composedFactCandidates = Facts.compose(state);
    if (state.detectedIdioms) {
      state.detectedIdioms = Surface.applyToItems(state.detectedIdioms, { claims: state.verifiedClaims });
    }
    state.liveEventCandidates = Live.realize(state);
    state.aestheticConceptCandidates = [];
    state.languagePlan = plan(state);
    return state;
  }

  // Local composition planner: choose claim combinations. The remote LLM only realizes text.
  function plan(state = {}) {
    const items = state.verifiedClaims?.items || [];
    const distinctive = (state.distinctive?.statements || []).slice(0, 6);
    const compositions = [];
    const byType = type => items.filter(item => item.type === type).sort((a, b) => b.confidence - a.confidence);
    const facts = [...byType("MUSICAL_FACT"), ...byType("PRODUCTION_FACT"), ...byType("ACOUSTIC_FACT")];
    // FACT combinations may be exposed to a future external impression interpreter, but the
    // local planner must not decide what they feel like or which aesthetic they imply.
    const contrast = [items.find(item => item.concept === "bright_timbre"),
      items.find(item => item.concept === "dark_timbre" || item.concept === "sparse_texture")]
      .filter(Boolean);
    if (contrast.length === 2)
      compositions.push({ claims: contrast.map(item => item.id), operator: "CONTRAST", targetLayer: "FACT" });
    return {
      compositions: compositions.slice(0, 4),
      distinctive,
      capsule: state.verifiedClaims?.capsule || null,
      contextRejected: state.genreContextEvidence?.rejected || []
    };
  }

  return { apply, plan };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LanguageComposition;
