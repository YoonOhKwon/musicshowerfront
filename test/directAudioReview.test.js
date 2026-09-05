const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCaption, toObservations, split } = require('../lib/directAudioReview');

test('direct caption is review-only and separates cultural claims', () => {
  const result = reviewCaption({ provider: 'research', audioSha256: 'abc', caption: 'A 140 BPM kick groove. 1990년대 영국 클럽의 향수.' });
  assert.equal(result.status, 'human-review-required');
  assert.equal(result.metrics.musicalClaimCount, 1);
  assert.equal(result.metrics.culturalClaimCount, 1);
  assert.equal(result.claims.every(x => x.approved === false), true);
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

test('an impression-type claim (matches neither MUSICAL nor CULTURAL) produces no observation -- honestly dropped, not force-labeled', () => {
  const review = reviewCaption({ caption: 'It feels quietly wistful and warm.' });
  assert.equal(review.claims[0].type, 'impression');
  assert.deepEqual(toObservations(review), []);
});

test('an unmatched sentence of a recognized type (no real keyword to anchor a label to) also produces no observation', () => {
  const review = { claims: [{ id: 'x', text: 'something with no real keyword', type: 'musical-claim' }] };
  assert.deepEqual(toObservations(review), []);
});
