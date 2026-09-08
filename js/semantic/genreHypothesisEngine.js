const GenreHypotheses = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const GenreLabels = typeof GenreLabelShape !== "undefined" ? GenreLabelShape : require("./genreLabelShape");
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  const normalize = value => String(value || "").toLowerCase().replace(/[\s_&-]+/g, "");
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const read = (source, path) => String(path || "").split(".").reduce((value, key) =>
    value && Object.hasOwn(value, key) ? value[key] : undefined, source);
  const unique = items => [...new Map(items.map(item => [normalize(item.genre || item.label), item])).values()];
  const evidenceFamily = item => ({
    "genre-classifier": "genreModel", classifierGenre: "genreModel",
    // Music Flamingo listens to the recording itself and is a peer of the classifier head, not a
    // nameless leftover falling through to a source-string split.
    directAudio: "deepListen", "music-flamingo": "deepListen", deepListen: "deepListen",
    directAudioEvidence: "deepListen",
    rhythmicGrammar: "rhythm", rhythm: "rhythm",
    productionEvidence: "production", production: "production",
    instrumentationEvidence: "instrumentation", instrumentation: "instrumentation",
    moodDimensions: "mood", trackCharacter: "trackCharacter"
  })[item?.source] || String(item?.source || item?.path || "unknown").split(".")[0];

  function classifierItems(state = {}) {
    const classifier = state.classifierGenre || state.genre || {};
    const topK = (classifier.topK || []).filter(item => item?.label);
    const primary = classifier.uncertain ? null : classifier.primary;
    const primaryConfidence = clamp(classifier.semanticConfidence ?? classifier.confidence);
    const topRaw = Math.max(0.0001, ...topK.map(item => Number(item.confidence) || 0));
    return topK.map(item => ({
      genre: item.label,
      classifierConfidence: clamp(item.confidence),
      semanticConfidence: item.label === primary
        ? primaryConfidence
        : clamp(primaryConfidence * 0.82 * ((Number(item.confidence) || 0) / topRaw)),
      source: "genre-classifier"
    }));
  }

  function evaluateGroup(group = {}, state = {}, classifier = []) {
    const evidence = [];
    const contradictions = [];
    if (Array.isArray(group.labels) || Array.isArray(group.labelSets)) {
      const sets = Array.isArray(group.labelSets) && group.labelSets.length
        ? group.labelSets : [{ labels: group.labels, minMatches: group.minMatches }];
      const results = sets.map(set => {
        const allowed = new Set((set.labels || []).map(normalize));
        const matches = classifier.filter(item => allowed.has(normalize(item.genre)));
        const minimum = Math.max(1, Number(set.minMatches) || 1);
        return { matches, minimum, matched: matches.length >= minimum,
          score: Math.max(0, ...matches.map(item => item.semanticConfidence)) };
      });
      const matches = unique(results.flatMap(result => result.matches));
      const matched = results.every(result => result.matched);
      const completeness = mean(results.map(result => clamp(result.matches.length / result.minimum)));
      const best = mean(results.map(result => result.score));
      if (matched) evidence.push(...matches.map(item => ({
        path: "classifierGenre.topK", value: item.semanticConfidence, label: item.genre, source: "genre-classifier"
      })));
      return { matched, score: clamp(best * (0.7 + completeness * 0.3)), evidence, contradictions };
    }
    const tests = Array.isArray(group.tests) ? group.tests : [];
    const mode = group.mode === "all" ? "all" : "any";
    const results = tests.map(test => {
      const value = read(state, test.path);
      const resolved = typeof value === "number" && Number.isFinite(value);
      const matched = resolved && value >= (test.min ?? 0) && value <= (test.max ?? 1);
      if (matched) evidence.push({ path: test.path, value, source: test.source || test.path.split(".")[0] });
      else if (resolved && (value < (test.contradictsBelow ?? ((test.min ?? 0) >= 0.5 ? test.min * 0.4 : -Infinity)) ||
        value > (test.contradictsAbove ?? Infinity))) {
        contradictions.push({ path: test.path, value });
      }
      return { resolved, matched, value };
    });
    const matched = tests.length > 0 && (mode === "all" ? results.every(item => item.matched) : results.some(item => item.matched));
    const values = results.filter(item => item.matched).map(item => clamp(item.value));
    return { matched, score: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      evidence, contradictions: matched ? [] : contradictions };
  }

  // Only values proposed in the packet's genre field may become genre identity. Scene and
  // lineage observations remain valuable context, but their labels must never become the HUD's
  // primary genre merely because they happen to have a short genre-like grammatical shape.
  const GENRE_CONCEPT_TYPES = new Set(["genre", "microgenre"]);

  // Does the classifier -- a completely separate model, trained on a fixed 400 styles -- point at
  // the same music as this open-vocabulary name?
  //
  // There is no table of "Future Funk = City Pop + Nu Disco" here, and there must not be. The
  // link comes from what the concept expansion actually learned about THIS name at runtime
  // (its lineage/influence/hybrid relations) plus the parent/child hierarchy. A name nobody has
  // written down anywhere can still be corroborated the moment its lineage is discovered.
  function corroborateWithClassifier(concept, classifier = [], hierarchy = {}) {
    const label = normalize(concept?.canonicalLabel);
    const byName = new Map(classifier.map(item => [normalize(item.genre), item]));
    const exact = byName.get(label) || null;
    const related = new Map();
    const consider = (value, weight) => {
      const key = normalize(value);
      if (!key || key === label) return;
      const hit = byName.get(key);
      if (hit) related.set(key, Math.max(related.get(key) || 0, weight));
    };
    // 1. Relations the world-knowledge expansion discovered for this very concept.
    for (const relation of concept?.relatedLabels || []) {
      const weight = ({ lineage: 1, hybrid: 1, subgenre: 0.9, influence: 0.75 })[relation.relationType] || 0.6;
      consider(relation.label, weight * clamp(relation.confidence ?? 0.5) + 0.35);
    }
    // 2. Parent/child edges, which describe how names relate rather than which are allowed.
    for (const [parent, children] of Object.entries(hierarchy?.children || {})) {
      const childList = (children || []).map(normalize);
      if (normalize(parent) === label) childList.forEach(child => consider(child, 0.8));
      else if (childList.includes(label)) consider(parent, 0.7);
    }
    const matched = [...related.keys()].map(key => byName.get(key)).filter(Boolean);
    if (exact) matched.unshift(exact);
    // Two corroborating labels say more than one, but a third adds little -- this measures
    // agreement, not vote count.
    const strength = matched.length
      ? Math.min(1, mean(matched.map(item => clamp(item.semanticConfidence))) *
        (0.7 + Math.min(2, matched.length - 1) * 0.15) + (exact ? 0.15 : 0))
      : 0;
    return { matched, exact: Boolean(exact), strength,
      bestClassifierConfidence: Math.max(0, ...matched.map(item => item.classifierConfidence || 0)) };
  }

  function relationText(relation = {}) {
    if (relation.text) return relation.text;
    const label = relation.genre;
    return ({
      source: `${label} 계열 소스`, influence: `${label} 영향`, lineage: `${label} 계보`,
      rhythmic_affinity: `${label} 리듬 친화성`, primary: label
    })[relation.type] || `${label} 연관성`;
  }

  class Engine {
    constructor(rules = {}, hierarchy = {}, options = {}) {
      this.rules = rules;
      this.hierarchy = hierarchy;
      this.options = { switchMargin: 0.08, takeoverMs: 2500, minimumCoverage: 0.66,
        minimumIndependentEvidence: 2, initialPromotionMinConfidence: 0.50,
        repeatedPromotionMinConfidence: 0.42, staleMs: 9000, ...options };
      this.reset();
    }

    configure(rules = {}, hierarchy = {}) {
      this.rules = rules;
      this.hierarchy = hierarchy;
    }

    reset() {
      this.primary = null;
      this.pending = null;
      this.history = new Map();
      this.takeovers = [];
    }

    evaluate(state = {}, at = Date.now()) {
      const classifier = classifierItems(state);
      const candidates = classifier.map(item => ({ ...item,
        classifierSemanticConfidence: item.semanticConfidence,
        // One classifier head is one evidence family. It may be stable and useful, but missing
        // rhythm/production/context coverage prevents it from becoming near-certain on its own.
        semanticConfidence: Math.min(0.72, item.semanticConfidence),
        kind: "classifier", evidenceCoverage: 1 / 3,
        independentEvidenceCount: 1, independentEvidenceFamilies: ["genreModel"],
        evidenceGroups: { classifier: { matched: true, score: item.semanticConfidence, required: true } },
        matchedEvidenceGroups: ["classifier"], supportingEvidence: [{ path: "classifierGenre.topK",
          value: item.classifierConfidence, label: item.genre, source: "genre-classifier" }], contradictingEvidence: [] }));

      // Ingest open-world concept hypotheses from OpenWorldConceptRegistry or state.
      // Only genre-shaped concept types: `all({compact:true})` returns every type the registry
      // holds, and an aesthetic like "ethereal soundscapes" can pass a label-shape check without
      // ever having been proposed as a genre.
      const openWorldItems = (Array.isArray(state.openWorldConcepts)
        ? state.openWorldConcepts
        : (state.openWorldRegistry?.byType ? state.openWorldRegistry.byType("genre") : []))
        .filter(item => !item?.conceptType || GENRE_CONCEPT_TYPES.has(item.conceptType));
      for (const ow of openWorldItems) {
        if (!ow?.canonicalLabel || !GenreLabels.isPlausibleGenreLabel(ow.canonicalLabel)) continue;
        const confidence = clamp(ow.confidence ?? 0.6);
        // Which evidence families stand behind this name? Blind Music Flamingo and the classifier
        // are independent listeners. An assisted Flamingo call that was shown the classifier's
        // shortlist is useful adjudication, but must be discounted as correlated evidence.
        const corroboration = corroborateWithClassifier(ow, classifier, this.hierarchy);
        // If Flamingo saw these classifier labels in its prompt, its repetition of a related name
        // is assisted adjudication, not a second independent vote. A single assisted capture is
        // therefore one evidence family. Re-hearing it in a distinct audio segment can add a
        // cross-segment family, and a later blind Flamingo observation restores genuinely
        // independent deep-listen + classifier corroboration.
        const assistedOnly = Boolean(ow.conditionedOnClassifier && !ow.hasIndependentDeepListen);
        const reportedFamilies = Array.isArray(ow.sources) && ow.sources.length
          ? ow.sources.map(source => evidenceFamily({ source })) : ["deepListen"];
        const families = assistedOnly
          ? new Set([...reportedFamilies.filter(family => !["deepListen", "genreModel"].includes(family)), "assistedFusion"])
          : new Set(reportedFamilies);
        if (corroboration.matched.length && !assistedOnly) families.add("genreModel");
        if (assistedOnly && (ow.temporalSupport || 1) >= 2) families.add("crossSegment");
        const independentFamilies = [...families];
        // A composite is a name no single source could have produced on its own: the classifier
        // cannot say it (it is outside the 400 it was trained on) and Flamingo alone cannot
        // corroborate it. When both point at it, that is the composite -- derived here, never
        // read from a table of pre-approved genre names.
        const composite = corroboration.matched.length > 0 && !corroboration.exact;
        const corroborationBoost = assistedOnly
          ? Math.min(0.08, corroboration.strength * 0.10)
          : Math.min(0.22, corroboration.strength * 0.28);
        const cap = assistedOnly
          ? ((ow.temporalSupport || 1) >= 2 ? 0.84 : 0.76)
          : (independentFamilies.length >= 2 ? 0.94 : 0.72);
        candidates.push({
          genre: ow.canonicalLabel,
          semanticConfidence: Math.min(cap, clamp(confidence + corroborationBoost)),
          classifierConfidence: corroboration.bestClassifierConfidence,
          kind: composite ? (assistedOnly ? "assisted-composite" : "composite") : "open-world",
          openWorld: true,
          composite,
          conditionedOnClassifier: assistedOnly,
          compositeOf: composite ? corroboration.matched.map(item => item.genre) : [],
          status: ow.status || "emerging",
          temporalSupport: ow.temporalSupport || 1,
          evidenceCoverage: Math.min(1, independentFamilies.length / 3),
          independentEvidenceCount: independentFamilies.length,
          independentEvidenceFamilies: independentFamilies,
          matchedEvidenceGroups: assistedOnly
            ? ["assistedFusion", ...((ow.temporalSupport || 1) >= 2 ? ["crossSegment"] : [])]
            : (composite ? ["deepListen", "classifier"] : ["deepListen"]),
          supportingEvidence: [
            ...(ow.supportingObservations || []),
            ...corroboration.matched.map(item => ({ path: "classifierGenre.topK",
              value: item.semanticConfidence, label: item.genre, source: "genre-classifier" }))
          ],
          contradictingEvidence: ow.contradictions || []
        });
      }

      // Genre NAMES come only from the two things that actually listen: the classifier model and
      // Music Flamingo. There is no rule table here any more.
      //
      // What stood here was a hand-written list -- Future Funk, French House, Nu Disco, Jazz Rap,
      // Electro Swing, Liquid DnB -- each with its own acoustic thresholds. It existed because the
      // classifier is trained on a fixed 400 styles and cannot say "Future Funk" at all, so the
      // gap was patched by naming six of them by hand. That is a closed world with extra steps:
      // it works for exactly the six genres someone thought to write down, and every other
      // composite in music is silently unreachable. Corroboration now happens per candidate in
      // the open-world ingest above, against relations discovered at runtime, so a name nobody
      // has written down is reachable the moment two independent listeners agree on it.
      const relations = [];
      const rejectedHypotheses = candidates
        .filter(item => item.openWorld && item.independentEvidenceCount < 2 &&
          clamp(item.semanticConfidence) < 0.5)
        .map(item => ({ genre: item.genre, evidenceCoverage: item.evidenceCoverage,
          independentEvidenceCount: item.independentEvidenceCount,
          independentEvidenceFamilies: item.independentEvidenceFamilies,
          reason: "insufficient-independent-evidence",
          contradictingEvidence: item.contradictingEvidence || [] }));

      const ranked = unique(candidates).sort((a, b) => b.semanticConfidence - a.semanticConfidence);
      for (const item of ranked) {
        const key = normalize(item.genre);
        const previous = this.history.get(key);
        const contiguous = previous && at - previous.lastSeenAt <= this.options.staleMs;
        const firstSeenAt = contiguous ? previous.firstSeenAt : at;
        const observations = contiguous ? previous.observations + 1 : 1;
        const stableForMs = Math.max(0, at - firstSeenAt);
        const temporalStability = clamp(Math.min(1, observations / 6) * 0.55 + Math.min(1, stableForMs / 6000) * 0.45);
        Object.assign(item, { firstSeenAt, lastSeenAt: at, observations, stableForMs, temporalStability });
        this.history.set(key, { firstSeenAt, lastSeenAt: at, observations, peakConfidence:
          Math.max(previous?.peakConfidence || 0, item.semanticConfidence) });
      }
      for (const [key, item] of this.history) if (at - item.lastSeenAt > this.options.staleMs * 3) this.history.delete(key);

      // Keep weak one-off names in the hypothesis list for inspection, but do not let them become
      // the track identity. This gate is label-agnostic: repetition or independent corroboration
      // can promote any open-world name later without a genre catalog.
      const promotionEligible = item => {
        if (!item) return false;
        const confidence = clamp(item.semanticConfidence);
        if (item.kind === "classifier" && state.classifierGenre?.uncertain) return false;
        if (confidence >= this.options.initialPromotionMinConfidence) return true;
        const repeatedOrCorroborated = (item.temporalSupport || 0) >= 2 ||
          (item.observations || 0) >= 2 || (item.independentEvidenceCount || 0) >= 2;
        return repeatedOrCorroborated && confidence >= this.options.repeatedPromotionMinConfidence;
      };

      let takeover = null;
      const leader = ranked.find(promotionEligible) || null;
      if (!this.primary && leader) this.primary = leader.genre;
      const current = ranked.find(item => normalize(item.genre) === normalize(this.primary));
      if (leader && current && normalize(leader.genre) !== normalize(current.genre)) {
        const eligible = leader.semanticConfidence >= current.semanticConfidence + this.options.switchMargin &&
          leader.evidenceCoverage >= this.options.minimumCoverage &&
          leader.independentEvidenceCount >= this.options.minimumIndependentEvidence;
        if (eligible) {
          if (!this.pending || normalize(this.pending.genre) !== normalize(leader.genre)) this.pending = { genre: leader.genre, since: at };
          else if (at - this.pending.since >= this.options.takeoverMs) {
            takeover = { from: this.primary, to: leader.genre, at, semanticConfidence: leader.semanticConfidence,
              evidenceCoverage: leader.evidenceCoverage };
            this.primary = leader.genre;
            this.pending = null;
            this.takeovers.push(takeover);
            this.takeovers = this.takeovers.slice(-12);
          }
        } else this.pending = null;
      } else if (leader && (!current || normalize(leader.genre) === normalize(current.genre))) this.pending = null;

      const primary = this.primary
        ? ranked.find(item => normalize(item.genre) === normalize(this.primary)) || null
        : null;
      const challengers = ranked.filter(item => normalize(item.genre) !== normalize(primary?.genre)).slice(0, 4);
      const children = new Set((this.hierarchy.children?.[primary?.genre] || []).map(normalize));
      const actualSubgenres = challengers.filter(item => children.has(normalize(item.genre)) && item.semanticConfidence >= 0.42)
        .map(item => ({ label: item.genre, confidence: item.semanticConfidence }));
      const relatedGenres = challengers.filter(item => !children.has(normalize(item.genre)))
        .map(item => ({ label: item.genre, confidence: item.semanticConfidence, relation: "alternative" }));
      return { primary, challengers, alternatives: challengers, actualSubgenres, relatedGenres, relations,
        pendingChallenger: this.pending ? { ...this.pending, stableForMs: at - this.pending.since } : null,
        takeover, takeovers: this.takeovers.slice(), hypotheses: ranked,
        rejectedHypotheses: rejectedHypotheses.slice(0, 12), updatedAt: at };
    }
  }

  return { Engine, evaluateGroup, classifierItems, normalize, read };
})();

if (typeof module !== "undefined" && module.exports) module.exports = GenreHypotheses;
