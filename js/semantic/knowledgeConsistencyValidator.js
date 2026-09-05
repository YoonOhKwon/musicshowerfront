// Static integrity checks for the evidence -> primitive -> idiom -> language chain.
// It reports disabled optional detectors separately from broken or mathematically unreachable rules.
const KnowledgeConsistency = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const primitivePathSet = schema => new Set(Object.entries(schema || {})
    .flatMap(([group, fields]) => (fields || []).map(field => `${group}.${field}`)));
  const deltaPath = path => /(?:Delta|Trajectory|Slope)$/.test(path) || /densityDelta/.test(path) ||
    /groovePushPull|spectralSlope|spectralTilt|harmonicMotionDirection|melodicDirection/.test(path);
  const countPath = path => /(?:tempo|Count|voiceCount|layerCount|pitchSetBreadth|cyclicLength|phraseLength|accentPeriodicity)$/.test(path);
  const rangeFor = path => {
    if (deltaPath(path)) return { min: -1, max: 1 };
    if (/(?:tempo|bpm)$/i.test(path)) return { min: 0, max: 400 };
    if (/onsetRate$/i.test(path)) return { min: 0, max: 32 };
    if (countPath(path)) return { min: 0, max: 64 };
    if (/subdivisionRatio|swingRatio|densityPerPulse/.test(path)) return { min: 0, max: 8 };
    return { min: 0, max: 1 };
  };
  const issue = (severity, code, message, detail = {}) => ({ severity, code, message, ...detail });
  // Not every warning is equally urgent (section 17). Codes not listed here keep whatever severity
  // issue() gave them (error/warning); this only RAISES a subset to "high" or DEMOTES a subset to
  // "info", it never turns a real error into a warning.
  const SEVERITY_TIER = Object.freeze({
    "idiom-requires-declared-only": "high", "genre-name-without-context-gate": "high",
    "context-mode-required-without-gate": "high", "context-mode-contradicts-gate": "high",
    "optional-detector-disabled": "info", "dormant-idiom": "info",
    "unused-primitive": "warning", "narrow-detector-headroom": "warning", "graph-scale": "warning"
  });
  const withTier = list => list.map(entry => ({ ...entry, severity: SEVERITY_TIER[entry.code] || entry.severity }));
  // A phrase whose own wording names a genre/tradition (Synthwave, Big Band, French House...)
  // must never fire on generic shared evidence alone -- it needs a requiredContext gate (section
  // 2). This check is what stops a future genre-loaded idiom from silently reintroducing leakage.
  const GENRE_NAME_PATTERN = new RegExp([
    "신스웨이브", "시티팝", "빅밴드", "개러지", "퓨처펑크", "바로크", "디스코", "테크노(?!\\s?스타일)", "트랜스",
    "바이퍼웨이브", "포크", "힙합", "고스펠", "글리치", "정글", "드림팝", "슈게이즈",
    // Tradition-bound PRACTICE names, not genre names: no detector can measure "improvisation"
    // or "comping" from a mixed signal, so a phrase that asserts one is a contextual
    // specialization of some measured texture -- it needs the same gate a genre name needs.
    "즉흥", "컴핑",
    "Synthwave", "French House", "Big Band", "Bebop", "Vaporwave", "Choral", "Baroque", "Dixieland"
  ].join("|"));
  const CONTEXT_MODES = new Set(["REQUIRED", "MULTIPLIER"]);
  // Section 2-3: contextMode is a declared contract, so it must be enforced rather than
  // decorative. REQUIRED means genre context is a second independent gate; MULTIPLIER means it
  // only nudges confidence. A genre/tradition-named phrase may never settle for MULTIPLIER.
  function validateGenreNaming(lexicon = {}) {
    const issues = [];
    for (const entry of lexicon.entries || []) {
      const genreNamed = GENRE_NAME_PATTERN.test(entry.neutralText || "");
      if (entry.contextMode && !CONTEXT_MODES.has(entry.contextMode))
        issues.push(issue("error", "context-mode-invalid",
          `Rule ${entry.id} declares unknown contextMode "${entry.contextMode}".`, { ruleId: entry.id }));
      if (entry.contextMode === "REQUIRED" && !entry.requiredContext)
        issues.push(issue("warning", "context-mode-required-without-gate",
          `Rule ${entry.id} declares contextMode REQUIRED but carries no requiredContext gate.`, { ruleId: entry.id }));
      if (entry.requiredContext && entry.contextMode && entry.contextMode !== "REQUIRED")
        issues.push(issue("warning", "context-mode-contradicts-gate",
          `Rule ${entry.id} has a requiredContext gate but declares contextMode ${entry.contextMode}.`, { ruleId: entry.id }));
      if (genreNamed && !entry.requiredContext) {
        issues.push(issue("warning", "genre-name-without-context-gate",
          `Rule ${entry.id} names a genre/tradition in "${entry.neutralText}" but has no requiredContext gate.`,
          { ruleId: entry.id }));
      }
    }
    return issues;
  }
  const CONTEXT_PATHS = new Set([
    "aestheticEvidence.kawaii", "aestheticEvidence.magicalGirl",
    ...["acousticguitar", "bass", "drums", "electricguitar", "guitar", "percussion", "piano", "saxophone", "strings", "synthesizer", "voice"]
      .map(field => `instrumentationEvidence.${field}`),
    ...["bass", "bpm", "flatness", "harmonicMovement", "onsetRate", "tempoStability", "tonalFocus", "transientDensity"]
      .map(field => `measurements.${field}`),
    ...["aggression", "brightness", "spaciousness", "warmth"].map(field => `moodDimensions.${field}`),
    ...["sampleBased", "sidechain"].map(field => `productionEvidence.${field}`),
    ...["brokenBeat", "fourOnFloor", "swing", "syncopation"].map(field => `rhythmicGrammar.${field}`)
  ]);

  function validateCondition(test, entry, paths) {
    const issues = [];
    if (!test || typeof test.path !== "string" || !test.path) {
      issues.push(issue("error", "condition-path-missing", `Rule ${entry.id} has a condition without a path.`, { ruleId: entry.id }));
      return issues;
    }
    if (!paths.has(test.path)) issues.push(issue("error", "primitive-path-missing",
      `Rule ${entry.id} references unknown primitive ${test.path}.`, { ruleId: entry.id, path: test.path }));
    if (Number.isFinite(test.min) && Number.isFinite(test.max) && test.min > test.max)
      issues.push(issue("error", "inverted-range", `Rule ${entry.id} has min > max for ${test.path}.`, { ruleId: entry.id, path: test.path }));
    const range = rangeFor(test.path);
    if (Number.isFinite(test.min) && test.min > range.max)
      issues.push(issue("error", "unreachable-min", `Rule ${entry.id} requires ${test.path} >= ${test.min}, above detector range ${range.max}.`,
        { ruleId: entry.id, path: test.path, threshold: test.min, detectorMax: range.max }));
    if (Number.isFinite(test.max) && test.max < range.min)
      issues.push(issue("error", "unreachable-max", `Rule ${entry.id} requires ${test.path} <= ${test.max}, below detector range ${range.min}.`,
        { ruleId: entry.id, path: test.path, threshold: test.max, detectorMin: range.min }));
    return issues;
  }

  function validateLexicon(lexicon = {}, primitiveSchema = {}) {
    const paths = primitivePathSet(primitiveSchema);
    const issues = [];
    const ids = new Set();
    for (const entry of lexicon.entries || []) {
      if (!entry.id || ids.has(entry.id)) issues.push(issue("error", "duplicate-rule-id",
        `Idiom rule id is missing or duplicated: ${entry.id || "(missing)"}.`, { ruleId: entry.id }));
      ids.add(entry.id);
      if (!entry.neutralText) issues.push(issue("error", "neutral-realization-missing",
        `Rule ${entry.id} has no genre-neutral realization.`, { ruleId: entry.id }));
      const required = entry.required || entry.match || [];
      if (!required.length) issues.push(issue("error", "required-evidence-missing",
        `Rule ${entry.id} has no required musical evidence.`, { ruleId: entry.id }));
      const all = [...required, ...(entry.supporting || []), ...(entry.contradicting || entry.excludes || [])];
      for (const test of all) issues.push(...validateCondition(test, entry, paths));
      for (const anchor of entry.anchors || []) if (!paths.has(anchor)) issues.push(issue("error", "anchor-path-missing",
        `Rule ${entry.id} has unknown anchor ${anchor}.`, { ruleId: entry.id, path: anchor }));
      const byPath = new Map();
      for (const test of required) {
        const previous = byPath.get(test.path);
        if (previous && Number.isFinite(previous.min) && Number.isFinite(test.max) && previous.min > test.max)
          issues.push(issue("error", "conflicting-required-evidence", `Rule ${entry.id} contains conflicting conditions for ${test.path}.`,
            { ruleId: entry.id, path: test.path }));
        byPath.set(test.path, { ...(previous || {}), ...test });
      }
    }
    return issues;
  }

  function validateDetectorRules(rules = [], capabilities = {}) {
    const issues = [];
    for (const rule of rules) {
      const capability = capabilities[rule.path];
      if (!capability) {
        issues.push(issue("error", "detector-capability-missing", `No detector capability is declared for ${rule.path}.`,
          { ruleId: rule.id, path: rule.path }));
        continue;
      }
      if (capability.available === false) {
        issues.push(issue("warning", "optional-detector-disabled", `${rule.id} is dormant because ${rule.path} is not installed.`,
          { ruleId: rule.id, path: rule.path }));
        continue;
      }
      if (Number.isFinite(rule.min) && Number.isFinite(capability.max)) {
        if (rule.min > capability.max) issues.push(issue("error", "unreachable-detector-rule",
          `${rule.id} requires ${rule.min}, but ${rule.path} can reach only ${capability.max}.`,
          { ruleId: rule.id, path: rule.path, threshold: rule.min, detectorMax: capability.max }));
        else if (capability.max - rule.min <= 0.05) issues.push(issue("warning", "narrow-detector-headroom",
          `${rule.id} has only ${(capability.max - rule.min).toFixed(2)} confidence headroom.`,
          { ruleId: rule.id, path: rule.path, threshold: rule.min, detectorMax: capability.max }));
      }
    }
    return issues;
  }

  function validateContextKnowledge(knowledge = {}, detectorCapabilities = {}) {
    const issues = [];
    function walk(value, location = "context") {
      if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${location}.${index}`));
      if (!value || typeof value !== "object") return;
      if (typeof value.path === "string") {
        if (!CONTEXT_PATHS.has(value.path)) issues.push(issue("error", "context-path-missing",
          `${location} references unknown evidence path ${value.path}.`, { path: value.path, location }));
        const capability = detectorCapabilities[value.path] || rangeFor(value.path);
        if (capability.available === false) issues.push(issue("warning", "context-detector-disabled",
          `${location} depends on disabled detector ${value.path}.`, { path: value.path, location }));
        if (Number.isFinite(value.min) && Number.isFinite(capability.max) && value.min > capability.max)
          issues.push(issue("error", "unreachable-context-rule",
            `${location} requires ${value.path} >= ${value.min}, above ${capability.max}.`,
            { path: value.path, location, threshold: value.min, detectorMax: capability.max }));
        if (Number.isFinite(value.max) && Number.isFinite(capability.min) && value.max < capability.min)
          issues.push(issue("error", "unreachable-context-rule",
            `${location} requires ${value.path} <= ${value.max}, below ${capability.min}.`,
            { path: value.path, location, threshold: value.max, detectorMin: capability.min }));
      }
      for (const [key, child] of Object.entries(value)) walk(child, `${location}.${key}`);
    }
    walk(knowledge);
    return issues;
  }

  function validate({ lexicon = {}, primitiveSchema = {}, detectorRules = [], detectorCapabilities = {},
    contextKnowledge = null, graph = null, graphScale = { min: 300, max: 2000 }, primitiveClassification = {},
    impressionRules = [], directConsumerPaths = [] } = {}) {
    const rawIssues = [...validateLexicon(lexicon, primitiveSchema), ...validateDetectorRules(detectorRules, detectorCapabilities),
      ...(contextKnowledge ? validateContextKnowledge(contextKnowledge, detectorCapabilities) : []),
      ...validateGraphConsumers(graph, { primitiveSchema, classification: primitiveClassification, lexicon, impressionRules,
        directConsumerPaths }),
      ...validateGenreNaming(lexicon)];
    if (graph && (graph.stats?.nodes < graphScale.min || graph.stats?.nodes > graphScale.max)) rawIssues.push(issue("warning", "graph-scale",
      `Compiled knowledge graph has ${graph.stats?.nodes || 0} nodes; target is ${graphScale.min}–${graphScale.max}.`, { nodes: graph.stats?.nodes || 0 }));
    // Section 17: errors stop the build; "high" warnings are urgent knowledge-model problems
    // (a dead idiom, a genre-loaded phrase with no context gate); plain warnings are coverage
    // gaps worth knowing about; info is just "this optional detector isn't wired up yet".
    const issues = withTier(rawIssues);
    const errors = issues.filter(item => item.severity === "error");
    const highWarnings = issues.filter(item => item.severity === "high");
    const warnings = issues.filter(item => item.severity === "warning");
    const info = issues.filter(item => item.severity === "info");
    // Section 16: every consumer (CI, the coverage report, the tests) must read the SAME counts
    // from the SAME object. Recomputing them per call site is what let `npm run check` and
    // `knowledge-coverage` disagree about dead idioms in the first place.
    const warningsByCode = {};
    for (const item of issues) if (item.severity !== "error") warningsByCode[item.code] = (warningsByCode[item.code] || 0) + 1;
    const entries = lexicon.entries || [];
    const dormant = entries.filter(entry => entry.status === "dormant");
    return { ok: errors.length === 0, checkedAt: Date.now(), errors, highWarnings, warnings, info, issues, warningsByCode,
      countsBySeverity: { error: errors.length, high: highWarnings.length, warning: warnings.length, info: info.length },
      stats: { rules: entries.length, activeRules: entries.length - dormant.length, dormantRules: dormant.length,
        primitivePaths: primitivePathSet(primitiveSchema).size,
        detectorRules: detectorRules.length, directConsumers: directConsumerPaths.length, contextKnowledge: Boolean(contextKnowledge),
        graphNodes: graph?.stats?.nodes || 0, graphEdges: graph?.stats?.edges || 0 } };
  }

  // Hand-classified from reading musicalPrimitiveEngine.js's actual formulas — not inferred from
  // naming. REAL_DETECTOR: reads a value a real upstream DSP/ML/onset-analysis stage computed
  // directly (even if that computation lives in another file, e.g. rhythmicGrammar.js). DERIVED:
  // a formula that only combines/buckets other already-real values. Anything not listed here is
  // classified purely by empirical availability (see classifyPrimitives) — unlisted + available
  // defaults to DERIVED, the conservative bucket, rather than being guessed as REAL_DETECTOR.
  const REAL_DETECTOR_PATHS = new Set([
    "pulse.tempo", "pulse.tempoStability", "pulse.pulseRegularity", "pulse.subdivisionRatio",
    "pulse.swingRatio", "pulse.shuffleStrength", "pulse.syncopation", "pulse.offbeatActivity",
    "pulse.accentPeriodicity", "pulse.accentPlacement", "pulse.accentDisplacement", "pulse.metricStability",
    "pulse.onsetDensity", "pulse.breakDensity", "pulse.kickPeriodicity", "pulse.rhythmicRepetition",
    "pulse.rhythmicVariation", "pulse.halfTimeLikelihood", "pulse.doubleTimeLikelihood",
    "pulse.microTimingDeviation", "pulse.groovePushPull", "pulse.rhythmicEntropy",
    "bass.bassPresence", "bass.walkingLikelihood", "bass.bassMotion", "bass.repetition",
    "texture.voiceCount", "texture.dominanceDispersion", "texture.sustainRatio",
    "role.leadPresence", "role.leadTransitionRate", "role.foundationLayer",
    "tonal.tonalFocus", "tonal.harmonicRhythm", "tonal.pitchSetBreadth", "tonal.melodicContourRange",
    "harmony.tonalCenter", "harmony.keyConfidence", "harmony.majorMinorLikelihood", "harmony.chromaticity",
    "harmony.bassMotion", "harmony.tonalAmbiguity",
    // Measured by js/mir/harmonicMotionEngine directly from the chroma SEQUENCE (section 4).
    "harmony.chordChangeRate", "harmony.harmonicRhythm", "harmony.harmonicStability",
    "harmony.harmonicRepetition", "harmony.harmonicMotionDirection", "harmony.harmonicDensity",
    "harmony.cadenceStrength", "harmony.modality", "harmony.modeConfidence", "harmony.modalLikelihood",
    "harmony.modalAmbiguity", "harmony.majorMinorDeviation",
    // Measured by js/mir/melodyContourEngine from the predominant-pitch trajectory (sections 5-6).
    "melody.melodicContour", "melody.melodicDirection", "melody.melodicRange", "melody.averageInterval",
    "melody.intervalVariance", "melody.stepwiseMotion", "melody.leapLikelihood", "melody.motifStrength",
    "melody.motifRecurrence", "melody.melodicRepetition", "melody.sequenceLikelihood",
    "melody.phraseLength", "melody.phraseRegularity", "melody.callResponseLikelihood",
    "melody.melodicDensity", "melody.contourSlope",
    "articulation.attackSharpness", "articulation.transientSoftness", "articulation.noteLengthRatio",
    "articulation.dynamicAccentRange",
    "instrument.presenceConfidence", "instrument.dominanceConfidence", "instrument.entryLikelihood",
    "instrument.exitLikelihood", "instrument.soloLikelihood", "instrument.compingLikelihood",
    "form.repetitionDepth", "form.sectionNovelty", "form.buildupSlope", "form.releaseDepth",
    "form.dropLikelihood", "form.density", "form.densityDelta", "form.energyTrajectory",
    "production.brightness", "production.warmth", "production.roughness", "production.noisiness",
    "production.spectralSlope", "production.spectralTilt", "production.spectralFlux",
    "production.transientSharpness", "production.lowEndWeight", "production.stereoWidth",
    "production.compressionLikelihood", "production.pumpingLikelihood", "production.periodicDucking",
    "production.saturationLikelihood", "production.distortionLikelihood", "production.reverbTail",
    "production.roomSize", "production.delayDensity", "production.filterMotion",
    "production.granularity", "production.sampleBasedLikelihood", "production.spatialDepth",
    "arrangement.density", "arrangement.densityDelta", "arrangement.verifiedEnsembleSize"
  ]);

  // Samples must be MusicalPrimitives.analyze() outputs (the object carrying `.meta`), not raw
  // state — call sites pass in real fixture-derived analyses, never hypothetical values.
  function classifyPrimitives(schema, primitiveSamples = []) {
    const paths = [...primitivePathSet(schema)];
    const result = {};
    for (const path of paths) {
      const available = primitiveSamples.some(sample => sample?.meta?.[path]?.available === true);
      result[path] = !available ? "DECLARED_ONLY" : REAL_DETECTOR_PATHS.has(path) ? "REAL_DETECTOR" : "DERIVED";
    }
    return result;
  }

  function summarizeClassification(classification) {
    const summary = { REAL_DETECTOR: 0, DERIVED: 0, DECLARED_ONLY: 0 };
    for (const state of Object.values(classification)) summary[state] = (summary[state] || 0) + 1;
    return summary;
  }

  // The two consumer-direction checks the spec calls out as "특히 중요":
  // (a) unused-primitive — a real/derived detector no idiom's required/supporting/contradicting
  //     evidence ever cites, a dead capability worth spending idiom-authoring effort on.
  // (b) idiom-requires-declared-only — an idiom's REQUIRED evidence cites a primitive path that is
  //     currently DECLARED_ONLY (schema exists, no fixture ever populates it): that idiom can
  //     mathematically never fire until a real detector is built for that path.
  // Impression rules read primitives directly (`primitives.<group>.<field>`) but are not compiled
  // into the idiom graph, so they were invisible to the consumer check -- a primitive an impression
  // depends on was still reported as unused.
  function impressionConsumers(impressionRules = []) {
    const paths = new Set();
    for (const rule of impressionRules) for (const condition of rule?.requires || []) {
      const path = String(condition?.path || "");
      if (!path.startsWith("primitives.")) continue;
      const parts = path.slice("primitives.".length).split(".");
      if (parts.length >= 2) paths.add(`${parts[0]}.${parts[1]}`);
    }
    return paths;
  }

  function validateGraphConsumers(graph = null, { primitiveSchema = {}, classification = {}, lexicon = {},
    impressionRules = [], directConsumerPaths = [] } = {}) {
    if (!graph) return [];
    const issues = [];
    const allPaths = primitivePathSet(primitiveSchema);
    const impressionPaths = impressionConsumers(impressionRules);
    const directPaths = new Set(directConsumerPaths);
    // A dormant idiom is knowledge we deliberately keep but do not fire (section 3-C). It must
    // not be counted as a dead ACTIVE idiom, and it must not make a primitive look consumed.
    const dormantIds = new Set((lexicon.entries || []).filter(entry => entry.status === "dormant").map(entry => `idiom:${entry.id}`));
    const referenced = new Set(graph.edges.filter(edge => edge.from?.startsWith("primitive:") && !dormantIds.has(edge.to))
      .map(edge => edge.from.slice("primitive:".length)));
    for (const path of allPaths) {
      // DECLARED_ONLY is a documented future capability, not wasted computed data. The unused
      // warning is reserved for real/derived producer output that has no language consumer.
      if (classification[path] === "DECLARED_ONLY") continue;
      if (referenced.has(path) || impressionPaths.has(path) || directPaths.has(path)) continue;
      issues.push(issue("warning", "unused-primitive", `${path} has no active idiom or impression consumer.`, { path }));
    }
    const reportedDormant = new Set();
    for (const edge of graph.edges) {
      if (edge.relation !== "required-evidence" || !edge.from?.startsWith("primitive:")) continue;
      const path = edge.from.slice("primitive:".length);
      if (classification[path] !== "DECLARED_ONLY") continue;
      if (dormantIds.has(edge.to)) {
        if (reportedDormant.has(edge.to)) continue;
        reportedDormant.add(edge.to);
        issues.push(issue("warning", "dormant-idiom",
          `${edge.to} is dormant: it waits for a real detector on ${path}.`, { path, ruleId: edge.to }));
        continue;
      }
      issues.push(issue("warning", "idiom-requires-declared-only",
        `${edge.to} requires ${path}, which has no real detector yet — it can never fire.`, { path, ruleId: edge.to }));
    }
    return issues;
  }

  function coverageReport(graph = null, lexicon = {}, { impressionRules = [], directConsumerPaths = [] } = {}) {
    if (!graph) return { byPrimitive: {}, byGenre: {}, orphanPrimitives: [] };
    const impressionPaths = impressionConsumers(impressionRules);
    const directPaths = new Set(directConsumerPaths);
    const idiomEdgesByPrimitive = new Map();
    for (const edge of graph.edges) {
      if (!edge.to?.startsWith("idiom:") || !edge.from?.startsWith("primitive:")) continue;
      const path = edge.from.slice("primitive:".length);
      idiomEdgesByPrimitive.set(path, (idiomEdgesByPrimitive.get(path) || new Set()).add(edge.to));
    }
    const byPrimitive = Object.fromEntries([...idiomEdgesByPrimitive.entries()]
      .map(([path, idioms]) => [path, idioms.size]).sort((a, b) => b[1] - a[1]));
    const orphanPrimitives = graph.nodes.filter(node => node.type === "primitive" &&
      !idiomEdgesByPrimitive.has(node.path) && !impressionPaths.has(node.path) && !directPaths.has(node.path)).map(node => node.path);
    const byGenre = {};
    for (const entry of lexicon.entries || []) {
      const genres = new Set([...(entry.contextMultipliers || []).flatMap(rule => rule.genreFamilies || rule.genres || []),
        ...(entry.specializations || []).flatMap(spec => spec.genreFamilies || [])]);
      for (const genre of genres) byGenre[genre] = (byGenre[genre] || 0) + 1;
    }
    return { byPrimitive, byGenre, orphanPrimitives, directConsumerPaths: [...directPaths] };
  }

  function validateClaimArchitecture({ factTerms = [], phrases = [], claims = [] } = {}) {
    const issues = [];
    for (const term of factTerms) {
      if (!term?.concept || !term?.pattern)
        issues.push(issue("error", "fact-firewall-unmapped", "Fact Firewall term is missing a concept or pattern."));
    }
    const known = new Set(claims.map(item => item.id || item.concept));
    for (const phrase of phrases) {
      for (const claimId of phrase.claimsUsed || []) {
        if (known.size && !known.has(claimId) && ![...known].some(id => String(id).includes(String(claimId))))
          issues.push(issue("error", "phrase-unknown-claim",
            `Phrase "${phrase.text}" references unknown claim ${claimId}.`, { text: phrase.text, claimId }));
      }
    }
    return issues;
  }

  // Section 3: category-word conventions on genreContextKnowledge.json-shaped candidates
  // (existing hand-authored entries AND anything scripts/author-vocabulary.mjs later proposes
  // for the same file) -- "era" reads as a period/style reference, never a bare year (that is
  // ALSO enforced at generation time by semanticFacets.js's safeText(), this is a static check on
  // the DATA itself), "scene" reads as a scene/culture, never a bare noun.
  const ERA_SUFFIX = /(?:년대|스타일|계열)$/;
  const SCENE_SUFFIX = /(?:씬|문화)$/;
  function validateCategorySuffix(knowledge = {}) {
    const issues = [];
    function walkCandidates(list, location) {
      for (const [index, candidate] of (list || []).entries()) {
        if (!candidate || typeof candidate.text !== "string") continue;
        const where = `${location}[${index}] ("${candidate.text}")`;
        if (candidate.category === "era" && !ERA_SUFFIX.test(candidate.text))
          issues.push(issue("warning", "era-suffix-convention",
            `${where} is categorized "era" but does not end in 년대/스타일/계열.`, { text: candidate.text, location }));
        if (candidate.category === "scene" && !SCENE_SUFFIX.test(candidate.text))
          issues.push(issue("warning", "scene-suffix-convention",
            `${where} is categorized "scene" but does not end in 씬/문화.`, { text: candidate.text, location }));
      }
    }
    for (const [name, entry] of Object.entries(knowledge.genres || {})) walkCandidates(entry.candidates, `genres.${name}.candidates`);
    for (const [name, entry] of Object.entries(knowledge.families || {})) walkCandidates(entry.candidates, `families.${name}.candidates`);
    return issues;
  }

  // Section 3: static checks on an offline-authored, not-yet-reviewed vocabulary batch
  // (scripts/author-vocabulary.mjs's output, data/aestheticVocabulary.generated.json). Failing
  // entries are reported, never auto-dropped -- a human decides what ships (docs/VOCABULARY_AUTHORING.md).
  function validateGeneratedVocabulary(generated = {}, axisNames = []) {
    const issues = [];
    const entries = Array.isArray(generated.entries) ? generated.entries : [];
    const conceptKeys = new Set(entries.map(entry => entry?.conceptKey).filter(Boolean));
    const seenConceptKeys = new Set();
    for (const [index, entry] of entries.entries()) {
      const where = `entries[${index}]`;
      if (!entry || typeof entry.text !== "string" || !entry.text.trim()) {
        issues.push(issue("error", "vocabulary-text-missing", `${where} has no text.`, { location: where }));
        continue;
      }
      if (!["AESTHETIC", "IMPRESSION"].includes(entry.layer))
        issues.push(issue("error", "vocabulary-layer-invalid", `${where} ("${entry.text}") declares layer "${entry.layer}", expected AESTHETIC or IMPRESSION.`,
          { text: entry.text, location: where }));
      const proxyCategory = entry.layer === "IMPRESSION" ? "mood" : "association";
      if (!Facets.safeText(entry.text, proxyCategory))
        issues.push(issue("error", "vocabulary-fails-safe-text", `${where} ("${entry.text}") does not pass safeText() for its layer.`,
          { text: entry.text, location: where }));
      if (!entry.conceptKey || typeof entry.conceptKey !== "string")
        issues.push(issue("error", "vocabulary-concept-key-missing", `${where} ("${entry.text}") has no conceptKey.`, { location: where }));
      else if (seenConceptKeys.has(entry.conceptKey))
        issues.push(issue("error", "vocabulary-concept-key-duplicate", `conceptKey "${entry.conceptKey}" is used by more than one entry.`,
          { conceptKey: entry.conceptKey, location: where }));
      else seenConceptKeys.add(entry.conceptKey);
      const region = Array.isArray(entry.region) ? entry.region : [];
      if (!region.length) issues.push(issue("error", "vocabulary-region-empty", `${where} ("${entry.text}") has no region conditions.`, { location: where }));
      for (const condition of region) {
        if (!condition || !axisNames.includes(condition.axis))
          issues.push(issue("error", "vocabulary-unknown-axis", `${where} ("${entry.text}") references unknown axis "${condition?.axis}".`,
            { text: entry.text, axis: condition?.axis, location: where }));
        if (!Number.isFinite(condition?.min) || condition.min < 0 || condition.min > 1)
          issues.push(issue("error", "vocabulary-region-min-invalid", `${where} ("${entry.text}") has a non-numeric or out-of-range min.`, { location: where }));
      }
      if (!Number.isFinite(entry.minAxes) || entry.minAxes < 1 || entry.minAxes > region.length)
        issues.push(issue("error", "vocabulary-min-axes-invalid",
          `${where} ("${entry.text}") declares minAxes ${entry.minAxes}, outside [1, ${region.length}].`, { location: where }));
      if (!Number.isFinite(entry.clicheRisk) || entry.clicheRisk < 0 || entry.clicheRisk > 1)
        issues.push(issue("warning", "vocabulary-cliche-risk-invalid", `${where} ("${entry.text}") has a non-numeric or out-of-range clicheRisk.`, { location: where }));
      for (const relatedKey of entry.relatedKeys || []) {
        if (!conceptKeys.has(relatedKey))
          issues.push(issue("warning", "vocabulary-related-key-unknown",
            `${where} ("${entry.text}")'s relatedKeys references "${relatedKey}", not a conceptKey in this batch.`,
            { text: entry.text, relatedKey, location: where }));
      }
    }
    return issues;
  }

  return { validate, validateLexicon, validateDetectorRules, validateContextKnowledge, validateGraphConsumers,
    validateGenreNaming, validateClaimArchitecture, validateCategorySuffix, validateGeneratedVocabulary,
    classifyPrimitives, summarizeClassification, coverageReport,
    primitivePathSet, rangeFor, CONTEXT_PATHS, REAL_DETECTOR_PATHS, SEVERITY_TIER };
})();

if (typeof module !== "undefined" && module.exports) module.exports = KnowledgeConsistency;
