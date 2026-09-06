const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCaption, toObservations, split } = require('../lib/directAudioReview');

test('direct caption is auto-fused and separates cultural claims without human approval gate', () => {
  const result = reviewCaption({ provider: 'research', audioSha256: 'abc', caption: 'A 140 BPM kick groove. 1990년대 영국 클럽의 향수.' });
  assert.equal(result.status, 'auto-fused');
  assert.equal(result.approvedForDisplay, true);
  assert.equal(result.metrics.musicalClaimCount, 1);
  assert.equal(result.metrics.culturalClaimCount, 1);
});
test('caption parsing is bounded and does not become a giant prompt', () => {
  assert.equal(split('word\n'.repeat(100)).length, 40);
  const result = reviewCaption({ caption: '따뜻한 음색.' }, { synopsis: '차가운 음색' });
  assert.equal(result.metrics.sentenceCount, 1);
  assert.equal(result.metrics.baselineOverlapRatio, 0);
});

// Project-transformation ask: a direct-audio caption should become real evidence (fused with
// every other source via evidenceFusionEngine.js, gaining stability over time via
// temporalEvidenceEngine.js), not sit in a human-review-only side channel. toObservations() is
// that bridge -- musical AND cultural/aesthetic content both become candidates now, at reduced
// starting confidence reflecting a single caption's real uncertainty.
test('toObservations turns musical and cultural claims into candidate observations at reduced, differentiated confidence', () => {
  const review = reviewCaption({ caption: 'A steady bpm groove. 1990년대 영국 클럽의 향수.' });
  const observations = toObservations(review);
  assert.equal(observations.length, 2);
  const musical = observations.find(o => o.category === 'production');
  const cultural = observations.find(o => o.category === 'association');
  assert.equal(musical.text, '템포감');
  assert.equal(musical.layer, 'FACT');
  assert.equal(cultural.layer, 'AESTHETIC');
  assert.ok(musical.confidence > cultural.confidence, 'a single caption must grade cultural claims lower than musical ones');
  assert.ok(observations.every(o => o.source === 'directAudio'));
});

// Regression coverage for a real bug found while building this: labelFor() used to search one
// shared keyword->label map regardless of the sentence's classified type, so a sentence classified
// as cultural-or-historical (by "vaporwave") but that ALSO happened to contain an unrelated musical
// word ("bpm") got mislabeled with the musical term instead of the one that actually caused its
// classification.
test('a sentence classified as cultural is labeled from the cultural keyword that caused it, never an incidental musical word in the same sentence', () => {
  const review = reviewCaption({ caption: 'A warm synth pad with a steady bpm kick and vaporwave feel.' });
  assert.equal(review.claims[0].type, 'cultural-or-historical');
  const [observation] = toObservations(review);
  assert.equal(observation.text, '베이퍼웨이브 미학 연상');
  assert.equal(observation.category, 'association');
});

test('an open-world impression survives as source evidence and waits for Korean realization', () => {
  const review = reviewCaption({ caption: 'It feels quietly wistful and warm.' });
  assert.equal(review.claims[0].type, 'impression');
  const [observation] = toObservations(review);
  assert.equal(observation.text, 'It feels quietly wistful and warm');
  assert.equal(observation.layer, 'IMPRESSION');
  assert.equal(observation.requiresKoreanRealization, true);
});

test('an unfamiliar but valid musical description is retained instead of being limited to local priors', () => {
  const review = { claims: [{ id: 'x', text: 'something with no real keyword', type: 'musical-claim' }] };
  const [observation] = toObservations(review);
  assert.equal(observation.text, 'something with no real keyword');
  assert.equal(observation.requiresKoreanRealization, true);
});

test('structured English descriptions wait for Korean realization while international genre labels can display', () => {
  const review = reviewCaption({ structuredPacket: {
    audibleObservations: [{ text: 'granular percussion', category: 'production', confidence: 0.72 }],
    genreHypotheses: [{ label: 'Mallsoft', confidence: 0.74 }],
    contextHypotheses: [{ text: 'abandoned retail ambience', category: 'scene', confidence: 0.63 }],
    aestheticConcepts: [{ text: 'degraded commercial nostalgia', confidence: 0.66 }],
    impressions: [{ text: 'comforting yet emotionally vacant', confidence: 0.64 }]
  }});
  const observations = toObservations(review);
  assert.equal(observations.find(item => item.category === 'genre').requiresKoreanRealization, false);
  assert.ok(observations.filter(item => item.category !== 'genre').every(item => item.requiresKoreanRealization));
});

test('a sentence misplaced in genreHypotheses is preserved as evidence but cannot become GENRE', () => {
  const sentence = 'Lush atmospheric synth pads provide harmonic support';
  const observations = toObservations(reviewCaption({ structuredPacket: {
    genreHypotheses: [{ label: sentence, confidence: 0.65 }]
  }}));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].category, 'production');
  assert.equal(observations[0].reclassifiedFrom, 'genre');
  assert.equal(observations[0].requiresKoreanRealization, true);
  assert.ok(!observations.some(item => item.category === 'genre'));
});

// Regression coverage for a real gap found against an ACTUAL Flamingo output (from a live run of
// this feature, not a synthetic guess): "This track is an energetic, nostalgic Synthwave piece
// that blends classic 1980s retro-futurist aesthetics with modern high-fidelity production." used
// to classify as musical-claim (CULTURAL didn't recognize any of "Synthwave"/"retro-futurist"/
// "1980s", so it fell through to MUSICAL matching "synth" inside "Synthwave") -- the caption's
// single richest piece of aesthetic content was being thrown away as a generic technical claim.
test('a real Flamingo sentence about era/aesthetic (Synthwave, retro-futurist, 1980s) classifies as cultural, not as a musical claim via an incidental "synth" substring', () => {
  const review = reviewCaption({ caption: 'This track is an energetic, nostalgic Synthwave piece that blends classic 1980s retro-futurist aesthetics with modern high-fidelity production.' });
  assert.equal(review.claims[0].type, 'cultural-or-historical');
  const [observation] = toObservations(review);
  assert.equal(observation.category, 'association');
  assert.equal(observation.layer, 'AESTHETIC');
});

test('plain mood/feeling words with no era or place reference become IMPRESSION-layer observations, not dropped', () => {
  const review = reviewCaption({ caption: 'The mix is polished.' });
  assert.equal(review.claims[0].type, 'impression');
  const [observation] = toObservations(review);
  assert.equal(observation.text, '정제된 인상');
  assert.equal(observation.category, 'mood');
  assert.equal(observation.layer, 'IMPRESSION');
});
