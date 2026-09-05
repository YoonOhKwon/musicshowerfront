const Facets = typeof SemanticFacets !== "undefined" ? SemanticFacets : require("../js/semantic/semanticFacets");
// Bridge from a direct-audio caption (Music Flamingo) to real candidate observations for this
// project's existing evidence pipeline (js/semantic/evidenceFusionEngine.js ->
// js/semantic/temporalEvidenceEngine.js -> critic -> selection) -- the same pipeline every other
// evidence source (classifier, rhythm grammar, production detectors) already goes through. A
// single caption is a genuinely weaker source than a measured DSP signal (one holistic read of
// ~30s, no repeatability guarantee), so it earns lower starting confidence and, like every other
// source, must still accumulate real observations over time (via temporalEvidenceEngine's existing
// stability gates) before it becomes a stable claim -- it is not handed a shortcut to the screen.
// English additions here came from testing against a REAL Flamingo caption (see the commit this
// landed in): the model writes fluent English prose ("nostalgic Synthwave... retro-futurist
// aesthetics", "1980s"), not the narrow Korean/buzzword set this originally assumed -- without
// these, that exact sentence (the caption's richest aesthetic content) fell through to MUSICAL
// (matched "synth" inside "Synthwave") instead of being recognized as the cultural/era claim it is.
const CULTURAL = /(\d{2,4}년대|(19|20)?\d0s\b|일본|러시아|영국|미국|도쿄|버블경제|pirate radio|anime|y2k|vaporwave|synthwave|chillwave|cyberpunk|retro|vintage|nostalgic|futurist|scene|culture|artist|연상)/i;
const MUSICAL = /(bpm|키|장조|단조|킥|스네어|하이햇|베이스|보컬|신스|피아노|기타|색소폰|리듬|그루브|화성|멜로디|하모니|tempo|drum|bass|vocal|synth|piano|guitar|rhythm|groove|harmony|melody)/i;
const split = text => String(text || '').split(/[.!?。！？\n]+/).map(x => x.trim()).filter(Boolean).slice(0, 40);

function reviewCaption(result = {}, brief = {}) {
  const sentences = split(result.caption);
  const claims = sentences.map((text, index) => ({ id: `audio-caption-${index + 1}`, text,
    type: CULTURAL.test(text) ? 'cultural-or-historical' : MUSICAL.test(text) ? 'musical-claim' : 'impression',
    reviewRequired: true, approved: false }));
  const baseline = String(brief.synopsis || '').toLowerCase();
  const musicalClaims = claims.filter(x => x.type === 'musical-claim');
  const overlap = musicalClaims.filter(x => {
    const words = x.text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return words.length && words.some(word => baseline.includes(word));
  }).length;
  return { schemaVersion: 1, status: 'human-review-required', provider: result.provider || null,
    audioSha256: result.audioSha256 || null, claims, metrics: {
      sentenceCount: claims.length, musicalClaimCount: musicalClaims.length,
      culturalClaimCount: claims.filter(x => x.type === 'cultural-or-historical').length,
      baselineOverlapRatio: musicalClaims.length ? overlap / musicalClaims.length : 0
    }, policy: ['A single caption starts at reduced confidence and must accumulate real observations',
      '(temporalEvidenceEngine\'s existing stability gates) before becoming a stable claim, same as',
      'every other evidence source.',
      'Cultural/historical/artist associations stay qualified as association (AESTHETIC layer) --',
      'style comparison, never identification or origin claims.',
      'A claim rejected downstream (critic/safeText) must not be retried as a synonym.'] };
}

