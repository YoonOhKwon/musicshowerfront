// Shared, open semantic contract. Vocabulary is not the evidence boundary.
const SemanticFacets = (() => {
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  // "imagery" (concrete visual images) is written only by grounded association; see SEMANTIC_OWNERSHIP.md.
  const names = ["genre", "lineage", "rhythm", "instrumentation", "performance", "arrangement", "production", "dynamics", "mood", "era", "scene", "culture", "association", "imagery", "live"];
  const contextual = new Set(["lineage", "era", "scene", "culture", "association", "imagery"]);
  const volatile = new Set(["rhythm", "instrumentation", "performance", "arrangement", "production", "live", "dynamics"]);
  const clamp = x => Math.min(1, Math.max(0, Number(x) || 0));
  const empty = () => Object.fromEntries(names.map(name => [name, []]));
  function read(object, path) {
    if (typeof path !== "string" || path.length > 120) return undefined;
    // Defensive: callers that bypass Layers.decorate() (genreContextEngine, phrasePoolEngine) pass
    // paths we authored ourselves, already canonical, so this is a no-op for them — but it is the
    // last line of defense against a raw "snapshot.foo"/"foo[0]" anchor reaching here directly.
    const normalized = Layers.normalizePath(path);
    return normalized.split(".").reduce((value, key) => ["__proto__", "constructor", "prototype"].includes(key) ||
      !value || !Object.hasOwn(value, key) ? undefined : value[key], object);
  }
  function meaningful(value) {
    return value !== undefined && value !== null && value !== false && value !== "unknown" &&
      value !== "Unknown" && (typeof value !== "number" || Number.isFinite(value)) &&
      (typeof value !== "object" || Object.keys(value).length > 0);
  }
  // Historical compatibility index. It is still loaded for aliases, reports and migration tools,
  // but it is no longer an admission whitelist. Genre vocabulary is open-world: an unfamiliar
  // scene name is judged by evidence, temporal corroboration and contradiction checks downstream,
  // never by whether a developer happened to register its spelling in advance.
  let approvedCoreTerms = new Map([
    ["브레이크코어", { aliases: ["breakcore"], genreFamily: "Breakcore" }],
    ["하드코어", { aliases: ["hardcore"], genreFamily: "Hardcore" }],
    ["데스코어", { aliases: ["deathcore"], genreFamily: "Deathcore" }],
    ["매스코어", { aliases: ["mathcore"], genreFamily: "Mathcore" }]
  ]);
  function setApprovedCoreTerms(entries) {
    if (!Array.isArray(entries) || !entries.length) return approvedCoreTerms.size;
    const next = new Map();
    for (const entry of entries) {
      const term = typeof entry === "string" ? entry : entry?.term;
      if (typeof term === "string" && term.trim()) next.set(term.trim(),
        { aliases: Array.isArray(entry?.aliases) ? entry.aliases : [], genreFamily: entry?.genreFamily || null });
    }
    if (next.size) approvedCoreTerms = next;
    return approvedCoreTerms.size;
  }
  if (typeof require === "function") {
    // Node/tests: the data file loads synchronously at require time, same as any other module
    // this file already pulls in with the typeof-then-require pattern above.
    try { setApprovedCoreTerms(require("../../data/approvedCoreTerms.json")?.entries); } catch { /* browser: no require, keep the safe default above */ }
  }
  // The open layer (association/AESTHETIC, mood/IMPRESSION) is where impression-style language
  // lives -- confident poetic compression, not measurement. Its structural limits (word count)
  // are looser than the strict/context layers', but this is still real-text hygiene, not content
  // moderation: control characters, run-on narrative-length text and the song-identification /
  // evidence checks downstream apply identically everywhere.
  const OPEN_LAYERS = new Set(["AESTHETIC", "IMPRESSION"]);
  function safeText(text, category) {
    const openLayer = OPEN_LAYERS.has(Layers.facetLayers[category]);
    if (!names.includes(category) || typeof text !== "string" || !text.trim() || text.length > 60 ||
        /[\r\n<>\[\]{};!?]|https?:|분석.*(?:중|대기)|준비 완료|재생해주세요|미확정|불확실|unknown/i.test(text)) return false;
    if (!/^[\p{L}\p{N}\s&/+'().,:\-]+$/u.test(text) || text.trim().split(/\s+/).length > (openLayer ? 10 : 7)) return false;
    // The generic AI-poetry blocklist stays an instant veto in every strict/context facet --
    // measurement and style-hypothesis language must never wear it. In the open layer it is no
    // longer a hard reject: js/semantic/clicheScore.js + phraseSelection.js's clichePenalty grade
    // it down (and grade it down further on recent reuse) instead of discarding it outright,
    // since a played-out phrase used sparingly still reads as a legitimate impression.
    if (!openLayer && /과열된|냉각된|저중력|무중력|분홍빛|보랏빛|유리.*(?:기억|고독|슬픔)|압축된 고독|금속성 황홀|차가운 황홀|purple memory|glass loneliness|heated tension|weightless sadness/i.test(text)) return false;
    if (/이 곡은|제작한|작곡한|발매된|의 곡|made by|composed by|released in/i.test(text)) return false;
    // Do not use spelling (including the productive "-코어" suffix) as a truth boundary.
    // Unsupported genre inventions are rejected by support()/LanguageCritic; grounded unfamiliar
    // terms are allowed to enter the reversible OpenWorldConceptRegistry belief lifecycle.
    // A decade is a style reference; a precise recording year is not recoverable.
    if (category === "era" && /(?:18|19|20)\d{2}(?!\d|년대|s)/.test(text)) return false;
    return true;
  }
  const anchorGroups = {
    genre: ["rhythm", "harmony", "timbre", "production", "instrumentation", "rhythmicGrammar", "primitives.pulse", "primitives.texture", "primitives.role", "primitives.tonal", "primitives.harmony", "primitives.melody", "primitives.bass", "primitives.production", "directAudioEvidence"],
    rhythm: ["rhythm", "rhythmicGrammar", "measurements", "primitives.pulse", "directAudioEvidence"],
    instrumentation: ["instrumentation", "instrumentationEvidence", "instrumentEvents", "primitives.texture", "primitives.role", "directAudioEvidence"],
    performance: ["performance", "instrumentation", "instrumentationEvidence", "instrumentEvents", "primitives.role", "primitives.tonal", "primitives.melody", "primitives.bass", "primitives.articulation", "directAudioEvidence"],
    arrangement: ["arrangement", "instrumentation", "texture", "primitives.texture", "primitives.role", "primitives.form", "primitives.arrangement", "directAudioEvidence"],
    production: ["productionEvidence", "production", "measurements", "timbre", "primitives.production", "directAudioEvidence"],
    dynamics: ["measurements", "dynamics", "directAudioEvidence"],
    mood: ["moodDimensions", "mood", "timbre", "harmony", "productionEvidence", "rhythmicGrammar", "primitives.harmony", "primitives.production", "impressionConcepts", "directAudioEvidence"],
    live: ["measurements", "instrumentEvents", "rhythmicGrammar", "currentSection", "performance", "directAudioEvidence"],
    lineage: ["genreContextEvidence", "primaryGenre", "genreEvidence", "rhythm", "production", "harmony", "instrumentation", "directAudioEvidence"],
    era: ["genreContextEvidence", "primaryGenre", "genreEvidence", "productionEvidence", "production", "instrumentation", "directAudioEvidence"],
    scene: ["genreContextEvidence", "primaryGenre", "genreEvidence", "rhythmicGrammar", "rhythm", "production", "instrumentation", "directAudioEvidence"],
    culture: ["genreContextEvidence", "primaryGenre", "genreEvidence", "productionEvidence", "instrumentation", "moodDimensions", "directAudioEvidence"],
    association: ["genreContextEvidence", "primaryGenre", "genreEvidence", "instrumentation", "productionEvidence", "production", "moodDimensions", "directAudioEvidence"],
    imagery: ["genreContextEvidence", "primaryGenre", "genreEvidence", "instrumentation", "productionEvidence", "production", "moodDimensions", "directAudioEvidence"]
  };
  function isGroundedAssociation(item) {
    return item?.sourceFamily === "groundedAssociation" && Array.isArray(item.associationAnchors) &&
      item.associationAnchors.length > 0 && ["CONTEXT", "AESTHETIC"].includes(item.layer);
  }
  function support(candidate, context = {}) {
    const snapshot = context.snapshot || {}, normalized = Layers.decorate(candidate);
    const category = normalized.category, anchors = normalized.anchors || [];
    // A grounded association was already validated server-side against listening-model evidence ids,
    // so it is held to the same evidence standard as the listening model it cites.
    const isDirectAudio = normalized.sourceFamily === "directAudio" || normalized.source === "directAudio" ||
      anchors.some(path => String(path).startsWith("directAudioEvidence")) || isGroundedAssociation(normalized);
    const values = anchors.map(path => read(snapshot, path));
    const hasSnapshot = Object.keys(snapshot).length > 0;
    const invalidAnchors = hasSnapshot ? values.filter(value => !meaningful(value)).length : 0;
    const groups = new Set(anchors.filter((path, i) => isDirectAudio || meaningful(values[i])).map(path =>
      path.startsWith("primitives.") ? path.split(".").slice(0, 2).join(".") : path.split(".")[0]));
    if (isDirectAudio) groups.add("directAudioEvidence");
    const groupMatch = isDirectAudio || [...groups].some(group => anchorGroups[category]?.includes(group));
    const confidence = clamp(normalized.confidence);
    const known = context.eligibleTexts?.includes(normalized.text);
    const scoring = Layers.evidenceScore(normalized, snapshot, read);
    // Anchor COUNT is no longer a gate — three strong, independent axes beat five weak anchors.
    // What must hold is: at least one resolvable anchor, independent axes (or a clearly
    // above-threshold score on a single axis), facet-appropriate evidence, and no contradiction.
    const axisCount = scoring.axes.length + (isDirectAudio ? 1 : 0);
    const requiredAxes = normalized.layer === "LIVE" || normalized.primitive || isDirectAudio ? 1 : 2;
    const enoughAxes = isDirectAudio || axisCount >= requiredAxes || (requiredAxes === 2 && axisCount >= 1 &&
      scoring.score >= scoring.threshold + 0.06 && normalized.source !== "llm");
    // An anchor that fails to resolve already costs evidenceScore; it must not annihilate a
    // candidate whose other anchors are real. What is still required is that SOMETHING resolved.
    const resolvedAnchors = isDirectAudio ? Math.max(1, anchors.length) : (scoring.resolvedAnchors ?? (anchors.length - invalidAnchors));
    const resolvedRatioPass = isDirectAudio || !anchors.length || scoring.resolvedAnchorRatio >= 0.34;
    const confidencePass = isDirectAudio ? confidence >= 0.45 : confidence >= (normalized.layer === "FACT" ? 0.62 : 0.48);
    const scorePass = Boolean(known) || isDirectAudio || scoring.score >= scoring.threshold;
    let supported = Boolean(known) || (!hasSnapshot && category === "genre") ||
      (resolvedAnchors >= 1 && resolvedRatioPass && enoughAxes && groupMatch && confidencePass && scorePass);
    let reason = supported ? "grounded" : !resolvedAnchors ? "no-anchor-resolved"
      : !resolvedRatioPass ? "low-resolved-anchor-ratio"
        : !enoughAxes ? "insufficient-independent-axes"
          : !groupMatch ? "facet-evidence-group-mismatch"
            : !confidencePass || !scorePass ? "score-below-threshold" : "insufficient-evidence";
    const gates = { scorePass, axesPass: enoughAxes, groupMatchPass: groupMatch,
      genreGatePass: true, resolvedEvidencePass: resolvedAnchors >= 1 && resolvedRatioPass,
      contradictionPass: scoring.contradiction < 0.5, specificityPass: normalized.specificity >= 0.42,
      relationEdgePass: normalized.relationScore === undefined || normalized.relationScore >= 0.45,
      liveDeltaPass: true };
    // A phrase whose own claim points the opposite way to the measurements is never grounded,
    // no matter how many anchors it carries.
    // Each gate below only overwrites `reason` when IT is what just turned supported false — not
    // when it's merely re-confirming a failure an earlier gate already caused. Without this, the
    // LAST gate that happens to run always stamps its own label over the real cause (e.g. an
    // aesthetic candidate failing the genre/feature gate would get relabeled by the unrelated
    // "association-unqualified" suffix check simply because that check runs afterward).
    const gate = (condition, label) => {
      const was = supported;
      supported = supported && condition;
      if (was && !supported) reason = label;
    };
    if (scoring.contradiction >= 0.5) { supported = false; reason = "contradicted-by-snapshot"; }
    if (!gates.relationEdgePass) { supported = false; reason = "relation-edge-support-low"; }
    if ((contextual.has(category) || ["CONTEXT", "AESTHETIC"].includes(normalized.layer)) && !known && !isDirectAudio) {
      const genreGrounded = snapshot.confidence >= (normalized.layer === "AESTHETIC" ? 0.62 : 0.6) &&
        Boolean(snapshot.primaryGenre) &&
        [...groups].some(g => ["primaryGenre", "genreEvidence", "genreHierarchy", "genreContextEvidence"].includes(g));
      if (normalized.layer === "AESTHETIC" && !genreGrounded) {
        // Route B (feature-grounded): an aesthetic association is not just a byproduct of a
        // confident genre call. Strong, converging, non-contradicted feature evidence stands on
        // its own — stricter than the base gate precisely because there is no genre to lean on.
        const featureGrounded = axisCount >= 3 && scoring.contradiction < 0.3 && normalized.specificity >= 0.55;
        gates.genreGatePass = featureGrounded;
        gate(featureGrounded, "genre-confidence-low");
      } else {
        gates.genreGatePass = genreGrounded;
        gate(genreGrounded, "genre-confidence-low");
      }
    }
    if (normalized.layer === "LIVE") {
      const thresholdBySource = { deltaEnergy: 0.09, deltaRms: 0.035, deltaLowEnergy: 0.12,
        deltaCentroid: 900, deltaTransientDensity: 0.18, dropScore: 0.68 };
      const metadataThreshold = thresholdBySource[normalized.deltaSource] ?? 0.035;
      const metadataPass = typeof normalized.deltaMagnitude === "number" && normalized.deltaMagnitude >= metadataThreshold;
      const resolvedDeltaPass = anchors.some(path => /(?:^|\.)delta[A-Z]|dropScore|instrumentEvents/.test(path) &&
        typeof read(snapshot, path) === "number" && Math.abs(read(snapshot, path)) >= (thresholdBySource[path.split(".").at(-1)] ?? 0.035));
      gates.liveDeltaPass = metadataPass || resolvedDeltaPass;
      gate(gates.liveDeltaPass, "live-transition-without-delta");
    }
    if (category === "association" && normalized.kind === "artist" && !isDirectAudio) {
      gate(/(?:연상|계열|문법)$/.test(normalized.text) && confidence >= 0.68 && snapshot.confidence >= 0.65 &&
        [...groups].some(g => ["instrumentation", "instrumentationEvidence", "rhythmicGrammar"].includes(g)) &&
        [...groups].some(g => ["production", "productionEvidence", "genreContextEvidence", "genreHierarchy"].includes(g)),
        "artist-is-not-identification");
    }
    if (category === "association" && normalized.kind !== "artist" && !known && !isDirectAudio) {
      gate(confidence >= 0.5 && /미학|연상|계열|감성|인접성|문화|aesthetic/i.test(normalized.text), "aesthetic-association-unqualified");
    }
    if (category === "instrumentation" && !known && !isDirectAudio) {
      gate((snapshot.instrumentation?.observed || []).some(item =>
        item.confidence >= 0.35 && [item.label, item.id].some(label => String(label).toLowerCase() === normalized.text.toLowerCase())),
        "instrument-not-observed");
    }
    if (/유입|등장|진입|전면|entrance|enters/i.test(normalized.text) && /보컬|피아노|신스|기타|베이스|vocal|piano|synth/i.test(normalized.text)) {
      gate(snapshot.instrumentEvents?.some(event => event.text === normalized.text && event.confidence >= 0.65), "entrance-not-observed");
    }
    if (/솔로|\bsolo\b/i.test(normalized.text)) {
      gate(snapshot.performance?.soloLikelihood >= 0.8 && snapshot.performance?.soloInstrument &&
        normalized.text.toLowerCase().includes(String(snapshot.performance.soloInstrument).toLowerCase()), "solo-needs-correlated-change");
    }
    if (/리드|\blead\b/i.test(normalized.text) && /보컬|피아노|신스|기타|베이스|색소폰|트럼펫|vocal|piano|synth|guitar|bass|sax|trumpet/i.test(normalized.text)) {
      gate(snapshot.performance?.leadLikelihood >= 0.65 && snapshot.performance?.leadInstrument &&
        normalized.text.toLowerCase().includes(String(snapshot.performance.leadInstrument).toLowerCase()), "lead-needs-correlated-dominance");
    }
    if (/워킹 베이스|walking bass/i.test(normalized.text)) gate(snapshot.performance?.walkingBassLikelihood >= 0.8, "walking-bass-needs-pitch-evidence");
    if (/트리오 구성|피아노 트리오|정확히.*명|quartet|trio ensemble/i.test(normalized.text)) {
      gate(snapshot.arrangement?.verifiedEnsembleSize >= 3, "ensemble-size-unverified");
    }
    for (const [pattern, field] of [[/wide stereo|스테레오/i, "stereoWidth"], [/sidechain|사이드체인/i, "sidechain"],
      [/필터 스윕|filter sweep/i, "filterSweep"], [/보컬 찹|vocal chop|chopped vocal/i, "vocalChop"],
      [/샘플 기반|sample.based/i, "sampleBased"], [/heavy reverb|강한 리버브/i, "reverb"]]) {
      if (pattern.test(normalized.text) && !(snapshot.productionEvidence?.[field] >= 0.7)) {
        supported = false; reason = "production-method-unverified";
      }
    }
    if (!Layers.allowed(category, normalized.layer)) { supported = false; reason = "layer-facet-mismatch"; }
    return { supported: Boolean(supported), reason, invalidAnchors, groups: [...groups], confidence,
      evidenceScore: scoring.score, evidenceThreshold: scoring.threshold, evidence: normalized.evidence,
      evidenceAxes: scoring.axes, contradiction: scoring.contradiction, gates,
      claims: scoring.compatibility?.claims || {}, claimDetails: scoring.compatibility?.details || [],
      evidenceComponents: scoring };
  }
  function token(text, category, confidence, anchors, extra = {}) {
    return Layers.decorate({ text, category, confidence: clamp(confidence), weight: clamp(confidence), anchors,
      kind: contextual.has(category) ? "style" : "descriptor", role: "none", ...extra });
  }
  return { names, contextual, volatile, empty, read, meaningful, safeText, support, token, clamp, setApprovedCoreTerms,
    isGroundedAssociation };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SemanticFacets;
