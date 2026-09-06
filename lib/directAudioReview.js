const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("../js/semantic/semanticFacets");
const OpenWorld = typeof OpenWorldConceptRegistry !== "undefined" ? OpenWorldConceptRegistry : (() => {
  try { return require("../js/semantic/openWorldConceptRegistry"); } catch { return null; }
})();
const GenreLabels = typeof GenreLabelShape !== "undefined" ? GenreLabelShape : require("../js/semantic/genreLabelShape");
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

const CULTURAL = /(\d{2,4}년대|(19|20)?\d0s\b|일본|러시아|영국|미국|도쿄|버블경제|pirate radio|anime|y2k|vaporwave|synthwave|chillwave|cyberpunk|retro|vintage|nostalgic|futurist|scene|culture|artist|연상|코어|core|future funk|city pop|house|techno|ambient|post-punk|gqom|singeli|mallsoft)/i;
const MUSICAL = /(bpm|키|장조|단조|킥|스네어|하이햇|베이스|보컬|신스|피아노|기타|색소폰|리듬|그루브|화성|멜로디|하모니|tempo|drum|bass|vocal|synth|piano|guitar|rhythm|groove|harmony|melody|arpeggio|subdivision|syncopation)/i;
const split = text => String(text || '').split(/[.!?。！？\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 40);

function reviewCaption(result = {}, brief = {}) {
  const observationId = result.observationId || `obs-${result.audioSha256 ? result.audioSha256.slice(0, 12) : Date.now()}-${Date.now()}`;
  const independenceGroup = result.independenceGroup || observationId;
  const audioSegmentId = result.audioSegmentId || (result.audioSha256 ? `seg-${result.audioSha256.slice(0, 8)}` : null);
  const structured = result.structuredPacket || null;
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

// Fallback label maps used as fast priors (NOT exclusive whitelists)
const MUSICAL_PRIORS = {
  bpm: '템포감', 'tempo': '템포감', 키: '조성 인상', 장조: '장조 인상', 단조: '단조 인상',
  킥: '킥 존재감', 스네어: '스네어 존재감', 하이햇: '하이햇 존재감',
  베이스: '베이스감', bass: '베이스감', 보컬: '보컬 존재감', vocal: '보컬 존재감',
  신스: '신스 텍스처', synth: '신스 텍스처', 피아노: '피아노 텍스처', piano: '피아노 텍스처',
  기타: '기타 텍스처', guitar: '기타 텍스처', 색소폰: '색소폰 텍스처',
  리듬: '리듬 인상', rhythm: '리듬 인상', 그루브: '그루브감', groove: '그루브감',
  화성: '화성 흐름', harmony: '화성 흐름', 하모니: '화성 흐름', 멜로디: '멜로디 인상', melody: '멜로디 인상'
};
const CULTURAL_PRIORS = {
  일본: '일본풍 연상', 도쿄: '도쿄풍 연상', 러시아: '러시아풍 연상', 영국: '영국풍 연상', 미국: '미국풍 연상',
  버블경제: '버블경제 미학 연상', 'pirate radio': '해적 라디오 연상', anime: '애니메이션 미학 연상',
  y2k: 'Y2K 미학 연상', vaporwave: '베이퍼웨이브 미학 연상', synthwave: '신스웨이브 미학 연상',
  chillwave: '칠웨이브 미학 연상', cyberpunk: '사이버펑크 미학 연상', retro: '레트로 미학 연상',
  vintage: '빈티지 미학 연상', nostalgic: '노스탤지어 연상', futurist: '퓨처리스트 미학 연상',
  '(19|20)?\\d0s\\b': '레트로 연대 감성 연상',
  scene: '씬 연상', culture: '문화 연상', artist: '스타일 연상'
};
const IMPRESSION_PRIORS = {
  energetic: '활기찬 인상', melancholic: '애상적 인상', uplifting: '고양되는 인상',
  driving: '몰아붙이는 인상', dreamy: '몽환적 인상', polished: '정제된 인상',
  'groov(y|ing)': '그루브한 인상', mellow: '차분한 인상', dark: '어두운 인상',
  bright: '밝은 인상', intense: '강렬한 인상', calm: '고요한 인상', lush: '풍성한 인상'
};

const PRIORS_BY_TYPE = {
  'musical-claim': MUSICAL_PRIORS,
  'cultural-or-historical': CULTURAL_PRIORS,
  impression: IMPRESSION_PRIORS
};

function priorLabelFor(text, type) {
  const map = PRIORS_BY_TYPE[type];
  if (!map) return null;
  for (const [keyword, label] of Object.entries(map)) {
    if (new RegExp(keyword, 'i').test(text)) return label;
  }
  return null;
}

const TYPE_TO_CATEGORY = {
  'musical-claim': 'production',
  'cultural-or-historical': 'association',
  impression: 'mood'
};
const TYPE_TO_CONFIDENCE = {
  'musical-claim': 0.60,
  'cultural-or-historical': 0.45,
  impression: 0.50
};

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

  const baseMeta = {
    source: 'directAudio',
    sourceFamily: 'directAudio',
    sourceModel: provider,
    observationId,
    independenceGroup,
    audioSegmentId,
    trackEpoch,
    requestId
  };

  if (structured) {
    // 1. Audible musical observations (FACT/LIVE)
    for (const obs of structured.audibleObservations || []) {
      const rawText = typeof obs === 'string' ? obs : obs?.text;
      const text = cleanObservationText(rawText);
      const category = obs?.category || 'production';
      const conf = obs?.confidence ?? 0.65;
      if (text) {
        observations.push(Facets.token(text, category, conf, ['directAudioEvidence.audible'], {
          ...baseMeta,
          evidenceType: 'audibleObservation', sourceText: text,
          reasoningHints: obs?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, category),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, category) : []
        }));
      }
    }

    // 2. Genre hypotheses (CONTEXT / genre)
    for (const g of structured.genreHypotheses || []) {
      const rawLabel = typeof g === 'string' ? g : g?.label;
      const label = cleanObservationText(rawLabel);
      const conf = g?.confidence ?? 0.62;
      if (label && GenreLabels.isPlausibleGenreLabel(label)) {
        observations.push(Facets.token(label, 'genre', conf, ['directAudioEvidence.genre'], {
          ...baseMeta,
          evidenceType: 'genreHypothesis',
          sourceText: label,
          reasoningHints: g?.reasoningHints || null,
          requiresKoreanRealization: false,
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(label, 'genre') : []
        }));
      } else if (label) {
        // Preserve the listening observation, but correct the facet. This is deliberately a
        // grammar/shape decision rather than a genre whitelist, so novel labels remain open.
        const category = GenreLabels.fallbackCategory(label);
        const anchor = category === 'production' ? 'directAudioEvidence.audible'
          : category === 'association' ? 'directAudioEvidence.aesthetic' : 'directAudioEvidence.impression';
        observations.push(Facets.token(label, category, Math.min(conf, 0.58), [anchor], {
          ...baseMeta,
          evidenceType: 'misfiledGenreDescription', sourceText: label,
          reasoningHints: g?.reasoningHints || null,
          reclassifiedFrom: 'genre',
          requiresKoreanRealization: requiresKoreanRealization(label, category),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(label, category) : []
        }));
      }
    }

    // 3. Context hypotheses (CONTEXT / scene, era, culture, lineage)
    for (const ctx of structured.contextHypotheses || []) {
      const rawText = typeof ctx === 'string' ? ctx : ctx?.text;
      const text = cleanObservationText(rawText);
      const category = ctx?.category || 'association';
      const conf = ctx?.confidence ?? 0.55;
      if (text) {
        observations.push(Facets.token(text, category, conf, ['directAudioEvidence.context'], {
          ...baseMeta,
          evidenceType: 'contextHypothesis', sourceText: text,
          reasoningHints: ctx?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, category),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, category) : []
        }));
      }
    }

    // 4. Aesthetic concepts (AESTHETIC)
    for (const ast of structured.aestheticConcepts || []) {
      const rawText = typeof ast === 'string' ? ast : ast?.text;
      const text = cleanObservationText(rawText);
      const conf = ast?.confidence ?? 0.58;
      if (text) {
        observations.push(Facets.token(text, 'association', conf, ['directAudioEvidence.aesthetic'], {
          ...baseMeta,
          evidenceType: 'aestheticConcept', sourceText: text,
          reasoningHints: ast?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, 'association'),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, 'aesthetic') : []
        }));
      }
    }

    // 5. Impressions (IMPRESSION)
    for (const imp of structured.impressions || []) {
      const rawText = typeof imp === 'string' ? imp : imp?.text;
      const text = cleanObservationText(rawText);
      const conf = imp?.confidence ?? 0.55;
      if (text) {
        observations.push(Facets.token(text, 'mood', conf, ['directAudioEvidence.impression'], {
          ...baseMeta,
          evidenceType: 'impression', sourceText: text,
          reasoningHints: imp?.reasoningHints || null,
          requiresKoreanRealization: requiresKoreanRealization(text, 'mood'),
          realizations: DirectAudioRealizer ? DirectAudioRealizer.realize(text, 'impression') : []
        }));
      }
    }
  }

  // If structured yielded observations, return them
  if (observations.length > 0) return observations;

  // Fallback: Sentence-based decomposition of caption prose
  for (const claim of review.claims || []) {
    const category = TYPE_TO_CATEGORY[claim.type];
    if (!category) continue;

    // Use prior label if available, otherwise generate clean grounded phrasing
    let label = priorLabelFor(claim.text, claim.type);
    if (!label) label = cleanObservationText(claim.text).slice(0, 60);

    if (!label) continue;

    observations.push(Facets.token(label, category, TYPE_TO_CONFIDENCE[claim.type],
      ['directAudioEvidence.caption'], {
        ...baseMeta,
        claimId: claim.id,
        evidenceType: claim.type,
        sourceText: claim.text,
        requiresKoreanRealization: requiresKoreanRealization(label, category)
      }));
  }

  return observations;
}

module.exports = { reviewCaption, toObservations, split };
