const LanguageCritic = (() => {
  const Expressions = typeof MusicExpressionEngine !== "undefined" ? MusicExpressionEngine : require("./musicExpressionEngine");
  const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("./semanticFacets");
  const Layers = typeof LanguageLayerPolicy !== "undefined" ? LanguageLayerPolicy : require("./languageLayerPolicy");
  const Quality = typeof PhraseQuality !== "undefined" ? PhraseQuality : require("./phraseQuality");
  const Firewall = typeof FactFirewall !== "undefined" ? FactFirewall : require("./factFirewall");
  const Genome = typeof PhraseGenome !== "undefined" ? PhraseGenome : require("./phraseGenome");
  const GENERIC = new Set(["빛", "파동", "잔광", "입자", "맥동", "흐름", "공간", "진동"]);
  const CLICHE_TERMS = ["과열된", "냉각된", "저중력", "무중력", "황홀한 압력", "분홍빛", "금속성 황홀", "분석 중", "재생해주세요"];
  const AI_CLICHE_FAMILIES = new Set(["dreamlike", "neon-city", "light-glass", "space-reverb", "warmth"]);
  const clamp = Facets.clamp;
  const textOf = value => typeof value === "object" ? value?.text : value;
  const normalize = text => Expressions.canonical(String(textOf(text) || "").replace(/\s+/g, " ").trim());
  const semanticKey = value => Quality.conceptKey(typeof value === "object" ? { ...value, text: normalize(value) } : normalize(value));
  function similarity(a, b) {
    if (Quality.sameConcept(a, b)) return 1;
    const grams = text => { const s = normalize(text).replace(/\s/g, ""); return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2))); };
    const x = grams(a), y = grams(b);
    const shared = [...x].filter(g => y.has(g)).length;
    return shared / Math.max(1, x.size + y.size - shared);
  }
  const validKorean = text => /^[가-힣\s]+$/.test(text) && text.length <= 24;
  function categoryFor(text, category) {
    if (Facets.names.includes(category)) return category;
    return Object.keys(Expressions.vocabulary).find(key => Expressions.vocabulary[key].includes(normalize(text)));
  }
  function validExpression(text, category) { return Facets.safeText(text, category) && !GENERIC.has(text); }
  function assess(candidate, recent = [], context = {}) {
    const text = normalize(candidate?.text ?? candidate), category = categoryFor(text, candidate?.category);
    // Decorating WITH the snapshot lets specificity/contrastiveness be computed from the actual
    // music instead of per-layer constants; any model-supplied score is blended in as a proposal.
    const item = Layers.decorate({ ...(typeof candidate === "object" ? candidate : {}), text, category },
      { snapshot: context.snapshot });
    const anchors = item.anchors;
    const isDirectAudio = item.sourceFamily === "directAudio" || item.source === "directAudio" ||
      item.resolutionMomentum === true || anchors.some(a => String(a).startsWith("directAudioEvidence"));
    const knownVocabulary = Expressions.vocabulary[category]?.includes(text);
    const eligible = context.eligibleTexts;
    let relevant = isDirectAudio || (eligible ? eligible.some(item => semanticKey(item) === semanticKey(text)) : Boolean(knownVocabulary || category === "genre"));
    const evidence = Facets.support(item, { ...context,
      eligibleTexts: relevant ? [text] : [] });
    // Tracks WHY relevance ended up where it did, so a rejection can name the real cause
    // (evidence.reason) instead of the generic "not relevant" label when evidence is what decided it.
    let relevanceViaEvidence = false;
    if (!relevant && category === "genre") {
      relevant = (context.snapshot?.genreEvidence || []).some(item => semanticKey(item.label) === semanticKey(text) && item.confidence >= 0.65);
      if (!relevant && context.snapshot?.analysisWindow?.windowSeconds >= 20 && item.confidence >= 0.75 && evidence.supported) relevant = true;
      if (!relevant) relevanceViaEvidence = true;
    } else if (!relevant && !knownVocabulary) { relevant = evidence.supported; relevanceViaEvidence = true; }
    // Exact claims always need their dedicated gate, even if they appear in a local pool.
    if (!isDirectAudio && (/솔로|solo|워킹 베이스|walking bass|트리오|trio|사이드체인|sidechain|필터 스윕|filter sweep|스테레오|stereo|보컬 찹|vocal chop|샘플 기반|sample.based/i.test(text) ||
        Facets.contextual.has(category))) relevant = relevant && evidence.supported;
    const recentSimilarity = recent.reduce((max, item) => Math.max(max, similarity(text, item?.text || item)), 0);
    const musicalFit = clamp(item.musicalFit ?? 0.85), clarity = clamp(item.clarity ?? 0.95);
    const naturalness = clamp(item.languageQuality ?? 0.95);
    const confidence = candidate?.confidence === undefined ? (knownVocabulary ? 0.8 : (item.openWorld || isDirectAudio ? 0.7 : 0)) : clamp(item.confidence);
    // Novelty is measured against what the screen actually said recently, at concept level:
    // "달콤한 향수" and "달콤한 회고" are not two fresh phrases.
    const localNovelty = Quality.novelty(item, recent);
    const effectiveNovelty = clamp(Math.min(Quality.blend(item.proposal?.novelty, localNovelty),
      1 - recentSimilarity * 0.8));
    let specificity = item.specificity;
    const abstractTerms = (text.match(/네온|꿈|별빛|파동|기억|심장|유리빛|몽환|고독|향수|낭만|애상|낙관|부유감/gu) || []).length;
    const evidenceAxes = Object.values(item.evidence).filter(paths => paths.length).length;
    const independentEvidenceAxes = evidence.evidenceAxes?.length || evidenceAxes;
    const semanticFamily = Quality.semanticFamily(item);
    const recentFamilyCount = recent.filter(previous => Quality.semanticFamily(previous) === semanticFamily).length;
    const mechanicalPhrase = /^(?:몽환적|찬란한|부드러운|기계적|신비로운|아름다운)\s+(?:질감|리듬|향수|에너지|분위기)$/.test(text);
    // A raw descriptor ("차가움") or a plain common mood word ("몽환적") is honest language, not
    // invented poetry: both earn low specificity and therefore low priority, but stay usable.
    // The rejection is reserved for mechanical compounds and ungrounded abstract imagery.
    const plainVocabulary = item.primitive || Quality.isGeneric(text);
    const genericPoetry = ["AESTHETIC", "IMPRESSION"].includes(item.layer) &&
      (mechanicalPhrase || (!plainVocabulary && specificity < 0.42) || (abstractTerms >= 2 && evidenceAxes < 2));
    const factPoetry = item.layer === "FACT" && /향수|낭만|애상|낙관주의|부유감|미학|감성/.test(text);
    const factLicense = Firewall.inspect(text, context.snapshot?.verifiedClaims || context.verifiedClaims);
    const unlicensedFact = (item.layer === "FACT" || item.layer === "LIVE") && !factLicense.licensed && !isDirectAudio;
    const aiCliche = item.source === "llm" && ["AESTHETIC", "IMPRESSION"].includes(item.layer) &&
      AI_CLICHE_FAMILIES.has(semanticFamily) && independentEvidenceAxes < 2;
    const aiClichePenalty = (AI_CLICHE_FAMILIES.has(semanticFamily) ? Math.min(0.24, recentFamilyCount * 0.1) : 0) +
      (aiCliche ? 0.5 : 0);
    if (mechanicalPhrase) specificity *= 0.45;
    const evidenceScore = evidence.evidenceScore || (relevant ? confidence * 0.82 : 0);
    const score = clamp(musicalFit * 0.14 + clarity * 0.12 + naturalness * 0.11 + Number(relevant) * 0.13 +
      confidence * 0.13 + specificity * 0.1 + effectiveNovelty * 0.08 + item.contrastiveness * 0.07 +
      evidenceScore * 0.12 - recentSimilarity * 0.12 - (genericPoetry || factPoetry ? 0.45 : 0) - aiClichePenalty);
    const expressionValid = Boolean(validExpression(text, category));
    const layerValid = Layers.allowed(category, item.layer);
    // Unresolvable anchors are priced into evidenceScore rather than being an instant veto.
    const valid = expressionValid && layerValid && relevant && evidence.supported &&
      !genericPoetry && !factPoetry && !aiCliche && !unlicensedFact &&
      (category !== "genre" || candidate?.confidence === undefined || confidence >= 0.55);
    const contradiction = evidence.contradiction || 0;
    const contradicted = (evidence.claimDetails || []).filter(detail => detail.contradiction > 0)
      .map(detail => `${detail.path}=${detail.value.toFixed(2)} vs claimed ${detail.feature} ${detail.direction}`);
    // Every failed gate, not just the first one hit — debugging "why didn't this show up" needs
    // the full picture. A single representative rejectionReason is kept for existing consumers.
    const reasons = [];
    if (!expressionValid) reasons.push("invalid-expression");
    if (!layerValid) reasons.push("layer-facet-mismatch");
    if (!evidence.supported) reasons.push(evidence.reason || "insufficient-evidence");
    // Only add the generic label when relevance failed for a reason INDEPENDENT of evidence
    // (no local-pool match, not known vocabulary, not a genre-label match) — otherwise it just
    // duplicates (and masks) the evidence.reason already pushed above.
    if (!relevant && !relevanceViaEvidence) reasons.push("not-relevant-to-current-state");
    if (genericPoetry) reasons.push("generic-ai-poetry");
    if (factPoetry) reasons.push("fact-cannot-be-poetic");
    if (unlicensedFact) reasons.push("UNLICENSED_FACT_TERM");
    if (aiCliche) reasons.push("ai-cliche-ungrounded");
    if (category === "genre" && candidate?.confidence !== undefined && confidence < 0.55) reasons.push("genre-confidence-low");
    if (recentSimilarity > 0.85) reasons.push("duplicate-concept");
    const rejectionReason = valid ? "accepted" : (reasons[0] || "insufficient-evidence");
    const genomed = Genome.decorate(item);
    return { ...genomed, text, category, semanticKey: semanticKey(item), type: text.includes(" ") ? "fragment" : "single",
      perspective: category, anchors, confidence, specificity, novelty: effectiveNovelty,
      evidenceScore, score, weight: score, grammar: text.includes(" ") ? "phrase" : "single", valid,
      diagnostics: { musicalFit, clarity, naturalness, specificity, novelty: effectiveNovelty,
        contrastiveness: item.contrastiveness, stateRelevance: Number(relevant), recentSimilarity,
        invalidAnchors: evidence.invalidAnchors, evidenceReason: evidence.reason, evidenceScore,
        evidenceThreshold: evidence.evidenceThreshold, evidenceGroups: evidence.groups, evidence: item.evidence,
        evidenceAxes: evidence.evidenceAxes || [], contradiction, contradicted, gates: {
          ...(evidence.gates || {}), relevancePass: Boolean(relevant), specificityPass: specificity >= 0.42,
          expressionPass: expressionValid, layerPass: layerValid
        },
        claims: evidence.claims || {}, proposal: item.proposal || {}, primitive: Boolean(item.primitive),
        source: item.source || "local", semanticFamily, aiClichePenalty, recentFamilyCount,
        // Anchor resolution transparency — what the model wrote, what it normalized to, and which
        // of those actually resolved against the live snapshot. Essential for prompt tuning.
        rawAnchors: item.rawAnchors || [], normalizedAnchors: anchors,
        resolvedAnchorRatio: evidence.evidenceComponents?.resolvedAnchorRatio ?? null,
        resolvedPaths: evidence.evidenceComponents?.resolvedPaths || [],
        unresolvedPaths: evidence.evidenceComponents?.unresolvedPaths || [],
        layer: item.layer, semanticDistance: item.semanticDistance, rejectionReason, reasons,
        claimsUsed: item.claimsUsed || [], operator: item.operator || null, genome: genomed.genome,
        factLicense: factLicense.reason || "licensed",
        contextualRisk: ["CONTEXT", "AESTHETIC"].includes(item.layer) ? 1 - confidence : 0 } };
  }
  function rank(candidates = [], { recent = [], context = {}, limit = 36 } = {}) {
    const assessed = candidates.slice(0, 100).map(item => assess(item, recent, context));
    const valid = assessed.filter(item => item.valid).sort((a, b) => b.score - a.score);
    const queues = Object.fromEntries(Layers.names.map(layer => [layer, valid.filter(item => item.layer === layer)]));
    const selected = [], seen = new Set(), seenText = new Set();
    const cycle = ["FACT", "CONTEXT", "FACT", "AESTHETIC", "LIVE", "IMPRESSION", "FACT", "CONTEXT"];
    while (selected.length < limit && cycle.some(layer => queues[layer].length)) {
      for (const layer of cycle) {
        let item;
        while ((item = queues[layer].shift()) &&
          (seen.has(item.semanticKey) || seenText.has(Quality.literalKey(item)))) { /* duplicate */ }
        if (!item) continue;
        selected.push(item); seen.add(item.semanticKey); seenText.add(Quality.literalKey(item));
        if (selected.length >= limit) break;
      }
    }
    return { assessed, selected,
      counts: Object.fromEntries(Facets.names.map(cat => [cat, selected.filter(x => x.category === cat).length])),
      layerCounts: Object.fromEntries(Layers.names.map(layer => [layer, selected.filter(x => x.layer === layer).length])) };
  }
  return { rank, assess, similarity, semanticKey, validExpression, categoryFor, grammarPattern: text => text.includes(" ") ? "phrase" : "single", validKorean, normalize, CLICHE_TERMS, GENERIC };
})();
if (typeof module !== "undefined" && module.exports) module.exports = LanguageCritic;
