// Research-only bridge for a direct-audio caption. It never promotes model text
// to semantic evidence; a human must approve each proposed claim.
const CULTURAL = /(\d{2,4}년대|일본|러시아|영국|미국|도쿄|버블경제|pirate radio|anime|y2k|vaporwave|scene|culture|artist|연상)/i;
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
    }, policy: ['No caption is semantic evidence until approved by a human.',
      'Cultural, historical and artist associations always require explicit review.',
      'Approved claims must be linked to an audio excerpt and model run id.',
      'Rejected claims must not be retried as synonyms in the live word pool.'] };
}

module.exports = { reviewCaption, split };
