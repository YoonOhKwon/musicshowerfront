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
        minimumIndependentEvidence: 2, staleMs: 9000, ...options };
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

      // Ingest open-world concept hypotheses from OpenWorldConceptRegistry or state
      const openWorldItems = Array.isArray(state.openWorldConcepts)
        ? state.openWorldConcepts
        : (state.openWorldRegistry?.byType ? state.openWorldRegistry.byType("genre") : []);
      for (const ow of openWorldItems) {
        if (!ow?.canonicalLabel || !GenreLabels.isPlausibleGenreLabel(ow.canonicalLabel)) continue;
        const confidence = clamp(ow.confidence ?? 0.6);
        candidates.push({
          genre: ow.canonicalLabel,
          semanticConfidence: confidence,
          classifierConfidence: 0.5,
          kind: "open-world",
          openWorld: true,
          status: ow.status || "emerging",
          temporalSupport: ow.temporalSupport || 1,
          evidenceCoverage: 0.75,
          independentEvidenceCount: Math.max(1, ow.sources?.length || (ow.source ? 1 : 1)),
          independentEvidenceFamilies: Array.isArray(ow.sources) ? ow.sources : ["openWorld"],
          supportingEvidence: ow.supportingObservations || [],
          contradictingEvidence: ow.contradictions || []
        });
      }

      const relations = [];
      const rejectedHypotheses = [];
      for (const rule of this.rules.rules || []) {
        const groups = (rule.evidenceGroups || []).map(group => ({ id: group.id, weight: Number(group.weight) || 1,
          required: group.required,
          ...evaluateGroup(group, state, classifier) }));
        const required = groups.filter(group => group.required !== false);
        const matchedRequired = required.filter(group => group.matched);
        const coverage = required.length ? matchedRequired.length / required.length : 0;
        const independentFamilies = [...new Set(groups.filter(group => group.matched)
          .flatMap(group => group.evidence.map(evidenceFamily)).filter(Boolean))];
        const independent = independentFamilies.length;
        const minIndependent = rule.minimumIndependentEvidence ?? this.options.minimumIndependentEvidence;
        if (coverage < (rule.minimumCoverage ?? this.options.minimumCoverage) || independent < minIndependent) {
          rejectedHypotheses.push({ genre: rule.genre, ruleId: rule.id, evidenceCoverage: coverage,
            independentEvidenceCount: independent, independentEvidenceFamilies: independentFamilies,
            reason: independent < minIndependent
              ? "insufficient-independent-evidence" : "insufficient-evidence-coverage",
            evidenceGroups: Object.fromEntries(groups.map(group => [group.id,
              { matched: group.matched, score: group.score, required: group.required !== false }])),
            contradictingEvidence: groups.flatMap(group => group.contradictions.map(item => ({ ...item, group: group.id }))) });
          continue;
        }
        const matchedWeight = groups.filter(group => group.matched).reduce((sum, group) => sum + group.weight, 0);
        const weightedScore = groups.filter(group => group.matched)
          .reduce((sum, group) => sum + group.score * group.weight, 0) / Math.max(0.001, matchedWeight);
        const semanticConfidence = clamp(weightedScore * (0.72 + coverage * 0.28) * (rule.confidenceScale || 1) +
          Math.min(0.09, Math.max(0, independent - 1) * 0.03));
        if (semanticConfidence < (rule.minimumConfidence ?? 0.52)) continue;
        const supportingEvidence = groups.flatMap(group => group.evidence.map(item => ({ ...item, group: group.id })));
        const contradictingEvidence = groups.flatMap(group => group.contradictions.map(item => ({ ...item, group: group.id })));
        const hypothesis = { genre: rule.genre, semanticConfidence, classifierConfidence: Math.max(0,
          ...classifier.filter(item => (rule.classifierLabels || []).map(normalize).includes(normalize(item.genre)))
            .map(item => item.classifierConfidence)), kind: "composite", evidenceCoverage: coverage,
          independentEvidenceCount: independent, independentEvidenceFamilies: independentFamilies,
          evidenceGroups: Object.fromEntries(groups.map(group => [group.id,
            { matched: group.matched, score: group.score, required: group.required !== false }])),
          matchedEvidenceGroups: groups.filter(group => group.matched).map(group => group.id),
          supportingEvidence, contradictingEvidence, ruleId: rule.id };
        candidates.push(hypothesis);
        for (const relation of rule.relations || []) {
          const group = relation.requiresGroup && groups.find(item => item.id === relation.requiresGroup);
          if (group && !group.matched) continue;
          if (Array.isArray(relation.requiresAnyLabel)) {
            const allowed = new Set(relation.requiresAnyLabel.map(normalize));
            if (!classifier.some(item => allowed.has(normalize(item.genre)))) continue;
          }
          const confidence = clamp(semanticConfidence * (relation.confidenceScale || 0.82));
          const category = relation.category || (relation.type === "lineage" ? "lineage" : "association");
          relations.push(Facets.token(relationText(relation), category, confidence,
            supportingEvidence.map(item => item.path === "classifierGenre.topK" ? "genreEvidence" : item.path).slice(0, 6), {
              source: "genre-hypothesis", kind: "style", relationFamily: String(relation.type || "influence").toUpperCase(),
              relationType: relation.type, relationTarget: relation.genre, relationScore: confidence,
              hypothesisGenre: rule.genre
            }));
        }
      }

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

      let takeover = null;
      const leader = ranked[0] || null;
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

      const primary = ranked.find(item => normalize(item.genre) === normalize(this.primary)) || leader;
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
