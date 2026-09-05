// Evidence-gated bridge from measurable musical primitives to conventional musical language.
// The graph is compiled from the primitive schema, genre taxonomy and idiom rules.  Genre is a
// context multiplier only: it may specialise wording, but can never satisfy missing audio evidence.
const MusicalIdioms = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));

  function read(source, path) {
    return String(path || "").split(".").filter(Boolean)
      .reduce((value, key) => value === null || value === undefined ? undefined : value[key], source);
  }

  function condition(test, primitives) {
    const value = read(primitives, test?.path);
    if (value === null || value === undefined) return { pass: false, available: false, value, score: 0 };
    let pass = true;
    if (Object.prototype.hasOwnProperty.call(test, "equals")) pass = pass && value === test.equals;
    if (Array.isArray(test.oneOf)) pass = pass && test.oneOf.includes(value);
    if (Number.isFinite(test.min)) pass = pass && typeof value === "number" && value >= test.min;
    if (Number.isFinite(test.max)) pass = pass && typeof value === "number" && value <= test.max;
    let score = 0.86;
    if (typeof value === "number" && value >= 0 && value <= 1) {
      if (Number.isFinite(test.min)) score = clamp((value - test.min) / Math.max(0.001, 1 - test.min) * 0.28 + 0.72);
      else if (Number.isFinite(test.max)) score = clamp((test.max - value) / Math.max(0.001, test.max) * 0.28 + 0.72);
      else score = clamp(value);
    }
    return { pass, available: true, value, score: pass ? score : 0 };
  }

  function taxonomyLabels(taxonomy = {}) {
    return [...new Set(Object.values(taxonomy).flatMap(labels => Array.isArray(labels) ? labels : []))];
  }

  function familyFor(entry = {}) {
    if (entry.semanticFamily) return entry.semanticFamily;
    const prefixes = ["rhythm", "harmony", "melody", "bass", "texture", "articulation", "form", "production", "arrangement"];
    return prefixes.find(prefix => String(entry.id || "").startsWith(prefix)) || entry.facet || "musical-idiom";
  }

  function compileGraph(lexicon = {}, { primitiveSchema = {}, genreTaxonomy = {} } = {}) {
    const nodes = [];
    const edges = [];
    const seen = new Set();
    const addNode = node => {
      if (!node?.id || seen.has(node.id)) return;
      seen.add(node.id);
      nodes.push(node);
    };
    for (const [group, fields] of Object.entries(primitiveSchema || {})) {
      for (const field of fields || []) addNode({ id: `primitive:${group}.${field}`, type: "primitive", path: `${group}.${field}` });
    }
    for (const label of taxonomyLabels(genreTaxonomy)) addNode({ id: `genre:${label}`, type: "genre-context", label });
    const families = new Set();
    for (const entry of lexicon.entries || []) {
      const idiomId = `idiom:${entry.id}`;
      const semanticFamily = familyFor(entry);
      families.add(semanticFamily);
      addNode({ id: idiomId, type: "idiom", label: entry.neutralText, facet: entry.facet, semanticFamily });
      const lists = [
        [entry.required || entry.match || [], "required-evidence"],
        [entry.supporting || [], "supporting-evidence"],
        [entry.contradicting || entry.excludes || [], "contradicting-evidence"]
      ];
      for (const [tests, relation] of lists) for (const test of tests) {
        const primitiveId = `primitive:${test.path}`;
        addNode({ id: primitiveId, type: "primitive", path: test.path, external: !read(primitiveSchema, test.path) });
        edges.push({ from: primitiveId, to: idiomId, relation, condition: { ...test } });
      }
      const forms = [{ text: entry.neutralText, neutral: true }, ...(entry.specializations || [])];
      for (const [index, form] of forms.entries()) {
        if (!form.text) continue;
        const realizationId = `realization:${entry.id}:${index}`;
        addNode({ id: realizationId, type: "language-realization", text: form.text, neutral: index === 0 });
        edges.push({ from: idiomId, to: realizationId, relation: "realizes" });
        for (const genre of form.genreFamilies || []) {
          addNode({ id: `genre:${genre}`, type: "genre-context", label: genre });
          edges.push({ from: `genre:${genre}`, to: realizationId, relation: "context-specializes" });
        }
      }
    }
    for (const family of families) addNode({ id: `family:${family}`, type: "semantic-family", label: family });
    for (const entry of lexicon.entries || [])
      edges.push({ from: `idiom:${entry.id}`, to: `family:${familyFor(entry)}`, relation: "belongs-to" });
    const countBy = (values, key) => values.reduce((result, item) => {
      const name = item[key] || "unknown";
      result[name] = (result[name] || 0) + 1;
      return result;
    }, {});
    const entries = lexicon.entries || [];
    const dormantCount = entries.filter(entry => entry.status === "dormant").length;
    return { version: Number(lexicon.version || 1), nodes, edges,
      stats: { nodes: nodes.length, edges: edges.length, nodeTypes: countBy(nodes, "type"), edgeTypes: countBy(edges, "relation"),
        idiomsActive: entries.length - dormantCount, idiomsDormant: dormantCount } };
  }

  function genreValues(genre = {}) {
    // fineCandidates is now taxonomy-only (GenreHypotheses' explicit hierarchy children);
    // relatedCandidates is the broader neighborhood-search alternatives list that used to share
    // this field. Both are genuine genre-label sources for idiom-trigger matching, so both are read.
    return [...new Set([
      genre.primary, genre.family, genre.displayLabel,
      ...(genre.secondary || []), ...(genre.topK || []).map(item => item.label),
      ...(genre.fineCandidates || []).map(item => (typeof item === "string" ? item : item?.label)),
      ...(genre.relatedCandidates || []).map(item => (typeof item === "string" ? item : item?.label))
    ].filter(Boolean).map(String))];
  }

  function genreMatch(allowed = [], genre = {}) {
    if (!allowed.length) return false;
    const values = genreValues(genre).map(value => value.toLowerCase());
    // Exact labels only. A broad family such as "Jazz / Soul" must not turn City Pop into a
    // Jazz-performance idiom merely because the family string contains the word "Jazz".
    return allowed.some(wanted => values.includes(String(wanted).toLowerCase()));
  }

  function contextMultiplier(entry, genre) {
    let multiplier = 1;
    for (const rule of entry.contextMultipliers || []) {
      if (genreMatch(rule.genreFamilies || rule.genres || [], genre) && (genre.confidence || 0) >= (rule.minGenreConfidence ?? 0.55))
        multiplier *= Number(rule.multiplier) || 1;
    }
    return Math.min(1.18, Math.max(0.72, multiplier));
  }

  // requiredContext is a GATE, not a multiplier: shared primitive evidence (e.g. uneven
  // subdivision, or repetition + brightness) is real everywhere it is measured, but a
  // genre-NAMED idiom (Synthwave arpeggio, City Pop studio production, Big Band swing) must not
  // fire just because that generic evidence happened to be present in an unrelated genre. Genre
  // context here is a second, independent requirement on top of the evidence -- never a
  // substitute for it.
  function contextGatePasses(entry, genre) {
    const required = entry.requiredContext;
    // contextMode is a declared contract, so it is enforced rather than documented: an entry that
    // says its genre context is REQUIRED must fail closed if the gate itself is missing or empty,
    // instead of silently degrading into an ungated, leak-prone rule (section 2-3).
    const strict = entry.contextMode === "REQUIRED";
    if (!required) return !strict;
    const families = required.genreFamilies || required.genres || (required.genre ? [required.genre] : []);
    if (!families.length) return !strict;
    return genreMatch(families, genre) && (genre.confidence || 0) >= (required.minConfidence ?? 0.6) && !genre.uncertain;
  }

  function chooseText(entry, genre) {
    const specialization = (entry.specializations || []).find(item =>
      genreMatch(item.genreFamilies || [], genre) && !genre.uncertain &&
      (genre.confidence || 0) >= (item.minGenreConfidence ?? 0.6));
    return specialization ? { text: specialization.text, neutral: false, specialization } :
      { text: entry.neutralText, neutral: true, specialization: null };
  }

  class Engine {
    constructor(lexicon = {}, options = {}) {
      this.lexicon = { version: 1, entries: [] };
      this.options = { primitiveSchema: options.primitiveSchema || {}, genreTaxonomy: options.genreTaxonomy || {} };
      this.graph = compileGraph(this.lexicon, this.options);
      this.setLexicon(lexicon);
    }
    setLexicon(lexicon = {}) {
      this.lexicon = { version: Number(lexicon.version || 1), entries: Array.isArray(lexicon.entries) ? lexicon.entries : [] };
      this.graph = compileGraph(this.lexicon, this.options);
      return this;
    }
    setContext(options = {}) {
      this.options = { ...this.options, ...options };
      this.graph = compileGraph(this.lexicon, this.options);
      return this;
    }
    evaluate(primitives = {}, genre = {}) {
      const result = [];
      for (const entry of this.lexicon.entries) {
        // Dormant knowledge stays in the lexicon and in the graph, but never speaks: it is
        // waiting for a detector that does not exist yet (section 3-C).
        if (entry.status === "dormant") continue;
        const requiredTests = entry.required || entry.match || [];
        const supportingTests = entry.supporting || [];
        const contradictingTests = entry.contradicting || entry.excludes || [];
        if (!contextGatePasses(entry, genre)) continue;
        const required = requiredTests.map(test => ({ test, ...condition(test, primitives) }));
        if (!required.length || required.some(item => !item.pass)) continue;
        const contradicting = contradictingTests.map(test => ({ test, ...condition(test, primitives) }));
        if (contradicting.some(item => item.pass)) continue;
        const supporting = supportingTests.map(test => ({ test, ...condition(test, primitives) }));
        const passedSupport = supporting.filter(item => item.pass);
        const base = entry.confidenceRule === "average"
          ? required.reduce((sum, item) => sum + item.score, 0) / required.length
          : Math.min(...required.map(item => item.score));
        const supportBoost = supporting.length ? passedSupport.reduce((sum, item) => sum + item.score, 0) /
          supporting.length * 0.12 : 0;
        const multiplier = contextMultiplier(entry, genre);
        const confidence = clamp(base * multiplier + supportBoost);
        if (confidence < (entry.minConfidence ?? 0.58)) continue;
        const wording = chooseText(entry, genre);
        const anchorPaths = [...new Set([...(entry.anchors || []), ...requiredTests.map(item => item.path),
          ...passedSupport.map(item => item.test.path)])];
        const ttlMs = Math.max(2000, Number(entry.ttlMs || entry.persistenceMs) || (entry.facet === "live" ? 5000 : 12000));
        result.push({
          id: entry.id, idiomId: entry.id, primitiveId: requiredTests.map(item => item.path),
          text: wording.text, category: entry.facet || "arrangement", facet: entry.facet || "arrangement",
          confidence, neutral: wording.neutral, source: "idiom", semanticFamily: familyFor(entry),
          anchors: anchorPaths.map(path => `primitives.${path}`),
          requiredEvidence: required.map(item => ({ path: item.test.path, value: item.value, score: item.score })),
          supportingEvidence: passedSupport.map(item => ({ path: item.test.path, value: item.value, score: item.score })),
          contradictingEvidence: contradicting.filter(item => item.available).map(item => ({ path: item.test.path, value: item.value, pass: item.pass })),
          contextMultiplier: multiplier, persistenceMs: Number(entry.persistenceMs) || ttlMs,
          ttlMs, volatility: entry.facet === "live" ? "very-fast" : "medium"
        });
      }
      const unique = new Map();
      for (const item of result.sort((a, b) => b.confidence - a.confidence || a.text.localeCompare(b.text)))
        if (!unique.has(item.text)) unique.set(item.text, item);
      return [...unique.values()];
    }
  }

  return { Engine, condition, read, compileGraph, familyFor, genreValues, contextGatePasses, contextMultiplier };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MusicalIdioms;
