const SemanticSnapshot = (() => {
  const Evidence = typeof SemanticEvidence !== "undefined" ? SemanticEvidence : require("./semanticEvidence");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  const METRICS = [
    ["rhythm.pulseRegularity", "pulse regularity"],
    ["rhythm.onsetDensity", "onset density"],
    ["rhythm.rhythmicComplexity", "rhythmic complexity"],
    ["rhythm.breakbeatLikelihood", "broken-pulse character"],
    ["harmony.tonalness", "tonal focus"],
    ["harmony.harmonicMotion", "harmonic motion"],
    ["timbre.brightness", "brightness"],
    ["timbre.warmth", "warmth"],
    ["timbre.roughness", "roughness"],
    ["timbre.transientSharpness", "transient edge"],
    ["texture.density", "spectral density"],
    ["texture.sustainedness", "sustain"],
    ["texture.granularness", "granularity"],
    ["dynamics.dynamicRange", "dynamic range"],
    ["dynamics.compressionDensity", "compression"],
    ["space.spaciousness", "spaciousness"],
    ["space.perceivedDepth", "depth"],
    ["production.subWeight", "sub weight"],
    ["production.saturation", "saturation"],
    ["structure.repetition", "repetition"]
  ];

  function readPath(source, path) {
    return path.split(".").reduce((value, key) => value?.[key], source);
  }

  function level(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "unknown";
    const number = clamp(value);
    if (number < 0.17) return "very low";
    if (number < 0.36) return "low";
    if (number < 0.57) return "medium";
    if (number < 0.76) return "high";
    return "very high";
  }

  function tempo(bpm) {
    const value = Number(bpm) || 0;
    if (!value) return "unknown";
    if (value < 78) return "very slow";
    if (value < 105) return "slow";
    if (value < 132) return "medium";
    if (value < 160) return "fast";
    return "very fast";
  }

  function stableFingerprint(snapshot) {
    const compact = [
      snapshot.genreFamily,
      snapshot.primaryGenre,
      ...snapshot.subgenreCandidates,
      ...Object.values(snapshot.rhythm),
      ...Object.values(snapshot.harmony),
      ...Object.values(snapshot.timbre),
      ...Object.values(snapshot.texture),
      ...Object.values(snapshot.dynamics),
      ...Object.values(snapshot.space),
      ...Object.values(snapshot.production),
      ...snapshot.mood,
      snapshot.currentSection.state,
      ...snapshot.distinctive.statements,
      ...(snapshot.instrumentation?.observed || []).map(x => x.id + ":" + level(x.confidence)),
      snapshot.performance?.soloInstrument || "",
      level(snapshot.rhythmicGrammar?.swing), level(snapshot.rhythmicGrammar?.brokenBeat),
      ...(snapshot.genreContextEvidence?.matchedPriors || []),
      snapshot.primitives?.texture?.textureClass || "",
      snapshot.primitives?.role?.bassFunction || "",
      snapshot.primitives?.pulse?.accentPeriodicity ?? "",
      ...(snapshot.detectedIdioms || []).map(item => item.text),
      ...(snapshot.impressionConcepts || []).map(item => item.id)
    ].join("|");
    let hash = 2166136261;
    for (const character of compact) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function salientStatements(character = {}) {
    return METRICS
      .filter(([path]) => Number.isFinite(readPath(character, path)))
      .map(([path, label]) => ({ label, value: clamp(readPath(character, path)) }))
      .filter(item => item.value >= 0.77 || item.value <= 0.2)
      .sort((left, right) => Math.abs(right.value - 0.5) - Math.abs(left.value - 0.5))
      .slice(0, 6)
      .map(item => `${item.value >= 0.5 ? "pronounced" : "restrained"} ${item.label}`);
  }

  class DistinctivenessTracker {
    constructor({ historySize = 36, minimumObservations = 8, threshold = 0.16 } = {}) {
      this.historySize = historySize;
      this.minimumObservations = minimumObservations;
      this.threshold = threshold;
      this.reset();
    }

    reset() {
      this.history = [];
      this.current = { basis: "absolute character only", genreRelativeAvailable: false, statements: [] };
    }

    observe(character = {}) {
      const values = Object.fromEntries(METRICS.map(([path]) => [path, clamp(readPath(character, path))]));
      const previous = this.history.slice();
      this.history.push(values);
      if (this.history.length > this.historySize) this.history.shift();
      const statements = salientStatements(character);
      if (previous.length >= this.minimumObservations) {
        const relative = METRICS.map(([path, label]) => {
          const mean = previous.reduce((sum, item) => sum + item[path], 0) / previous.length;
          return { label, delta: values[path] - mean };
        })
          .filter(item => Math.abs(item.delta) >= this.threshold)
          .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
          .slice(0, 4)
          .map(item => `${item.delta > 0 ? "currently more" : "currently less"} ${item.label} than this session's recent baseline`);
        statements.unshift(...relative);
      }
      this.current = {
        basis: previous.length >= this.minimumObservations ? "session-relative plus absolute character" : "absolute character only",
        genreRelativeAvailable: false,
        statements: [...new Set(statements)].slice(0, 8)
      };
      return this.current;
    }
  }

  function moodLabels(state = {}) {
    const supplied = (state.mood?.labels || [])
      .map(item => typeof item === "string" ? item : item?.label)
      .filter(Boolean)
      .slice(0, 4);
    if (supplied.length) return supplied;
    const mood = state.mood?.fused || {};
    return [
      clamp(mood.arousal) > 0.65 ? "activated" : clamp(mood.arousal) < 0.34 ? "still" : "measured",
      clamp(mood.valence) > 0.62 ? "open" : clamp(mood.valence) < 0.38 ? "somber" : "ambiguous",
      clamp(mood.tension) > 0.6 ? "tense" : "settled",
      clamp(mood.warmth) > 0.6 ? "warm" : clamp(mood.warmth) < 0.38 ? "cold" : "temperate"
    ];
  }

  function temporalItem(item = {}) {
    return {
      text: item.text,
      category: item.category,
      confidence: clamp(item.confidence),
      semanticConfidence: clamp(item.semanticConfidence ?? item.confidence),
      temporalStability: clamp(item.temporalStability),
      evidenceStatus: item.evidenceStatus || "unknown",
      expiresAt: item.expiresAt || null,
      provenance: item.provenance ? {
        source: item.provenance.source || [], path: item.provenance.path || [],
        firstSeenAt: item.provenance.firstSeenAt ?? null,
        lastSeenAt: item.provenance.lastSeenAt ?? null,
        currentConfidence: clamp(item.provenance.currentConfidence),
        peakConfidence: clamp(item.provenance.peakConfidence)
      } : null
    };
  }

  function serialize(state = {}, distinctiveness = null) {
    const character = state.trackCharacter || {};
    const genre = state.genre || {};
    const snapshot = {
      ...Evidence.sanitize(state),
      primitives: state.primitives ? Object.fromEntries(Object.entries(state.primitives).filter(([key]) => key !== "meta")) : null,
      detectedIdioms: (state.detectedIdioms || []).slice(0, 10).map(item => ({
        text: item.text, facet: item.category, confidence: clamp(item.confidence), neutral: Boolean(item.neutral),
        anchors: (item.anchors || []).slice(0, 6), source: item.source || "idiom",
        semanticFamily: item.semanticFamily || null, persistenceMs: item.persistenceMs || item.ttlMs || null
      })),
      impressionConcepts: (state.impressionConcepts || []).slice(0, 6).map(item => ({
        id: item.id, text: item.text, confidence: clamp(item.confidence), anchors: (item.anchors || []).slice(0, 6),
        semanticFamily: item.semanticFamily, creativeOperator: item.creativeOperator,
        semanticEpoch: item.semanticEpoch, timestamp: item.timestamp, ttlMs: item.ttlMs
      })),
      mir: state.mir ? {
        tempo: state.mir.tempo, tonal: state.mir.tonal, chroma: state.mir.chroma,
        rhythm: state.mir.rhythm, updatedAt: state.mir.updatedAt
      } : null,
      embeddingEvidence: {
        status: state.conceptEmbedding?.available ? "active" : "unavailable",
        reason: state.conceptEmbedding?.reason || null,
        candidates: (state.conceptEmbedding?.candidates || []).slice(0, 8)
      },
      temporalState: state.temporalEvidence ? {
        windows: state.temporalEvidence.windows,
        elapsedMs: state.temporalEvidence.elapsedMs,
        revision: state.temporalEvidence.revision,
        liveEvents: (state.temporalEvidence.liveEvents || []).slice(0, 6).map(temporalItem),
        shortTermStates: (state.temporalEvidence.shortTermStates || []).slice(0, 8).map(temporalItem),
        trackTraits: (state.temporalEvidence.trackTraits || []).slice(0, 6).map(temporalItem),
        genreHypotheses: (state.temporalEvidence.genreHypotheses || []).slice(0, 5).map(temporalItem),
        historicalEvents: (state.temporalEvidence.historicalEvents || []).slice(-6).map(temporalItem),
        stale: (state.temporalEvidence.stale || []).slice(0, 6).map(temporalItem),
        contradictions: (state.temporalEvidence.contradictions || []).slice(0, 6).map(temporalItem),
        suppressed: (state.temporalEvidence.suppressed || []).slice(0, 6).map(temporalItem)
      } : null,
      trackContext: {
        memory: (state.temporalEvidence?.trackTraits || []).slice(0, 8).map(item => ({
          text: item.text, category: item.category,
          semanticConfidence: clamp(item.semanticConfidence ?? item.confidence),
          evidenceStatus: item.evidenceStatus || "unknown",
          firstSeenAt: item.provenance?.firstSeenAt ?? null,
          lastSeenAt: item.provenance?.lastSeenAt ?? null
        })),
        semanticEpoch: state.semanticEpoch || 0
      },
      genreFamily: genre.family || "Unknown",
      primaryGenre: genre.uncertain ? null : genre.primary || null,
      subgenreCandidates: (state.genreReasoning?.actualSubgenres || genre.fineCandidates || [])
        .map(item => typeof item === "string" ? item : item?.label)
        .filter(Boolean).slice(0, 4),
      relatedGenres: (state.genreReasoning?.relatedGenres || genre.relatedCandidates || [])
        .map(item => ({ label: item.label || item.genre || item, confidence: clamp(item.confidence ?? item.semanticConfidence) }))
        .filter(item => item.label).slice(0, 8),
      alternativeHypotheses: (state.genreReasoning?.alternatives || []).slice(0, 8).map(item => ({
        label: item.genre, semanticConfidence: clamp(item.semanticConfidence),
        temporalStability: clamp(item.temporalStability), evidenceCoverage: clamp(item.evidenceCoverage)
      })),
      genreReasoning: state.genreReasoning ? {
        primary: state.genreReasoning.primary ? {
          label: state.genreReasoning.primary.genre,
          semanticConfidence: clamp(state.genreReasoning.primary.semanticConfidence),
          temporalStability: clamp(state.genreReasoning.primary.temporalStability),
          evidenceCoverage: clamp(state.genreReasoning.primary.evidenceCoverage),
          independentEvidenceCount: state.genreReasoning.primary.independentEvidenceCount,
          kind: state.genreReasoning.primary.kind,
          evidenceGroups: state.genreReasoning.primary.evidenceGroups || {},
          supportingEvidence: (state.genreReasoning.primary.supportingEvidence || []).slice(0, 8).map(item => ({
            group: item.group, path: item.path, value: item.value, label: item.label
          })),
          contradictingEvidence: (state.genreReasoning.primary.contradictingEvidence || []).slice(0, 6)
        } : null,
        challengers: (state.genreReasoning.challengers || []).slice(0, 5).map(item => ({
          label: item.genre, semanticConfidence: clamp(item.semanticConfidence),
          temporalStability: clamp(item.temporalStability), evidenceCoverage: clamp(item.evidenceCoverage),
          independentEvidenceCount: item.independentEvidenceCount,
          evidenceGroups: item.evidenceGroups || {},
          supportingEvidence: (item.supportingEvidence || []).slice(0, 5).map(evidence => ({
            group: evidence.group, path: evidence.path, value: evidence.value, label: evidence.label
          })),
          contradictingEvidence: (item.contradictingEvidence || []).slice(0, 4)
        })),
        relations: (state.genreReasoning.relations || []).slice(0, 8).map(item => ({
          text: item.text, relationType: item.relationType, relationTarget: item.relationTarget,
          confidence: clamp(item.confidence), anchors: (item.anchors || []).slice(0, 5)
        })),
        rejectedHypotheses: (state.genreReasoning.rejectedHypotheses || []).slice(0, 6).map(item => ({
          label: item.genre, reason: item.reason, evidenceCoverage: clamp(item.evidenceCoverage),
          independentEvidenceCount: item.independentEvidenceCount,
          contradictingEvidence: (item.contradictingEvidence || []).slice(0, 3)
        })),
        pendingChallenger: state.genreReasoning.pendingChallenger || null,
        takeovers: (state.genreReasoning.takeovers || []).slice(-8)
      } : null,
      confidence: Math.round(clamp(genre.semanticConfidence ?? genre.confidence) * 100) / 100,
      semanticConfidence: Math.round(clamp(genre.semanticConfidence ?? genre.confidence) * 100) / 100,
      temporalStability: Math.round(clamp(genre.temporalStability ?? genre.stability) * 100) / 100,
      genreEvidence: [
        ...(!genre.uncertain && genre.primary ? [{ label: genre.primary, confidence: clamp(genre.semanticConfidence ?? genre.confidence) }] : []),
        ...(genre.secondary || []).filter(item => item?.label && Number.isFinite(item.confidence)).slice(0, 3)
      ],
      measurements: Object.fromEntries(Object.entries(state.expressionFeatures || {}).filter(([key, value]) =>
        !["sampledAt", "measuredAt"].includes(key) && (typeof value === "number" || value === null || key === "chroma"))),
      analysisWindow: state.analysisWindow || {},
      moodDimensions: state.moodDimensions || state.mood?.fused || {},
      rhythm: {
        tempo: tempo(character.rhythm?.bpm || state.audio?.bpm),
        pulseRegularity: level(character.rhythm?.pulseRegularity),
        onsetDensity: level(character.rhythm?.onsetDensity),
        complexity: level(character.rhythm?.rhythmicComplexity),
        brokenPulse: level(character.rhythm?.breakbeatLikelihood)
      },
      harmony: {
        tonalFocus: level(character.harmony?.tonalness),
        harmonicMotion: level(character.harmony?.harmonicMotion),
        pitchUncertainty: level(character.harmony?.chromaEntropy)
      },
      timbre: {
        brightness: level(character.timbre?.brightness),
        warmth: level(character.timbre?.warmth),
        roughness: level(character.timbre?.roughness),
        noisiness: level(character.timbre?.noisiness),
        transientEdge: level(character.timbre?.transientSharpness)
      },
      texture: {
        density: level(character.texture?.density),
        sustain: level(character.texture?.sustainedness),
        granularity: level(character.texture?.granularness),
        layeredness: level(character.texture?.layeredness)
      },
      dynamics: {
        range: level(character.dynamics?.dynamicRange),
        compression: level(character.dynamics?.compressionDensity),
        pumping: level(character.dynamics?.pumping)
      },
      space: {
        spaciousness: level(character.space?.spaciousness),
        depth: level(character.space?.perceivedDepth)
      },
      production: {
        subWeight: level(character.production?.subWeight),
        saturation: level(character.production?.saturation),
        cleanVsLoFi: level(character.production?.cleanLoFi),
        masterBrightness: level(character.production?.masterBrightness)
      },
      mood: moodLabels(state),
      currentSection: {
        state: state.novelty?.transitionDetected ? "transition" : clamp(state.novelty?.score) > 0.55 ? "changing" : "stable",
        novelty: level(state.novelty?.score),
        buildup: level(character.structure?.buildupLikelihood),
        breakdown: level(character.structure?.breakdownLikelihood),
        repetition: level(character.structure?.repetition)
      },
      distinctive: distinctiveness || {
        basis: "absolute character only",
        genreRelativeAvailable: false,
        statements: salientStatements(character)
      }
    };
    if (state.verifiedClaims?.items) {
      snapshot.verifiedClaims = {
        items: state.verifiedClaims.items.slice(0, 10).map(item => ({
          id: item.id, type: item.type, concept: item.concept,
          confidence: clamp(item.confidence), evidence: (item.evidence || []).slice(0, 6)
        })),
        licensed: [...(state.verifiedClaims.licensed instanceof Set
          ? state.verifiedClaims.licensed : state.verifiedClaims.licensed || [])].slice(0, 24),
        capsule: state.verifiedClaims.capsule || null
      };
    }
    if (!Object.keys(snapshot.rhythmGrammarDiagnostics || {}).length) delete snapshot.rhythmGrammarDiagnostics;
    if (!state.genreReasoning) {
      delete snapshot.genreReasoning;
      delete snapshot.relatedGenres;
      delete snapshot.alternativeHypotheses;
    }
    if (!state.temporalEvidence) delete snapshot.trackContext.memory;
    if (!Number.isFinite(genre.semanticConfidence)) delete snapshot.semanticConfidence;
    if (!Number.isFinite(genre.temporalStability)) delete snapshot.temporalStability;
    snapshot.fingerprint = stableFingerprint(snapshot);
    return snapshot;
  }

  const DELTA_ROOTS = new Set(["measurements", "moodDimensions", "rhythmicGrammar", "productionEvidence",
    "performance", "arrangement", "primitives", "detectedIdioms", "impressionConcepts", "primaryGenre",
    "genreFamily", "currentSection"]);
  function flatten(value, prefix = "", output = {}) {
    if (value === null || value === undefined || typeof value !== "object") {
      if (prefix) output[prefix] = value;
      return output;
    }
    if (Array.isArray(value)) {
      output[prefix] = value.map(item => item?.id || item?.text || item?.label || item).slice(0, 12);
      return output;
    }
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, output);
    return output;
  }
  function delta(previous = {}, current = {}, limit = 48) {
    const before = flatten(Object.fromEntries(Object.entries(previous).filter(([root]) => DELTA_ROOTS.has(root))));
    const after = flatten(Object.fromEntries(Object.entries(current).filter(([root]) => DELTA_ROOTS.has(root))));
    const changes = [];
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const left = before[path], right = after[path];
      if (typeof left === "number" && typeof right === "number") {
        const amount = right - left;
        if (Math.abs(amount) < (/bpm|tempo/.test(path) ? 2 : 0.05)) continue;
        changes.push({ path, before: left, current: right, delta: Number(amount.toFixed(4)), magnitude: Math.abs(amount) });
      } else if (JSON.stringify(left) !== JSON.stringify(right)) {
        changes.push({ path, before: left ?? null, current: right ?? null, magnitude: 1 });
      }
    }
    changes.sort((a, b) => b.magnitude - a.magnitude || a.path.localeCompare(b.path));
    return { from: previous.fingerprint || null, to: current.fingerprint || null,
      changes: changes.slice(0, Math.max(1, limit)).map(({ magnitude, ...item }) => item) };
  }
  function stableContext(snapshot = {}) {
    return {
      genre: snapshot.primaryGenre ? [snapshot.primaryGenre, snapshot.confidence] : null,
      family: snapshot.genreFamily || "Unknown",
      idioms: (snapshot.detectedIdioms || []).slice(0, 8).map(item => [item.text, item.confidence, item.anchors]),
      impressions: (snapshot.impressionConcepts || []).slice(0, 5).map(item => [item.id, item.text, item.confidence, item.anchors]),
      instruments: (snapshot.instrumentation?.observed || []).slice(0, 6).map(item => [item.id || item.label, item.confidence]),
      section: snapshot.currentSection?.state || "unknown"
    };
  }

  return { serialize, level, stableFingerprint, salientStatements, DistinctivenessTracker, delta, stableContext };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SemanticSnapshot;
