const LanguageLayerPolicy = (() => {
  const Compatibility = typeof EvidenceCompatibility !== "undefined" ? EvidenceCompatibility : require("./evidenceCompatibility");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const names = Object.freeze(["LIVE", "FACT", "CONTEXT", "AESTHETIC", "IMPRESSION"]);
  const distances = Object.freeze({ LIVE: 0, FACT: 1, CONTEXT: 2, AESTHETIC: 3, IMPRESSION: 3 });
  const thresholds = Object.freeze({ LIVE: 0.48, FACT: 0.70, CONTEXT: 0.60, AESTHETIC: 0.52, IMPRESSION: 0.42 });
  const volatility = Object.freeze({ LIVE: "very-fast", FACT: "medium", CONTEXT: "slow", AESTHETIC: "slow", IMPRESSION: "medium-slow" });
  const facetLayers = Object.freeze({
    live: "LIVE",
    rhythm: "FACT", instrumentation: "FACT", performance: "FACT", arrangement: "FACT",
    production: "FACT", dynamics: "FACT",
    genre: "CONTEXT", lineage: "CONTEXT", era: "CONTEXT", scene: "CONTEXT", culture: "CONTEXT",
    association: "AESTHETIC", mood: "IMPRESSION"
  });
  const evidenceRoots = Object.freeze({
    // Includes both the raw grammar/evidence objects (rhythmicGrammar, productionEvidence, ...)
    // and semanticSnapshot.js's formatted Track Character buckets (rhythm, harmony, timbre,
    // texture, dynamics, space, production, currentSection) — both describe measured audio.
    acoustic: new Set(["measurements", "analysisWindow", "rhythmicGrammar", "instrumentation", "instrumentationEvidence",
      "instrumentEvents", "performance", "arrangement", "productionEvidence", "primitives", "mir",
      "rhythm", "harmony", "timbre", "texture", "dynamics", "space", "production", "currentSection"]),
    semantic: new Set(["genreEvidence", "primaryGenre", "genreFamily", "genreHierarchy", "moodDimensions", "mood",
      "detectedIdioms", "impressionConcepts", "embeddingEvidence"]),
    context: new Set(["genreContextEvidence", "trackContext", "temporalState", "distinctive"])
  });
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  // The JSON actually sent to the LLM is {"snapshot": {...}, "recentPhrases": [...], ...}, so a
  // model writing "snapshot.timbre.brightness" is describing the field it can see, not making a
  // format error — the anchor is just relative to the wrong root. Canonicalize once, here, so
  // every downstream reader (support(), evidenceScore(), independentAxes()) sees one true form.
  // This is a defensive normalizer, not a substitute for the prompt telling the model the rule.
  function normalizePath(path) {
    if (typeof path !== "string") return "";
    return path.trim()
      .replace(/^snapshot\.?/i, "")
      .replace(/\[(\d+)\]/g, ".$1")
      .replace(/^\.+|\.+$/g, "")
      .replace(/\.{2,}/g, ".");
  }
  const uniquePaths = values => [...new Set((Array.isArray(values) ? values : [])
    .map(normalizePath)
    .filter(value => value.length > 0 && value.length <= 120))].slice(0, 8);

  function layerFor(category, candidate = {}) {
    const requested = String(candidate.layer || "").toUpperCase();
    if (names.includes(requested)) return requested;
    if (["PRIMARY_GENRE", "PARENT", "LINEAGE", "ADJACENCY", "ERA", "SCENE", "CULTURE", "ARTIST",
      "SOURCE", "INFLUENCE", "RHYTHMIC_AFFINITY", "COMPOSITION"]
      .includes(String(candidate.relationFamily || "").toUpperCase())) return "CONTEXT";
    if (String(candidate.relationFamily || "").toUpperCase() === "AESTHETIC_ASSOCIATION") return "AESTHETIC";
    if (category === "association" && candidate.kind === "artist") return "CONTEXT";
    return facetLayers[category] || "FACT";
  }

  function allowed(category, layer) {
    const expected = facetLayers[category];
    if (!expected) return false;
    if (category === "association" && layer === "CONTEXT") return true;
    // Facet answers "what aspect?" while layer answers "how do we know it?". A dynamics
    // phrase can therefore be a measured state (FACT) or a measured change (LIVE).
    if (category === "dynamics" && layer === "LIVE") return true;
    if (category === "mood" && layer === "AESTHETIC") return true;
    if (["production", "arrangement"].includes(category) && layer === "CONTEXT") return true;
    return expected === layer;
  }

  function classifyPaths(anchors = [], supplied = {}) {
    const result = { acoustic: [], semantic: [], context: [] };
    for (const kind of Object.keys(result)) result[kind].push(...uniquePaths(supplied?.[kind]));
    for (const path of uniquePaths(anchors)) {
      if (Object.values(result).some(values => values.includes(path))) continue;
      const root = path.split(".")[0];
      const kind = Object.entries(evidenceRoots).find(([, roots]) => roots.has(root))?.[0] || "semantic";
      result[kind].push(path);
    }
    for (const kind of Object.keys(result)) result[kind] = uniquePaths(result[kind]);
    return result;
  }

  function defaultSpecificity(candidate, layer) {
    const text = String(candidate.text || "");
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const staticPrimitive = layer === "LIVE" && !/유입|이탈|상승|하강|진입|전환|확장|감소|개방|비워|전면|촘촘해|변화/.test(text);
    const base = { LIVE: staticPrimitive ? 0.52 : 0.76, FACT: 0.8, CONTEXT: 0.76, AESTHETIC: 0.67, IMPRESSION: 0.62 }[layer];
    // Without a snapshot we cannot measure grounding, but a raw single-axis descriptor
    // ("높은 음압") is weak display language in any layer, and a catch-all term is weaker still.
    const shape = Quality.isPrimitive(text) ? -0.26 : Quality.isGeneric(text) ? -0.22 : 0;
    return clamp(base + shape + (words >= 2 && words <= 5 ? 0.04 : 0));
  }

  function decorate(candidate = {}, defaults = {}) {
    const category = candidate.category || candidate.facet || defaults.category || "live";
    const layer = layerFor(category, candidate);
    const evidence = classifyPaths(candidate.anchors, candidate.evidence);
    const anchors = uniquePaths([...evidence.acoustic, ...evidence.semantic, ...evidence.context, ...(candidate.anchors || [])]);
    // Kept for debug/diagnostics only — everything else in this module reads the normalized form.
    const rawAnchors = (Array.isArray(candidate.anchors) ? candidate.anchors : [])
      .filter(value => typeof value === "string").slice(0, 8);
    // A model-supplied score is a proposal, never the verdict: it is blended with the locally
    // computed value, and the critic recomputes both again once it holds the live snapshot.
    const snapshot = defaults.snapshot;
    const proposal = { specificity: candidate.specificity, novelty: candidate.novelty,
      contrastiveness: candidate.contrastiveness };
    const localSpecificity = snapshot
      ? Quality.specificity({ text: candidate.text, category }, snapshot)
      : defaultSpecificity(candidate, layer);
    const specificity = Quality.blend(proposal.specificity, localSpecificity);
    const novelty = Quality.blend(proposal.novelty, candidate.novelty === undefined ? 0.72 : clamp(candidate.novelty));
    const localContrastiveness = snapshot
      ? Quality.contrastiveness({ text: candidate.text, category }, snapshot)
      : clamp((specificity + novelty) / 2);
    const contrastiveness = Quality.blend(proposal.contrastiveness, localContrastiveness);
    const relationFamily = candidate.relationFamily || Quality.relationFamily({ ...candidate, category, layer });
    const semanticFamily = Quality.semanticFamily({ ...candidate, category, layer });
    const conceptKey = candidate.conceptKey || Quality.conceptKey({ ...candidate, category, layer, relationFamily });
    const musicalFacet = Quality.musicalFacet({ ...candidate, category, layer });
    const specificityTier = Quality.specificityTier({ ...candidate, category, layer, specificity });
    return {
      ...candidate,
      category,
      facet: category,
      layer,
      semanticDistance: distances[layer],
      evidence,
      anchors,
      rawAnchors,
      specificity,
      novelty,
      contrastiveness,
      relationFamily,
      semanticFamily,
      conceptKey,
      musicalFacet,
      specificityTier,
      epistemicLayer: layer,
      relationScore: Number.isFinite(candidate.relationScore) ? clamp(candidate.relationScore) : undefined,
      proposal,
      genome: candidate.genome || (candidate.claimsUsed?.length
        ? `${layer}:${candidate.operator || "ATOMIC"}:${[...candidate.claimsUsed].sort().join("+")}`
        : candidate.concept ? `${layer}:${candidate.operator || "ATOMIC"}:${candidate.concept}` : undefined),
      claimsUsed: Array.isArray(candidate.claimsUsed) ? candidate.claimsUsed.slice(0, 8) : [],
      operator: candidate.operator || undefined,
      concept: candidate.concept || undefined,
      primitive: candidate.primitive === undefined
        ? candidate.source === "primitive" || Quality.isPrimitive(candidate.text) : Boolean(candidate.primitive),
      relevance: candidate.relevance === undefined ? 0.85 : clamp(candidate.relevance),
      volatility: candidate.volatility || volatility[layer]
    };
  }

  function meaningful(value) {
    return value !== undefined && value !== null && value !== false && value !== "unknown" && value !== "Unknown" &&
      (typeof value !== "number" || Number.isFinite(value)) &&
      (typeof value !== "object" || Object.keys(value).length > 0);
  }

  // A resolved anchor means "this measurement exists and is informative". Whether the measurement
  // agrees with what the phrase claims is a separate question, answered by EvidenceCompatibility —
  // extremeness alone must never be mistaken for support.
  const LIKELIHOOD_PATH = /(?:[Ll]ikelihood|[Cc]onfidence)$|^(?:productionEvidence|rhythmicGrammar|instrumentationEvidence|genreContextEvidence|performance)\./;
  function strength(value, path = "") {
    if (!meaningful(value)) return null;
    // A measurement that resolved is solid evidence that something is being described; whether it
    // is the RIGHT something is decided by the direction check, not by inflating this number.
    if (typeof value !== "number") return 0.86;
    if (value < 0 || value > 1) return 0.86;
    // Likelihood-style fields are the one case where a larger number really is stronger evidence.
    return LIKELIHOOD_PATH.test(path) ? clamp(0.35 + value * 0.6) : 0.86;
  }

  // Independent evidence axes matter more than raw anchor count: three anchors drawn from
  // rhythm + production + genre say far more than five anchors all read off one object.
  const AXIS_OF_ROOT = Object.freeze({
    rhythm: "rhythm", rhythmicGrammar: "rhythm", "primitives.pulse": "rhythm",
    production: "production", productionEvidence: "production", "primitives.production": "production",
    instrumentation: "instrumentation", instrumentationEvidence: "instrumentation",
    instrumentEvents: "instrumentation", performance: "instrumentation", arrangement: "instrumentation",
    "primitives.texture": "instrumentation", "primitives.role": "instrumentation", "primitives.bass": "instrumentation",
    "primitives.instrument": "instrumentation",
    measurements: "acoustic", analysisWindow: "acoustic", timbre: "acoustic", texture: "acoustic",
    space: "acoustic", dynamics: "acoustic", mir: "acoustic", harmony: "acoustic",
    "primitives.tonal": "acoustic", "primitives.harmony": "acoustic", "primitives.melody": "acoustic",
    "primitives.articulation": "acoustic", currentSection: "acoustic",
    genreEvidence: "genre", primaryGenre: "genre", genreFamily: "genre", genreHierarchy: "genre",
    subgenreCandidates: "genre", moodDimensions: "mood", mood: "mood",
    genreContextEvidence: "context", trackContext: "context", distinctive: "context",
    temporalState: "temporal", detectedIdioms: "semantic", impressionConcepts: "semantic",
    "primitives.form": "semantic", "primitives.arrangement": "semantic",
    embeddingEvidence: "semantic", directAudioEvidence: "directAudio"
  });
  const rootOf = path => path.startsWith("primitives.")
    ? path.split(".").slice(0, 2).join(".") : path.split(".")[0];
  function independentAxes(anchors = [], snapshot = {}, read = () => undefined) {
    const axes = new Set();
    for (const path of anchors) {
      if (!meaningful(read(snapshot, path))) continue;
      axes.add(AXIS_OF_ROOT[rootOf(path)] || "semantic");
    }
    return axes;
  }

  function evidenceScore(candidate, snapshot = {}, read = () => undefined) {
    const item = decorate(candidate);
    const values = kind => item.evidence[kind]
      .map(path => strength(read(snapshot, path), path)).filter(value => value !== null);
    const average = list => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
    const acoustic = average(values("acoustic"));
    const semanticValues = values("semantic");
    const genreConfidence = clamp(snapshot.confidence);
    const semantic = Math.max(average(semanticValues), genreConfidence * (item.layer === "FACT" ? 0.7 : 1));
    const context = Math.max(average(values("context")), clamp(snapshot.genreContextEvidence?.confidence));
    const temporalCandidate = item.temporal?.long || item.temporal?.short;
    const elapsed = Number(snapshot.temporalState?.elapsedMs || snapshot.analysisWindow?.windowSeconds * 1000) || 0;
    const temporal = Number.isFinite(temporalCandidate) ? clamp(temporalCandidate)
      : clamp(elapsed / (item.semanticDistance >= 2 ? 30000 : 8000));
    const weights = {
      LIVE: [0.62, 0.08, 0.05, 0.25],
      FACT: [0.55, 0.2, 0.08, 0.17],
      CONTEXT: [0.23, 0.32, 0.25, 0.2],
      AESTHETIC: [0.18, 0.27, 0.32, 0.23],
      IMPRESSION: [0.28, 0.3, 0.17, 0.25]
    }[item.layer];
    // A component the snapshot simply does not carry (no timing metadata, no context engine yet)
    // must not be scored as "zero evidence" — that would punish a candidate for the snapshot's
    // gaps. Its weight is redistributed across the components that do have data.
    const parts = [
      [acoustic, weights[0], values("acoustic").length > 0],
      [semantic, weights[1], semanticValues.length > 0 || genreConfidence > 0],
      [context, weights[2], values("context").length > 0 || clamp(snapshot.genreContextEvidence?.confidence) > 0],
      [temporal, weights[3], Number.isFinite(temporalCandidate) || elapsed > 0]
    ].filter(([, , available]) => available);
    const weightTotal = parts.reduce((sum, [, weight]) => sum + weight, 0);
    const support = weightTotal
      ? parts.reduce((sum, [value, weight]) => sum + value * weight, 0) / weightTotal
      : 0;
    const axes = independentAxes(item.anchors, snapshot, read);
    const axisBonus = Math.min(0.18, Math.max(0, axes.size - 1) * 0.07);
    // Anchors that do not resolve cost evidence in proportion to how many there are; a single
    // mistaken path must not annihilate a candidate whose remaining evidence is real.
    const resolvedPaths = item.anchors.filter(path => meaningful(read(snapshot, path)));
    const unresolvedPaths = item.anchors.filter(path => !meaningful(read(snapshot, path)));
    const resolvedCount = resolvedPaths.length;
    const unresolvedRatio = item.anchors.length ? 1 - resolvedCount / item.anchors.length : 0;
    const unresolvedPenalty = unresolvedRatio * 0.15;
    const compatibility = Compatibility.assess(item.text, snapshot);
    // A phrase that claims a direction the music does not have is penalised, however many
    // anchors it listed; a phrase whose claims are confirmed is rewarded.
    const alignment = compatibility.checked ? 0.72 + compatibility.support * 0.42 : 1;
    const contradictionPenalty = compatibility.contradiction * 0.45;
    const score = clamp(support * alignment + axisBonus - contradictionPenalty - unresolvedPenalty);
    return { score, acoustic, semantic, context, temporal, support, axisBonus, alignment,
      axes: [...axes], resolvedAnchors: resolvedCount, unresolvedRatio,
      resolvedAnchorRatio: clamp(1 - unresolvedRatio), resolvedPaths, unresolvedPaths,
      contradiction: compatibility.contradiction, compatibility,
      threshold: thresholds[item.layer] };
  }

  function temporalFitness(candidate, { observationSeconds = Infinity, changing = false } = {}) {
    const item = decorate(candidate);
    const elapsed = Number.isFinite(observationSeconds) ? observationSeconds : Infinity;
    if (elapsed < 5 && item.semanticDistance >= 2) return 0;
    if (elapsed < 15 && item.semanticDistance >= 3) return 0;
    if (elapsed < 25 && item.semanticDistance >= 3) return 0.08;
    if (changing) return { LIVE: 1.55, FACT: 1.2, CONTEXT: 0.58, AESTHETIC: 0.38, IMPRESSION: 0.5 }[item.layer];
    if (elapsed < 15) return { LIVE: 1.1, FACT: 1.3, CONTEXT: 0.72, AESTHETIC: 0, IMPRESSION: 0 }[item.layer];
    if (elapsed < 30) return { LIVE: 0.9, FACT: 1.12, CONTEXT: 1.25, AESTHETIC: 0.65, IMPRESSION: 0.58 }[item.layer];
    return { LIVE: 0.82, FACT: 1, CONTEXT: 1.08, AESTHETIC: 1.12, IMPRESSION: 1.08 }[item.layer];
  }

  function ttlMs(candidate) {
    const item = decorate(candidate);
    const named = { "very-fast": 6500, fast: 12000, medium: 18000, "medium-slow": 36000, slow: 60000 };
    return Math.max(2000, Number(item.ttlMs) || named[item.volatility] || 18000);
  }

  return { names, distances, thresholds, volatility, facetLayers, layerFor, allowed, classifyPaths,
    decorate, evidenceScore, temporalFitness, ttlMs, clamp, normalizePath };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LanguageLayerPolicy;