// Kept short and Korean-labeled on purpose: safeText() (js/semantic/semanticFacets.js) bounds
// candidate text to ~60 chars / 7-10 words, so a raw caption sentence (often a full English
// sentence) would simply never pass -- this makes the observation ABOUT the caption's real content
// (only produced when a real keyword actually matched) without trying to summarize free text.
// Split by claim type (mirroring MUSICAL/CULTURAL above) so a sentence classified as
// cultural-or-historical by a cultural keyword can never be labeled from an unrelated musical
// keyword that happens to also appear in it (or vice versa) -- extend the map for that TYPE only,
// never invent a label for an unmatched keyword.
const MUSICAL_LABELS = {
  bpm: '템포감', 'tempo': '템포감', 키: '조성 인상', 장조: '장조 인상', 단조: '단조 인상',
  킥: '킥 존재감', 스네어: '스네어 존재감', 하이햇: '하이햇 존재감',
  베이스: '베이스감', bass: '베이스감', 보컬: '보컬 존재감', vocal: '보컬 존재감',
  신스: '신스 텍스처', synth: '신스 텍스처', 피아노: '피아노 텍스처', piano: '피아노 텍스처',
  기타: '기타 텍스처', guitar: '기타 텍스처', 색소폰: '색소폰 텍스처',
  리듬: '리듬 인상', rhythm: '리듬 인상', 그루브: '그루브감', groove: '그루브감',
  화성: '화성 흐름', harmony: '화성 흐름', 하모니: '화성 흐름', 멜로디: '멜로디 인상', melody: '멜로디 인상'
};
const CULTURAL_LABELS = {
  일본: '일본풍 연상', 도쿄: '도쿄풍 연상', 러시아: '러시아풍 연상', 영국: '영국풍 연상', 미국: '미국풍 연상',
  버블경제: '버블경제 미학 연상', 'pirate radio': '해적 라디오 연상', anime: '애니메이션 미학 연상',
  y2k: 'Y2K 미학 연상', vaporwave: '베이퍼웨이브 미학 연상', synthwave: '신스웨이브 미학 연상',
  chillwave: '칠웨이브 미학 연상', cyberpunk: '사이버펑크 미학 연상', retro: '레트로 미학 연상',
  vintage: '빈티지 미학 연상', nostalgic: '노스탤지어 연상', futurist: '퓨처리스트 미학 연상',
  '(19|20)?\\d0s\\b': '레트로 연대 감성 연상',
  scene: '씬 연상', culture: '문화 연상', artist: '스타일 연상'
};
// Plain mood/feeling words with no era/place/scene reference -- these are IMPRESSION-layer, not
// AESTHETIC (no cultural/historical framing), matching this project's own layer distinction.
const IMPRESSION_LABELS = {
  energetic: '활기찬 인상', melancholic: '애상적 인상', uplifting: '고양되는 인상',
  driving: '몰아붙이는 인상', dreamy: '몽환적 인상', polished: '정제된 인상',
  'groov(y|ing)': '그루브한 인상', mellow: '차분한 인상', dark: '어두운 인상',
  bright: '밝은 인상', intense: '강렬한 인상', calm: '고요한 인상', lush: '풍성한 인상'
};
const LABELS_BY_TYPE = { 'musical-claim': MUSICAL_LABELS, 'cultural-or-historical': CULTURAL_LABELS, impression: IMPRESSION_LABELS };
function labelFor(text, type) {
  const map = LABELS_BY_TYPE[type];
  if (!map) return null;
  for (const [keyword, label] of Object.entries(map)) if (new RegExp(keyword, 'i').test(text)) return label;
  return null;
}

const TYPE_TO_CATEGORY = { 'musical-claim': 'production', 'cultural-or-historical': 'association', impression: 'mood' };
// A single caption is weaker than a real DSP measurement (no repeatability guarantee, one holistic
// read) -- these starting confidences are deliberately below what a measured signal would earn, so
// this source is honestly graded as less certain per observation while still participating in the
// same fusion/stability math as everything else.
const TYPE_TO_CONFIDENCE = { 'musical-claim': 0.6, 'cultural-or-historical': 0.45, impression: 0.5 };

// Turns a reviewed caption's claims into candidate-shaped observations
// ({category, text, confidence, anchors, source}) for evidenceFusionEngine.js's fuse() as a new
// "directAudio" evidence group -- see js/semantic/semanticEngine.js's updateTemporalEvidence().
// Only claims whose type maps to a known category AND whose text contains a real, mapped keyword
// produce an observation; a claim with no matching keyword in its OWN type's label map (e.g. a
// genuinely plain sentence with no musical/cultural/mood vocabulary at all) is honestly dropped
// rather than guessed -- it stays visible in reviewCaption()'s own report, just not promoted.
function toObservations(review) {
  const observations = [];
  for (const claim of review.claims || []) {
    const category = TYPE_TO_CATEGORY[claim.type];
    const label = category && labelFor(claim.text, claim.type);
    if (!category || !label) continue;
    observations.push(Facets.token(label, category, TYPE_TO_CONFIDENCE[claim.type],
      ['directAudioEvidence.caption'], { source: 'directAudio', claimId: claim.id }));
  }
  return observations;
}

module.exports = { reviewCaption, toObservations, split };
