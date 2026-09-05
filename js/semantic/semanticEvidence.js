const SemanticEvidence = (() => {
  const numeric = (input = {}, fields = []) => Object.fromEntries(fields.map(key =>
    [key, typeof input?.[key] === "number" && Number.isFinite(input[key]) ? input[key] : null]));
  const optionalNumeric = (input = {}, fields = []) => Object.fromEntries(fields
    .filter(key => typeof input?.[key] === "number" && Number.isFinite(input[key]))
    .map(key => [key, input[key]]));
  const text = (value, length = 60) => typeof value === "string" ? value.slice(0, length) : null;
  const clamp = x => Math.max(0, Math.min(1, Number(x) || 0));
  function sanitize(source = {}) {
    const observed = (Array.isArray(source.instrumentation?.observed) ? source.instrumentation.observed : []).slice(0, 8)
      .filter(x => x && typeof x.label === "string").map(x => ({
        id: text(x.id), label: text(x.label), confidence: clamp(x.confidence),
        dominance: clamp(x.dominance), source: text(x.source, 30)
      }));
    const instruments = observed.map(x => ({ label: x.label, confidence: x.confidence, source: x.source }));
    const events = (Array.isArray(source.instrumentEvents) ? source.instrumentEvents : []).slice(-12)
      .filter(x => x && typeof x.text === "string").map(x => ({ text: text(x.text), instrument: text(x.instrument),
        kind: text(x.kind, 20), confidence: clamp(x.confidence), at: Number.isFinite(x.at) ? x.at : null }));
    const instrumentEvidence = Object.fromEntries(Object.entries(source.instrumentationEvidence || {}).slice(0, 24)
      .filter(([key, value]) => /^[a-z0-9_]{1,40}$/.test(key) && typeof value === "number" && Number.isFinite(value))
      .map(([key, value]) => [key, clamp(value)]));
    const families = Object.fromEntries(Object.entries(source.instrumentation?.families || {}).slice(0, 12)
      .filter(([key, value]) => /^[a-z]{2,20}$/.test(key) && Number.isFinite(value?.confidence))
      .map(([key, value]) => [key, { confidence: clamp(value.confidence), melodic: Boolean(value.melodic) }]));
    const context = source.genreContextEvidence || {};
    const relationSource = Array.isArray(context.candidates) ? context.candidates : Array.isArray(context.relations) ? context.relations : [];
    const relations = relationSource.slice(0, 8).filter(item => item && typeof item.text === "string").map(item => ({
      text: text(item.text), category: text(item.category, 20), layer: text(item.layer, 20),
      relationFamily: text(item.relationFamily, 28), relationScore: clamp(item.relationScore ?? item.confidence),
      source: text(item.source, 30)
    }));
    return {
      instruments, instrumentation: { observed, families, dominanceDispersion: Number.isFinite(source.instrumentation?.dominanceDispersion)
          ? clamp(source.instrumentation.dominanceDispersion) : null,
        leadTransitionRate: Number.isFinite(source.instrumentation?.leadTransitionRate) ? source.instrumentation.leadTransitionRate : null,
        confidence: clamp(source.instrumentation?.confidence),
        resolution: "broad model classes; no source separation" },
      instrumentationEvidence: instrumentEvidence, instrumentEvents: events,
      performance: { ...numeric(source.performance, ["soloLikelihood", "walkingBassLikelihood", "melodicActivity",
        "pitchActivity", "onsetActivity", "dominanceChange", "accompanimentDelta", "leadLikelihood", "foregroundLikelihood"]),
        soloInstrument: text(source.performance?.soloInstrument), leadInstrument: text(source.performance?.leadInstrument),
        foregroundInstrument: text(source.performance?.foregroundInstrument), bassFunction: text(source.performance?.bassFunction, 20) },
      arrangement: { ...numeric(source.arrangement, ["density", "accompanimentDelta", "verifiedEnsembleSize"]),
        dominantRole: text(source.arrangement?.dominantRole) },
      rhythmicGrammar: numeric(source.rhythmicGrammar, ["confidence", "onsetCount", "fourOnFloor", "swing", "syncopation", "brokenBeat",
        "subdivisionRatio", "accentPeriodicity", "accentPeriodicityConfidence", "accentPlacement", "halfTimeLikelihood", "doubleTimeLikelihood"]),
      rhythmGrammarDiagnostics: optionalNumeric(source.rhythmicGrammar,
        ["beatGridConfidence", "kickOccupancy", "kickRegularity", "backbeat", "offbeatRate"]),
      productionEvidence: { ...numeric(source.productionEvidence, ["filterSweep", "pumping", "sidechain", "sampleBased", "vocalChop",
        "stereoWidth", "reverb", "distortion"]), sourceSeparation: false },
      genreContextEvidence: { genre: text(context.genre), confidence: clamp(context.confidence),
        basis: "style association, not origin or identification",
        matchedPriors: (Array.isArray(context.matchedPriors) ? context.matchedPriors : []).filter(x => typeof x === "string").slice(0, 8).map(x => x.slice(0, 60)),
        aestheticEvidence: numeric(context.aestheticEvidence, ["magicalGirl", "kawaii", "anime", "y2k"]), relations }
    };
  }
  return { sanitize };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SemanticEvidence;
