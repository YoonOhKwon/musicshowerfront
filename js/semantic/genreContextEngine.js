const GenreContext = (() => {
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Instruments = typeof InstrumentationEvents !== "undefined" ? InstrumentationEvents : require("./instrumentationEventEngine");
  // Default evidence pool PER EDGE TYPE, used only when an individual edge in the data doesn't
  // specify its own `requires`. Different edge types lean on different axes so that, even with
  // defaults, a genre's parents/adjacencies/aesthetics don't all light up from the same measurement.
  const RELATION_TYPE_DEFAULTS = {
    parents: ["rhythmicGrammar.fourOnFloor", "rhythmicGrammar.swing", "rhythmicGrammar.brokenBeat", "productionEvidence.sampleBased"],
    lineage: ["rhythmicGrammar.fourOnFloor", "rhythmicGrammar.swing", "productionEvidence.sampleBased"],
    adjacent: ["instrumentationEvidence.synthesizer", "instrumentationEvidence.bass", "instrumentationEvidence.piano", "instrumentationEvidence.drums"],
    eras: ["productionEvidence.sampleBased", "instrumentationEvidence.synthesizer"],
    scenes: ["rhythmicGrammar.brokenBeat", "instrumentationEvidence.drums"],
    culture: ["moodDimensions.warmth", "productionEvidence.sampleBased"],
    aesthetics: ["moodDimensions.brightness", "moodDimensions.warmth", "productionEvidence.sampleBased"]
  };
  // Sonic evidence (rhythm/production/instrumentation) is mandatory for any relation: mood alone
  // must never unlock a cultural claim, no matter what an edge's own `requires` list contains.
  const RELATION_SONIC_ROOTS = new Set(["rhythmicGrammar", "productionEvidence", "instrumentationEvidence"]);
  const FAMILY_BY_CATEGORY = Object.freeze({ genre: "PRIMARY_GENRE", lineage: "LINEAGE", era: "ERA",
    scene: "SCENE", culture: "CULTURE", association: "AESTHETIC_ASSOCIATION" });
  // Shared fallback for the mismatch between the Discogs-EffNet classifier's own label spelling
  // ("Nu-Disco", "Drum n Bass") and hand-authored knowledge keys ("Nu Disco", "Drum & Bass"):
  // fold ONLY cosmetic punctuation/connector spelling (hyphen vs space, "&"/" n "/" and ", case),
  // never strip a substring -- "Disco", "Nu-Disco" and "Italo-Disco" must still normalize to three
  // distinct strings, so genuinely different genres are never merged by this. The primary fix for
  // a known spelling variant is still an explicit data/genreAliases.json entry (it also fixes
  // genre.primary for every OTHER consumer, not just this lookup); this is a second-line safety
  // net so a knowledge entry never goes silently unreachable just because someone typed its key
  // with different spacing than the classifier uses.
  function normalizeGenreLabel(label) {
    return String(label || "").toLowerCase()
      .replace(/\s+and\s+/g, "&")
      .replace(/\s+n\s+/g, "&")
      .replace(/[\s-]+/g, "")
      .trim();
  }
  // The exact matching logic used both by the live lookup (Engine.evaluate) and by
  // scripts/knowledge-coverage.cjs's reachability report -- kept as one function so the two can
  // never silently disagree about which knowledge entries are reachable (the same class of bug
  // fixed for the primitive-classification report in an earlier round).
  function resolveGenreEntry(data, primaryLabel) {
    const key = String(primaryLabel || "").toLowerCase();
    const normalizedKey = normalizeGenreLabel(primaryLabel);
    const found = Object.entries(data.genres || {}).find(([label, item]) =>
      label.toLowerCase() === key || normalizeGenreLabel(label) === normalizedKey ||
      (item.aliases || []).some(alias => alias.toLowerCase() === key || normalizeGenreLabel(alias) === normalizedKey));
    return found ? found[0] : null;
  }
  function instrumentEvidence(state) {
    const evidence = {};
    const normalized = Instruments.normalize((state.instruments || []).filter(x => x.source !== "dsp"));
    for (const item of normalized) {
      if (item.source !== "dsp") evidence[item.id] = item.confidence;
    }
    for (const [family, value] of Object.entries(Instruments.familyRollup(normalized))) {
      evidence[family] = Math.max(evidence[family] || 0, value.confidence);
    }
    return evidence;
  }
  class Engine {
    constructor(data = {}, aestheticAxisEngine = null, compositions = null) {
      this.data = data; this.aestheticAxisEngine = aestheticAxisEngine; this.compositions = compositions;
    }
    evaluate(state = {}) {
      const genre = state.genre || {};
      const result = { genre: genre.uncertain ? null : genre.primary || null, confidence: 0,
        basis: "style association, not origin or identification", matchedPriors: [], candidates: [],
        aestheticEvidence: state.aestheticEvidence || {} };
      const audible = state.expressionFeatures?.audible !== false;
      const view = { measurements: state.expressionFeatures || {}, rhythmicGrammar: state.rhythmicGrammar || {},
        productionEvidence: state.productionEvidence || {}, instrumentationEvidence: instrumentEvidence(state),
        moodDimensions: state.moodDimensions || {}, aestheticEvidence: result.aestheticEvidence };
      // Open layer (association/AESTHETIC) is axis-based, not genre-identity-based: it must not
      // wait on sufficiently grounded genre confidence, since an unconfirmed genre is the single biggest cause
      // of open-layer silence, and the axis engine already carries its own independent evidence
      // gate (data/aestheticAxes.json's null-propagation + minAxes). The middle/context layer
      // below (lineage/era/scene/culture, and now composition-inferred open genre names) is a
      // genre-IDENTITY claim and keeps a conservative semantic-confidence bar.
      if (this.aestheticAxisEngine && audible) {
        const axisResult = this.aestheticAxisEngine.evaluate(view, genre);
        result.candidates.push(...axisResult.candidates);
        // Exposed so phrasePoolEngine.js's runtime LLM call gate (section 5) can recognize "we've
        // already been in roughly this aesthetic territory" without recomputing the axis vector,
        // and so scripts/replay.cjs (section 3) can report real axis-value distributions per song
        // without a second, separate axis computation that could silently drift from this one.
        result.axisSignature = axisResult.axisSignature;
        result.axes = axisResult.axes;
      }
      if (genre.uncertain || genre.confidence < 0.68 || !audible) {
        result.matchedPriors = result.candidates.map(x => x.text);
        // Deliberately modest and independent of genre.confidence (which may be low/uncertain
        // here) -- this reflects only how well-evidenced the axis-based candidates themselves are.
        result.confidence = result.candidates.length ? 0.5 : 0;
        return result;
      }
      const resolvedKey = resolveGenreEntry(this.data, genre.primary);
      const entry = resolvedKey ? this.data.genres[resolvedKey] : null;
      const rules = [...(entry?.candidates || []), ...(this.data.families?.[genre.family]?.candidates || [])];
      for (const rule of rules.slice(0, 60)) {
        const tests = rule.requires || [];
        const groups = new Set(tests.map(test => test.path.split(".")[0]));
        if (tests.length < 2 || groups.size < 2) continue;
        const matched = tests.every(test => {
          const value = Facets.read(view, test.path);
          return typeof value === "number" && Number.isFinite(value) && value >= (test.min ?? 0) && value <= (test.max ?? 1);
        });
        if (!matched || !Facets.safeText(rule.text, rule.category)) continue;
        const confidence = Math.min(genre.confidence, rule.confidenceCap || 0.84);
        result.candidates.push(Facets.token(rule.text, rule.category, confidence,
          ["primaryGenre", ...tests.map(test => test.path === "aestheticEvidence.magicalGirl"
            ? "genreContextEvidence.aestheticEvidence.magicalGirl" : test.path)].slice(0, 6),
          { source: "evidence-gated-prior", kind: rule.kind || "style", sources: entry?.sources || [],
            relationFamily: rule.relationFamily || FAMILY_BY_CATEGORY[rule.category] || null,
            relationScore: confidence }));
      }
      result.candidates.push(...this.relationCandidates(genre, view));
      result.candidates.push(...this.compositionCandidates(genre, view));
      // A rule and a relation can name the same thing; keep the better-evidenced one only.
      const best = new Map();
      for (const candidate of result.candidates) {
        const key = `${candidate.category}:${candidate.text}`;
        if (!best.has(key) || best.get(key).confidence < candidate.confidence) best.set(key, candidate);
      }
      result.candidates = [...best.values()].slice(0, 24);
      result.matchedPriors = result.candidates.map(x => x.text);
      result.confidence = result.candidates.length ? Math.min(genre.confidence, 0.84) : 0;
      return result;
    }
    // Relations describe where a style sits (parents/lineage/adjacency/era/scene/culture/aesthetic/
    // artist). They are priors, so they only speak when the live genre is confident AND at least
    // two independent current measurements back them, and the wording weakens as the link weakens.
    relationCandidates(genre, view) {
      const key = String(genre.primary || "").toLowerCase();
      const normalizedKey = normalizeGenreLabel(genre.primary);
      const entry = Object.entries(this.data.relations || {}).find(([label]) =>
        label.toLowerCase() === key || normalizeGenreLabel(label) === normalizedKey)?.[1];
      // Same confidence boundary the hand-written rules use: relations broaden COVERAGE,
      // they do not lower the bar for claiming a history or a scene.
      if (!entry || !(genre.confidence >= 0.68)) return [];
      const resolvedValue = path => {
        const value = Facets.read(view, path);
        return Number.isFinite(value) ? value : null;
      };
      // Genre-level gate (checked ONCE, same bar as before edges were split out): the track needs
      // at least 2 independent sonic families resolved somewhere before ANY relation may open at
      // all. This is a track-wide "is there enough grounding to say anything historical/cultural",
      // separate from which SPECIFIC edge below best fits what was actually measured.
      const allSonicPaths = [...new Set(Object.values(RELATION_TYPE_DEFAULTS).flat()
        .filter(path => RELATION_SONIC_ROOTS.has(path.split(".")[0])))];
      const resolvedSonicFamilies = new Set(allSonicPaths
        .map(path => ({ path, value: resolvedValue(path) }))
        .filter(x => x.value !== null && x.value >= 0.4)
        .map(x => x.path.split(".")[0]));
      if (resolvedSonicFamilies.size < 2) return [];
      // Each edge is THEN scored from ITS OWN requires (or its type's default pool) — a genre's
      // parent, an adjacency and an aesthetic association no longer all cite the same two anchors,
      // and an edge needs at least one of its own paths to actually resolve to be offered at all.
      const evaluateEdge = (rawEdge, edgeType) => {
        const name = typeof rawEdge === "string" ? rawEdge : rawEdge?.name;
        if (!name) return null;
        const pool = (typeof rawEdge === "object" && Array.isArray(rawEdge.requires) && rawEdge.requires.length
          ? rawEdge.requires : RELATION_TYPE_DEFAULTS[edgeType] || []);
        const resolved = pool.map(path => ({ path, value: resolvedValue(path) })).filter(x => x.value !== null && x.value >= 0.4);
        if (resolved.length < 1) return null;
        // Confidence scales with how completely THIS edge's own evidence pool was satisfied, not
        // a flat per-type constant — a fully-supported edge outranks a barely-qualifying one.
        const completeness = resolved.length / Math.max(2, pool.length || resolved.length);
        return { name, anchors: ["primaryGenre", ...resolved.map(x => x.path)], completeness: Math.min(1, completeness) };
      };
      const build = (edge, category, baseScale, kind = "style", relationFamily = null, relationDepth = 0) => text => {
        if (!edge || !text) return null;
        const confidence = Math.min(genre.confidence * baseScale * (0.75 + edge.completeness * 0.25), 0.84);
        if (confidence < 0.45 || !Facets.safeText(text, category)) return null;
        return Facets.token(text, category, confidence, edge.anchors, { source: "genre-relation", kind,
          relationFamily, relationScore: confidence, relationCompleteness: edge.completeness, relationDepth });
      };
      const edgesOf = (list, edgeType) => (list || []).map(raw => evaluateEdge(raw, edgeType)).filter(Boolean);
      const list = [
        ...edgesOf(entry.parents, "parents").map(edge => build(edge, "lineage", 0.92, "style", "PARENT", 1)(`${edge.name} 계열`)),
        ...edgesOf(entry.lineage, "lineage").map(edge => build(edge, "lineage", 0.84, "style", "LINEAGE", 2)(`${edge.name} 계열`)),
        ...edgesOf(entry.adjacent, "adjacent").map(edge => build(edge, "association", 0.68, "style", "ADJACENCY", 3)(`${edge.name} 인접성`)),
        ...edgesOf(entry.eras, "eras").map(edge => build(edge, "era", 0.86, "style", "ERA", 2)(edge.name)),
        ...edgesOf(entry.scenes, "scenes").map(edge => build(edge, "scene", 0.84, "style", "SCENE", 2)(edge.name)),
        ...edgesOf(entry.culture, "culture").map(edge => build(edge, "culture", 0.8, "style", "CULTURE", 2)(edge.name)),
        ...edgesOf(entry.aesthetics, "aesthetics").map(edge => build(edge, "association", 0.72, "aesthetic", "AESTHETIC_ASSOCIATION", 3)(edge.name)),
        // An artist link is a style comparison, never identification: it needs the strongest genre
        // AND both an instrumentation-family and a production-family support (stricter than any
        // other edge type, matching the existing artist-specific check in semanticFacets.support()).
        ...(genre.confidence >= 0.78 ? (entry.artists || []).map(name => {
          const edge = evaluateEdge({ name, requires: ["instrumentationEvidence.synthesizer", "instrumentationEvidence.bass",
            "productionEvidence.sampleBased", "productionEvidence.sidechain"] }, "adjacent");
          if (!edge) return null;
          const families = new Set(edge.anchors.filter(p => p !== "primaryGenre").map(p => p.split(".")[0]));
          if (!families.has("instrumentationEvidence") || !families.has("productionEvidence")) return null;
          return build(edge, "association", 0.8, "artist", "ARTIST", 3)(`${name} 연상`);
        }) : [])
      ].filter(Boolean);
      return list.slice(0, 14);
    }
    // Section 4: Discogs-EffNet's 400 classes are a coordinate system, not a wall -- a genre with
    // no dedicated class (Future Funk, French House) can still be inferred from WHICH classes the
    // classifier's own top-K puts weight on, combined with real audio evidence a hand-authored
    // rule would otherwise require. requiresTopK/minTopKCount reference genre.topK's own labels
    // (already run through canonicalGenre()'s alias resolution, same as genre.primary), so this
    // needs no separate normalization step.
    compositionCandidates(genre, view) {
      if (!this.compositions) return [];
      const topKLabels = new Set((genre.topK || []).map(item => String(item?.label ?? item ?? "").toLowerCase()).filter(Boolean));
      if (!topKLabels.size) return [];
      const results = [];
      for (const rule of this.compositions.rules || []) {
        const requiresTopK = rule.requiresTopK || [];
        const matchedCount = requiresTopK.filter(label => topKLabels.has(String(label).toLowerCase())).length;
        if (matchedCount < (rule.minTopKCount ?? 1)) continue;
        const tests = rule.requires || [];
        const groups = new Set(tests.map(test => test.path.split(".")[0]));
        if (tests.length < 2 || groups.size < 2) continue;
        const matched = tests.every(test => {
          const value = Facets.read(view, test.path);
          return typeof value === "number" && Number.isFinite(value) && value >= (test.min ?? 0) && value <= (test.max ?? 1);
        });
        // A composition-inferred name is a hypothesis about an UNLABELED genre, never a fact --
        // it must always read as tentative (계열/경향), never as if the classifier actually named it.
        if (!matched || !/(?:계열|경향)$/.test(rule.text) || !Facets.safeText(rule.text, "lineage")) continue;
        const completeness = matchedCount / Math.max(1, requiresTopK.length);
        // Deliberately capped well below the primary genre's own confidence and below a hand-
        // authored rule's typical ceiling -- this must never be strong enough to read as more
        // certain than (or overwrite) the HUD's actual confirmed genre.
        const confidence = Math.min(genre.confidence * 0.65, 0.6) * (0.6 + completeness * 0.4);
        if (confidence < 0.35) continue;
        results.push(Facets.token(rule.text, "lineage", confidence,
          ["primaryGenre", ...tests.map(test => test.path)].slice(0, 6),
          { source: "genre-composition", kind: "style", relationFamily: "COMPOSITION",
            relationScore: confidence, matchedTopK: requiresTopK.filter(label => topKLabels.has(String(label).toLowerCase())) }));
      }
      return results.slice(0, 6);
    }
  }
  return { Engine, instrumentEvidence, normalizeGenreLabel, resolveGenreEntry };
})();
if (typeof module !== "undefined" && module.exports) module.exports = GenreContext;
