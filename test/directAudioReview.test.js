const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCaption, split } = require('../lib/directAudioReview');

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
