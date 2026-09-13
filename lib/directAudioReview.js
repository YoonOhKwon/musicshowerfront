const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("../js/semantic/semanticFacets");
const OpenWorld = typeof OpenWorldConceptRegistry !== "undefined" ? OpenWorldConceptRegistry : (() => {
  try { return require("../js/semantic/openWorldConceptRegistry"); } catch { return null; }
})();
const GenreLabels = typeof GenreLabelShape !== "undefined" ? GenreLabelShape : require("../js/semantic/genreLabelShape");
const FlamingoReservoir = typeof FlamingoWordReservoir !== "undefined" ? FlamingoWordReservoir : require("../js/semantic/flamingoWordReservoir");
const DirectAudioRealizer = (typeof globalThis !== "undefined" && globalThis.DirectAudioRealizer) ? globalThis.DirectAudioRealizer : (() => {
  try { return require("./directAudioRealizer"); } catch { return null; }
})();

// Open-World Multimodal Deep Listening Bridge:
// Bridges structured or semi-structured direct-audio observations from Music Flamingo into
// candidate observations for evidence fusion (evidenceFusionEngine.js) and temporal evidence
// (temporalEvidenceEngine.js).
//
// Crucial Principles:
// 1. NO HUMAN APPROVAL WORKFLOW: All verification is automated via multimodal evidence fusion,
//    temporal consistency, and language critic.
// 2. NO CLOSED-WORLD WHITELIST: Flamingo can discover and hypothesize unexpected genres, microgenres,
//    scenes, eras, and aesthetic idioms. Unregistered items are registered in OpenWorldConceptRegistry.
// 3. MULTI-CONCEPT DECOMPOSITION: A single deep listening capture simultaneously populates FACT,
//    CONTEXT, AESTHETIC, and IMPRESSION candidates.
// 4. TEMPORAL INTEGRITY: Every observation is stamped with a unique `observationId` so repeated
//    semantic ticks do not artificially inflate temporal counts.

