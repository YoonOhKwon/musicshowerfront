// Canonical verified claims. Analysis becomes text only after a claim exists.
// LLM may compose language FROM these; it may never invent a new FACT-type claim.
const VerifiedClaims = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const TYPES = Object.freeze([
    "ACOUSTIC_FACT", "MUSICAL_FACT", "INSTRUMENT_FACT", "PERFORMANCE_FACT",
    "PRODUCTION_FACT", "STRUCTURAL_FACT", "LIVE_EVENT",
    "GENRE_CONTEXT", "LINEAGE_CONTEXT", "SCENE_CONTEXT", "CULTURAL_CONTEXT",
    "AESTHETIC_ASSOCIATION", "IMPRESSION"
  ]);

  function add(claims, { type, concept, confidence, evidence = [], text = null, source = "detector" }) {
    if (!TYPES.includes(type) || !concept) return;
    const score = clamp(confidence);
    if (score < 0.55) return;
    const existing = claims.find(item => item.concept === concept && item.type === type);
    if (existing) {
      if (score > existing.confidence) {
        existing.confidence = score;
        existing.evidence = [...new Set([...existing.evidence, ...evidence])].slice(0, 8);
      }
      return;
    }
    claims.push({
      id: `C${String(claims.length + 1).padStart(2, "0")}`,
      type, concept, confidence: score,
      evidence: evidence.filter(Boolean).slice(0, 8),
      text, source
    });
  }

  function collect(state = {}) {
    const claims = [];
    const grammar = state.rhythmicGrammar || {};
    const production = state.productionEvidence || {};
    const performance = state.performance || {};
    const mood = state.moodDimensions || {};
    const character = state.trackCharacter || {};
    const primitives = state.primitives || {};
    const expression = state.expressionFeatures || {};

    if (grammar.fourOnFloor >= 0.7)
      add(claims, { type: "MUSICAL_FACT", concept: "four_on_floor", confidence: grammar.fourOnFloor,
        evidence: ["rhythmicGrammar.fourOnFloor", "rhythmicGrammar.kickPeriodicity"] });
    if (grammar.swing >= 0.65)
      add(claims, { type: "MUSICAL_FACT", concept: "swing", confidence: grammar.swing,
        evidence: ["rhythmicGrammar.swing", "primitives.pulse.swingRatio"] });
    if (grammar.brokenBeat >= 0.65)
      add(claims, { type: "MUSICAL_FACT", concept: "broken_beat", confidence: grammar.brokenBeat,
        evidence: ["rhythmicGrammar.brokenBeat"] });
    if (grammar.brokenBeat >= 0.68)
      add(claims, { type: "MUSICAL_FACT", concept: "breakbeat", confidence: grammar.brokenBeat,
        evidence: ["rhythmicGrammar.brokenBeat"] });
    if (grammar.brokenBeat >= 0.68 && grammar.swing >= 0.58 && !(grammar.fourOnFloor >= 0.55))
      add(claims, { type: "MUSICAL_FACT", concept: "two_step", confidence: Math.min(grammar.brokenBeat, grammar.swing),
        evidence: ["rhythmicGrammar.brokenBeat", "rhythmicGrammar.swing", "rhythmicGrammar.fourOnFloor"] });
    if (grammar.syncopation >= 0.6)
      add(claims, { type: "MUSICAL_FACT", concept: "syncopation", confidence: grammar.syncopation,
        evidence: ["rhythmicGrammar.syncopation"] });

    for (const [field, concept] of [["sidechain", "sidechain"], ["sampleBased", "sample_based"],
      ["vocalChop", "vocal_chop"], ["filterSweep", "filter_sweep"], ["reverb", "reverb"],
      ["stereoWidth", "wide_stereo"]]) {
      if (production[field] >= 0.7)
        add(claims, { type: "PRODUCTION_FACT", concept, confidence: production[field],
          evidence: [`productionEvidence.${field}`] });
    }

    if (performance.walkingBassLikelihood >= 0.8)
      add(claims, { type: "PERFORMANCE_FACT", concept: "walking_bass", confidence: performance.walkingBassLikelihood,
        evidence: ["performance.walkingBassLikelihood", "primitives.bass.walkingLikelihood"] });
    if (performance.soloLikelihood >= 0.8 && performance.soloInstrument)
      add(claims, { type: "PERFORMANCE_FACT", concept: "solo", confidence: performance.soloLikelihood,
        evidence: ["performance.soloLikelihood", "performance.soloInstrument"] });
    if (performance.leadLikelihood >= 0.65 && performance.leadInstrument)
      add(claims, { type: "PERFORMANCE_FACT", concept: "lead", confidence: performance.leadLikelihood,
        evidence: ["performance.leadLikelihood"] });
    if (primitives.melody?.callResponseLikelihood >= 0.7)
      add(claims, { type: "PERFORMANCE_FACT", concept: "call_response", confidence: primitives.melody.callResponseLikelihood,
        evidence: ["primitives.melody.callResponseLikelihood"] });
    if (primitives.melody?.motifRecurrence >= 0.65)
      add(claims, { type: "MUSICAL_FACT", concept: "recurring_motif", confidence: primitives.melody.motifRecurrence,
        evidence: ["primitives.melody.motifRecurrence"] });

    const brightness = mood.brightness ?? character.timbre?.brightness;
    const warmth = mood.warmth ?? character.timbre?.warmth;
    const density = character.texture?.density;
    const spaciousness = mood.spaciousness ?? character.space?.spaciousness;
    if (brightness >= 0.62)
      add(claims, { type: "ACOUSTIC_FACT", concept: "bright_timbre", confidence: brightness,
        evidence: ["moodDimensions.brightness", "trackCharacter.timbre.brightness"] });
    if (brightness !== undefined && brightness <= 0.38)
      add(claims, { type: "ACOUSTIC_FACT", concept: "dark_timbre", confidence: 1 - brightness,
        evidence: ["moodDimensions.brightness"] });
    if (warmth >= 0.62)
      add(claims, { type: "ACOUSTIC_FACT", concept: "warm_timbre", confidence: warmth,
        evidence: ["moodDimensions.warmth"] });
    if (density >= 0.65)
      add(claims, { type: "ACOUSTIC_FACT", concept: "dense_texture", confidence: density,
        evidence: ["trackCharacter.texture.density"] });
    if (density !== undefined && density <= 0.35)
      add(claims, { type: "ACOUSTIC_FACT", concept: "sparse_texture", confidence: 1 - density,
        evidence: ["trackCharacter.texture.density"] });
    if (spaciousness >= 0.62)
      add(claims, { type: "ACOUSTIC_FACT", concept: "wide_space", confidence: spaciousness,
        evidence: ["moodDimensions.spaciousness"] });
    if (mood.valence >= 0.62)
      add(claims, { type: "ACOUSTIC_FACT", concept: "high_valence", confidence: mood.valence,
        evidence: ["moodDimensions.valence"] });
    if (mood.arousal >= 0.62)
      add(claims, { type: "ACOUSTIC_FACT", concept: "high_arousal", confidence: mood.arousal,
        evidence: ["moodDimensions.arousal"] });
    if (mood.valence <= 0.42 && mood.warmth >= 0.5)
      add(claims, { type: "AESTHETIC_ASSOCIATION", concept: "nostalgia", confidence: clamp((1 - mood.valence) * 0.5 + mood.warmth * 0.5),
        evidence: ["moodDimensions.valence", "moodDimensions.warmth"] });

    for (const item of state.instrumentation?.observed || []) {
      if (item.confidence >= 0.45)
        add(claims, { type: "INSTRUMENT_FACT", concept: `instrument_${String(item.id || item.label || "").toLowerCase().replace(/\s+/g, "_")}`,
          confidence: item.confidence, evidence: ["instrumentation.observed"], text: item.label });
    }

    for (const idiom of state.detectedIdioms || []) {
      if ((idiom.confidence || 0) < 0.6) continue;
      add(claims, { type: "MUSICAL_FACT", concept: `idiom_${idiom.id || idiom.text}`,
        confidence: idiom.confidence, evidence: idiom.anchors || idiom.evidence || [], text: idiom.text, source: "idiom" });
    }

    for (const concept of state.impressionConcepts || []) {
      if ((concept.confidence || 0) < 0.55) continue;
      add(claims, { type: "IMPRESSION", concept: concept.id || concept.text,
        confidence: concept.confidence, evidence: concept.anchors || [], text: concept.text, source: "impression" });
    }

    const genre = state.genre || {};
    if (genre.primary && !genre.uncertain && genre.confidence >= 0.6)
      add(claims, { type: "GENRE_CONTEXT", concept: `genre_${String(genre.primary).toLowerCase().replace(/\s+/g, "_")}`,
        confidence: genre.confidence, evidence: ["genre.primary", "genre.confidence"], text: genre.primary });

    for (const candidate of state.genreContextEvidence?.candidates || []) {
      const family = String(candidate.relationFamily || "").toUpperCase();
      const type = family === "SCENE" ? "SCENE_CONTEXT" : family === "CULTURE" ? "CULTURAL_CONTEXT"
        : family === "AESTHETIC_ASSOCIATION" ? "AESTHETIC_ASSOCIATION" : "LINEAGE_CONTEXT";
      add(claims, { type, concept: `context_${family}_${candidate.text}`,
        confidence: candidate.confidence, evidence: candidate.anchors || [], text: candidate.text, source: "context" });
    }

    if (Math.abs(expression.deltaEnergy || 0) >= 0.09)
      add(claims, { type: "LIVE_EVENT", concept: expression.deltaEnergy > 0 ? "energy_rise" : "energy_drop",
        confidence: clamp(Math.abs(expression.deltaEnergy) * 4), evidence: ["expressionFeatures.deltaEnergy"] });
    if (Math.abs(expression.deltaTransientDensity || 0) >= 0.12)
      add(claims, { type: "LIVE_EVENT", concept: "rhythmic_densification",
        confidence: clamp(Math.abs(expression.deltaTransientDensity) * 3),
        evidence: ["expressionFeatures.deltaTransientDensity"] });
    for (const event of state.instrumentEvents || []) {
      if (event.confidence < 0.65) continue;
      add(claims, { type: "LIVE_EVENT",
        concept: event.kind === "exit" ? "layer_exit" : "layer_entry",
        confidence: event.confidence, evidence: ["instrumentEvents"], text: event.label });
    }

    return {
      items: claims,
      byConcept: Object.fromEntries(claims.map(item => [item.concept, item])),
      licensed: new Set(claims.map(item => item.concept)),
      capsule: capsule(claims, state)
    };
  }

  function capsule(claims, state = {}) {
    const genre = state.genre || {};
    const distinctive = state.distinctive?.statements || [];
    const verified = claims.filter(item => !["LINEAGE_CONTEXT", "SCENE_CONTEXT", "CULTURAL_CONTEXT"].includes(item.type))
      .sort((a, b) => b.confidence - a.confidence).slice(0, 12)
      .map(item => `${item.concept} ${item.confidence.toFixed(2)}`);
    const context = claims.filter(item => /CONTEXT|ASSOCIATION/.test(item.type))
      .slice(0, 6).map(item => `${item.text || item.concept} ${item.confidence.toFixed(2)}`);
    const unsupported = ["walking_bass", "solo", "vocal_chop", "sidechain", "swing", "live_drums", "guitar_solo"]
      .filter(concept => !claims.some(item => item.concept === concept));
    return {
      verified, distinctive: distinctive.slice(0, 6), context,
      unsupported,
      genre: { primary: genre.primary || null, confidence: genre.confidence || 0,
        entropy: genre.entropy ?? genre.rawEntropy ?? null, margin: genre.margin ?? null,
        stability: genre.stability ?? 0, uncertain: Boolean(genre.uncertain) }
    };
  }

  function has(store, concept) {
    return Boolean(store?.byConcept?.[concept] || store?.licensed?.has?.(concept));
  }

  return { TYPES, collect, has, capsule, add };
})();

if (typeof module !== "undefined" && module.exports) module.exports = VerifiedClaims;
