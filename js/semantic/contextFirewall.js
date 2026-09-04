// Context Firewall: CONTEXT is a historical/cultural claim, so it needs more than genre posterior.
// AESTHETIC associations are not scored here — they use a wider gate in semanticFacets.
const ContextFirewall = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const GENERIC_PATHS = new Set([
    "rhythmicGrammar.fourOnFloor", "moodDimensions.arousal", "moodDimensions.brightness",
    "instrumentationEvidence.synthesizer", "instrumentationEvidence.drums"
  ]);
  const DISTANCE = Object.freeze({
    PRIMARY_GENRE: { minConfidence: 0.55, maxEntropy: 0.92, minMargin: 0.04, minStability: 0.0, minElapsed: 0, minScore: 0.40 },
    PARENT:        { minConfidence: 0.72, maxEntropy: 0.75, minMargin: 0.12, minStability: 0.28, minElapsed: 8, minScore: 0.52 },
    LINEAGE:       { minConfidence: 0.75, maxEntropy: 0.68, minMargin: 0.16, minStability: 0.38, minElapsed: 14, minScore: 0.56 },
    ERA:           { minConfidence: 0.74, maxEntropy: 0.70, minMargin: 0.14, minStability: 0.35, minElapsed: 12, minScore: 0.54 },
    ADJACENCY:     { minConfidence: 0.68, maxEntropy: 0.82, minMargin: 0.08, minStability: 0.22, minElapsed: 8, minScore: 0.46 },
    SCENE:         { minConfidence: 0.78, maxEntropy: 0.55, minMargin: 0.22, minStability: 0.50, minElapsed: 22, minScore: 0.62 },
    CULTURE:       { minConfidence: 0.80, maxEntropy: 0.50, minMargin: 0.24, minStability: 0.55, minElapsed: 26, minScore: 0.66 },
    ARTIST:        { minConfidence: 0.82, maxEntropy: 0.45, minMargin: 0.26, minStability: 0.58, minElapsed: 30, minScore: 0.70 },
    AESTHETIC_ASSOCIATION: { minConfidence: 0.60, maxEntropy: 0.90, minMargin: 0.04, minStability: 0.12, minElapsed: 6, minScore: 0.38 }
  });

  function profile(state = {}) {
    const genre = state.genre || {};
    const top = genre.topK || [];
    const primary = top[0]?.confidence ?? genre.confidence ?? 0;
    // Fixture `secondary` is often a child refinement (Jazz → Hard Bop), not a rival family.
    // Competing mass is only read from a real topK ranking.
    const secondary = top.length >= 2
      ? (top.find(item => item.label !== genre.primary)?.confidence ?? 0)
      : 0;
    const elapsedHint = Number(state.expressionFeatures?.observationSeconds
      ?? state.analysisWindow?.windowSeconds ?? 0) || 0;
    return {
      confidence: clamp(genre.confidence ?? primary),
      entropy: clamp(genre.entropy ?? genre.rawEntropy ?? (genre.uncertain ? 0.9 : 0.4)),
      margin: clamp(genre.margin ?? Math.max(0, primary - secondary)),
      // Missing stability is not "unstable": it is unknown. A long observation window is the
      // honest proxy until the genre tracker has enough ticks to report a real number.
      stability: Number.isFinite(genre.stability)
        ? clamp(genre.stability)
        : (elapsedHint >= 30 ? 0.62 : elapsedHint >= 24 ? 0.55 : elapsedHint >= 12 ? 0.4 : 0.15),
      elapsed: elapsedHint,
      uncertain: Boolean(genre.uncertain)
    };
  }

  function diagnosticity(candidate = {}) {
    const anchors = (candidate.anchors || []).filter(path => path !== "primaryGenre");
    if (!anchors.length) return 0;
    const specific = anchors.filter(path => !GENERIC_PATHS.has(path)).length;
    return clamp(specific / anchors.length * 0.7 + Math.min(1, anchors.length / 3) * 0.3);
  }

  function score(candidate, state = {}) {
    const stats = profile(state);
    const family = String(candidate.relationFamily || "PRIMARY_GENRE").toUpperCase();
    const gate = DISTANCE[family] || DISTANCE.LINEAGE;
    const diagnostic = diagnosticity(candidate);
    const competing = family === "ADJACENCY" ? clamp(0.2 - stats.margin) : clamp(0.12 - stats.margin);
    const contradiction = stats.uncertain ? 0.35 : 0;
    const value = clamp(
      stats.confidence * 0.34 +
      diagnostic * 0.22 +
      stats.stability * 0.16 +
      (1 - stats.entropy) * 0.14 +
      clamp(candidate.relationCompleteness || candidate.relationScore || candidate.confidence || 0) * 0.14
      - competing - contradiction
    );
    const pass = !stats.uncertain
      && stats.confidence >= gate.minConfidence
      && stats.entropy <= gate.maxEntropy
      && stats.margin >= gate.minMargin
      && stats.stability >= gate.minStability
      && stats.elapsed >= gate.minElapsed
      && value >= gate.minScore;
    return { pass, score: value, diagnosticity: diagnostic, family, gate, stats,
      reason: pass ? "admitted" : stats.uncertain ? "genre-uncertain"
        : stats.entropy > gate.maxEntropy ? "genre-entropy-high"
          : stats.margin < gate.minMargin ? "genre-margin-low"
            : stats.elapsed < gate.minElapsed ? "context-not-yet-stable"
              : stats.stability < gate.minStability ? "context-unstable"
                : "context-score-low" };
  }

  function admit(evidence = {}, state = {}) {
    const candidates = [];
    const rejected = [];
    for (const candidate of evidence.candidates || []) {
      const family = String(candidate.relationFamily || "").toUpperCase();
      if (family === "AESTHETIC_ASSOCIATION" || family === "PRIMARY_GENRE" || !family) {
        candidates.push(candidate);
        continue;
      }
      const verdict = score(candidate, state);
      if (verdict.pass) candidates.push({ ...candidate, contextScore: verdict.score,
        contextDiagnosticity: verdict.diagnosticity, contextGate: verdict.reason });
      else rejected.push({ text: candidate.text, family, reason: verdict.reason, contextScore: verdict.score });
    }
    return { ...evidence, candidates, rejected, contextProfile: profile(state) };
  }

  return { DISTANCE, profile, diagnosticity, score, admit };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ContextFirewall;