const CULTURAL = /(\d{2,4}년대|(?:19|20)\d0s\b|향수|nostalg|retro|vintage|aesthetics?|\bfeel\b|scene|culture|artist|연상)/i;
const MUSICAL = /(bpm|키|장조|단조|킥|스네어|하이햇|베이스|보컬|신스|피아노|기타|색소폰|리듬|그루브|화성|멜로디|하모니|tempo|drum|bass|vocal|synth|piano|guitar|rhythm|groove|harmony|melody|arpeggio|subdivision|syncopation)/i;
const split = text => String(text || '').split(/[.!?。！？\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 40);

const clampConfidence = value => Math.max(0, Math.min(1, Number(value) || 0));

// Music Flamingo's self-reported probabilities are language-model confidence, not calibrated
// certainty. Calibrate every semantic layer, not only FACT: an aesthetic or genre claim at 0.99 is
// still one model observation. The registry may strengthen it later with independent windows.
function calibrateStructuredPacket(packet, continuity = {}) {
  if (!packet || typeof packet !== 'object') return packet || null;
  const listeningMode = continuity?.listeningMode === 'assisted' || continuity?.genreAdvisoryUsed
    ? 'assisted' : 'independent';
  const calibrated = { ...packet };
  const firstImpression = continuity?.listenDepth === 'first-impression';
  const independentCaps = {
    audibleObservations: 0.72, signatureRelations: 0.70, styleCues: 0.70, genreHypotheses: 0.76,
    contextHypotheses: 0.68, aestheticConcepts: 0.72, impressions: 0.72
  };
  const assistedCaps = {
    audibleObservations: 0.58, signatureRelations: 0.56, styleCues: 0.56, genreHypotheses: 0.60,
    contextHypotheses: 0.56, aestheticConcepts: 0.60, impressions: 0.60
  };
  for (const [field, independentCap] of Object.entries(independentCaps)) {
    const values = Array.isArray(packet[field]) ? packet[field] : [];
    calibrated[field] = values.map(raw => {
      if (typeof raw === 'string') return raw;
      if (!raw || typeof raw !== 'object') return raw;
      const modelConfidence = clampConfidence(raw.confidence ?? 0.65);
      let confidenceCap = listeningMode === 'assisted' ? assistedCaps[field] : independentCap;
      if (firstImpression) {
        if (field === "genreHypotheses") confidenceCap = Math.min(confidenceCap, 0.48);
        if (["aestheticConcepts", "impressions"].includes(field)) {
          confidenceCap = Math.min(confidenceCap, 0.60);
        }
      }
      return {
        ...raw,
        modelConfidence,
        confidence: Math.min(modelConfidence, confidenceCap),
        listeningMode,
        independent: listeningMode !== "assisted",
        provisional: firstImpression && ["genreHypotheses", "aestheticConcepts", "impressions"].includes(field)
      };
    });
  }
  return calibrated;
}

function reviewCaption(result = {}, brief = {}) {
  const observationId = result.observationId || `obs-${result.audioSha256 ? result.audioSha256.slice(0, 12) : Date.now()}-${Date.now()}`;
  const independenceGroup = result.independenceGroup || observationId;
  const audioSegmentId = result.audioSegmentId || (result.audioSha256 ? `seg-${result.audioSha256.slice(0, 8)}` : null);
  const structured = calibrateStructuredPacket(result.structuredPacket || null, result.continuity || {});
  const captionText = result.caption || "";
  const sentences = split(captionText);

  const claims = sentences.map((text, index) => ({
    id: `audio-caption-${index + 1}`,
    text,
    type: CULTURAL.test(text) ? 'cultural-or-historical' : MUSICAL.test(text) ? 'musical-claim' : 'impression',
    observationId,
    independenceGroup,
    audioSegmentId
  }));

  const musicalClaims = claims.filter(x => x.type === 'musical-claim');
  const culturalClaims = claims.filter(x => x.type === 'cultural-or-historical');
  const impressionClaims = claims.filter(x => x.type === 'impression');

  const baseline = String(brief.synopsis || '').toLowerCase();
  const overlap = musicalClaims.filter(x => {
    const words = x.text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return words.length && words.some(word => baseline.includes(word));
  }).length;

  return {
    schemaVersion: 2,
    status: 'auto-fused',
    // Compatibility field only: this is an automatic evidence path, never a human approval step.
    approvedForDisplay: true,
    automaticEvidence: true,
    provider: result.provider || 'music-flamingo',
    sessionId: result.sessionId ?? null,
    activeAudioMs: Number(result.activeAudioMs) || 0,
    continuity: result.continuity || null,
    audioSha256: result.audioSha256 || null,
    observationId,
    independenceGroup,
    audioSegmentId,
    structuredPacket: structured,
    claims,
    metrics: {
      sentenceCount: claims.length,
      musicalClaimCount: musicalClaims.length,
      culturalClaimCount: culturalClaims.length,
      impressionClaimCount: impressionClaims.length,
      baselineOverlapRatio: musicalClaims.length ? overlap / musicalClaims.length : 0
    }
  };
}

function cleanObservationText(val) {
  if (typeof val !== 'string') return '';
  let cleaned = val.replace(/[{}\[\]"':;,]/g, ' ').replace(/^[\s.\-_/]+|[\s.\-_/]+$/g, '').replace(/\s+/g, ' ').trim();
  // The model sometimes bleeds a genreHypotheses-shaped "<confidence> reasoning: ..." string
  // into a plain array item (e.g. audibleObservations) instead of a short phrase. Strip that
  // leaked confidence+reasoning prefix before the keyword-prefix check below can see it.
  cleaned = cleaned.replace(/^\d+(?:\.\d+)?\s*reasoning(?:hints)?\b\s*/i, '').trim();
  if (/^(?:audibleObservations|genreHypotheses|contextHypotheses|aestheticConcepts|impressions|uncertainties|reasoning|confidence|category|label|text)\b/i.test(cleaned)) {
    return '';
  }
  // A literal "reasoning"/"confidence" token surviving anywhere means this is still leaked
  // JSON scaffolding, not real observation text -- drop it rather than display it.
  if (/\b(?:reasoning(?:hints)?|confidence)\b/i.test(cleaned)) return '';
  if (!/[a-zA-Z가-힣]{2,}/.test(cleaned)) return '';
  if (/^(?:context|audible|genre|aesthetic|impression)\s*$/i.test(cleaned)) return '';
  return cleaned.length >= 2 ? cleaned : '';
}

// International genre labels often read best as-is (Mallsoft, Gqom, Singeli). Descriptive
// English, however, is source evidence rather than finished Korean UI copy.
function requiresKoreanRealization(text, category) {
  return category !== 'genre' && !/[가-힣]/.test(String(text || ''));
}

function toObservations(review = {}, options = {}) {
  const observations = [];
  const observationId = review.observationId || `obs-${Date.now()}`;
  const independenceGroup = review.independenceGroup || options.independenceGroup || observationId;
  const audioSegmentId = review.audioSegmentId || options.audioSegmentId || null;
  const provider = review.provider || 'music-flamingo';
  const structured = review.structuredPacket;

  const trackEpoch = review.trackEpoch !== undefined ? Number(review.trackEpoch) : (options.trackEpoch !== undefined ? Number(options.trackEpoch) : 0);
  const requestId = review.requestId || options.requestId || null;
  const genreAdvisoryCandidates = Array.isArray(review.continuity?.genreAdvisoryCandidates)
    ? review.continuity.genreAdvisoryCandidates.slice(0, 5) : [];
  const conditionedOnClassifier = Boolean(review.continuity?.genreAdvisoryUsed && genreAdvisoryCandidates.length);
  const independent = review.continuity?.independent !== false && !conditionedOnClassifier;

  const baseMeta = {
    source: 'directAudio',
    sourceFamily: 'directAudio',
    sourceModel: provider,
    observationId,
    independenceGroup,
    audioSegmentId,
    trackEpoch,
    requestId,
    independent,
    conditionedOnClassifier,
    conditioningSources: conditionedOnClassifier ? ["genreModel"] : [],
    conditioningCandidateLabels: genreAdvisoryCandidates
  };

  if (structured) {
    // 1. Audible musical observations (FACT/LIVE)
    for (const obs of structured.audibleObservations || []) {
      const rawText = typeof obs === 'string' ? obs : obs?.text;
      const text = cleanObservationText(rawText);
      const category = FlamingoReservoir.factFacetFor(obs?.category);
      const conf = obs?.confidence ?? 0.65;
      if (text && category && category !== "live") {
        observations.push(Facets.token(text, category, conf, ['directAudioEvidence.audible'], {
          ...baseMeta,
          evidenceType: 'audibleObservation', sourceText: text,
          evidenceId: obs?.id || null,
          reasoningHints: obs?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, category),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, category) : []
        }));
      }
    }

    // 2. Recording-specific relations (FACT). These preserve why this recording differs from
    // another track with the same ingredients, without converting the relation into genre first.
    for (const relation of structured.signatureRelations || []) {
      const rawText = typeof relation === 'string' ? relation : relation?.text;
      const text = cleanObservationText(rawText);
      const conf = relation?.confidence ?? 0.60;
      if (text) {
        observations.push(Facets.token(text, 'arrangement', conf, ['directAudioEvidence.signature'], {
          ...baseMeta,
          evidenceType: 'signatureRelation', sourceText: text,
          evidenceId: relation?.id || null,
          supportRefs: Array.isArray(relation?.supportRefs) ? relation.supportRefs : [],
          reasoningHints: relation?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, 'arrangement'),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, 'fact') : []
        }));
      }
    }

    // 3. Genre hypotheses (CONTEXT / genre)
    for (const g of structured.genreHypotheses || []) {
      const rawLabel = typeof g === 'string' ? g : g?.label;
      const label = cleanObservationText(rawLabel);
      const conf = g?.confidence ?? 0.62;
      if (label && GenreLabels.isPlausibleGenreLabel(label)) {
        observations.push(Facets.token(label, 'genre', conf, ['directAudioEvidence.genre'], {
          ...baseMeta,
          evidenceType: 'genreHypothesis',
          sourceText: label,
          supportRefs: Array.isArray(g?.supportRefs) ? g.supportRefs : [],
          reasoningHints: g?.reasoningHints || null,
          provisional: Boolean(g?.provisional),
          requiresKoreanRealization: false,
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(label, 'genre') : []
        }));
      }
    }

    // 4. Context hypotheses (CONTEXT / scene, era, culture, lineage)
    for (const ctx of structured.contextHypotheses || []) {
      const rawText = typeof ctx === 'string' ? ctx : ctx?.text;
      const text = cleanObservationText(rawText);
      const requested = String(ctx?.category || "").toLowerCase();
      const category = ["scene", "era", "culture", "lineage"].includes(requested) ? requested : null;
      const conf = ctx?.confidence ?? 0.55;
      if (text && category) {
        observations.push(Facets.token(text, category, conf, ['directAudioEvidence.context'], {
          ...baseMeta,
          evidenceType: 'contextHypothesis', sourceText: text,
          supportRefs: Array.isArray(ctx?.supportRefs) ? ctx.supportRefs : [],
          reasoningHints: ctx?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, category),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, category) : []
        }));
      }
    }

    // 5. Aesthetic concepts (AESTHETIC)
    for (const ast of structured.aestheticConcepts || []) {
      const rawText = typeof ast === 'string' ? ast : ast?.text;
      const text = cleanObservationText(rawText);
      const conf = ast?.confidence ?? 0.58;
      if (text) {
        observations.push(Facets.token(text, 'association', conf, ['directAudioEvidence.aesthetic'], {
          ...baseMeta,
          evidenceType: 'aestheticConcept', sourceText: text,
          supportRefs: Array.isArray(ast?.supportRefs) ? ast.supportRefs : [],
          reasoningHints: ast?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, 'association'),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, 'aesthetic') : []
        }));
      }
    }

    // 6. Impressions (IMPRESSION)
    for (const imp of structured.impressions || []) {
      const rawText = typeof imp === 'string' ? imp : imp?.text;
      const text = cleanObservationText(rawText);
      const conf = imp?.confidence ?? 0.55;
      if (text) {
        observations.push(Facets.token(text, 'mood', conf, ['directAudioEvidence.impression'], {
          ...baseMeta,
          evidenceType: 'impression', sourceText: text,
          supportRefs: Array.isArray(imp?.supportRefs) ? imp.supportRefs : [],
          reasoningHints: imp?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, 'mood'),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, 'impression') : []
        }));
      }
    }
  }

  // Structured parsing is the semantic authority. If it produced no usable observations, keep
  // the raw caption in diagnostics but do not guess subjective meaning from developer keywords.
  if (structured) return observations;

  return [];
}

module.exports = { reviewCaption, toObservations, split, calibrateStructuredPacket };
