const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewCaption, toObservations, split, calibrateStructuredPacket } = require('../lib/directAudioReview');

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

test('unstructured caption prose remains diagnostic and cannot author the semantic word pool', () => {
  const review = reviewCaption({ caption: 'A steady bpm groove. 1990년대 영국 클럽의 향수.' });
  const observations = toObservations(review);
  assert.deepEqual(observations, []);
  assert.equal(review.claims.length, 2, 'raw claims remain inspectable even though they are not display authority');
});

// Regression coverage for a real bug found while building this: labelFor() used to search one
// shared keyword->label map regardless of the sentence's classified type, so a sentence classified
// as cultural-or-historical (by "vaporwave") but that ALSO happened to contain an unrelated musical
// word ("bpm") got mislabeled with the musical term instead of the one that actually caused its
// classification.
test('caption classification remains diagnostic without a developer-authored cultural surface', () => {
  const review = reviewCaption({ caption: 'A warm synth pad with a steady bpm kick and vaporwave feel.' });
  assert.equal(review.claims[0].type, 'cultural-or-historical');
  assert.deepEqual(toObservations(review), []);
});

test('unstructured impression prose is quarantined instead of guessed into the word pool', () => {
  const review = reviewCaption({ caption: 'It feels quietly wistful and warm.' });
  assert.equal(review.claims[0].type, 'impression');
  assert.deepEqual(toObservations(review), []);
});

test('claim-only input cannot bypass structured packet parsing', () => {
  const review = { claims: [{ id: 'x', text: 'something with no real keyword', type: 'musical-claim' }] };
  assert.deepEqual(toObservations(review), []);
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

test('classifier-assisted FACT confidence is capped until an independent listen corroborates it', () => {
  const assisted = calibrateStructuredPacket({ audibleObservations: [
    { text: 'electronic beat', category: 'rhythm', confidence: 0.95 }
  ] }, { listeningMode: 'assisted', genreAdvisoryUsed: true });
  const independent = calibrateStructuredPacket({ audibleObservations: [
    { text: 'syncopated groove', category: 'rhythm', confidence: 0.95 }
  ] }, { listeningMode: 'independent', genreAdvisoryUsed: false });
  assert.equal(assisted.audibleObservations[0].confidence, 0.58);
  assert.equal(assisted.audibleObservations[0].modelConfidence, 0.95);
  assert.equal(independent.audibleObservations[0].confidence, 0.72);
  assert.equal(independent.audibleObservations[0].listeningMode, 'independent');
});

test('all structured interpretation layers are confidence-capped and first impressions stay provisional', () => {
  const packet = calibrateStructuredPacket({
    genreHypotheses: [{ label: 'Open Genre', confidence: 0.99 }],
    aestheticConcepts: [{ text: 'porous nocturnal surface', confidence: 0.99 }],
    impressions: [{ text: 'restless but suspended', confidence: 0.99 }],
    contextHypotheses: [{ text: 'unfixed scene', category: 'scene', confidence: 0.99 }]
  }, { listeningMode: 'independent', listenDepth: 'first-impression' });
  assert.equal(packet.genreHypotheses[0].confidence, 0.48);
  assert.equal(packet.genreHypotheses[0].provisional, true);
  assert.equal(packet.genreHypotheses[0].independent, true);
  assert.equal(packet.contextHypotheses[0].confidence, 0.68);
  assert.equal(packet.aestheticConcepts[0].confidence, 0.60);
  assert.equal(packet.impressions[0].confidence, 0.60);
});

test('signature relations preserve evidence references as recording-specific FACT', () => {
  const observations = toObservations(reviewCaption({ structuredPacket: {
    signatureRelations: [{ id: 's1', text: 'bass answers clipped vocal', supportRefs: ['f1', 'f2'], confidence: 0.69 }]
  }}));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].evidenceType, 'signatureRelation');
  assert.equal(observations[0].layer, 'FACT');
  assert.deepEqual(observations[0].supportRefs, ['f1', 'f2']);
});

test('a sentence misplaced in genreHypotheses is quarantined instead of guessed into another layer', () => {
  const sentence = 'Lush atmospheric synth pads provide harmonic support';
  const observations = toObservations(reviewCaption({ structuredPacket: {
    genreHypotheses: [{ label: sentence, confidence: 0.65 }]
  }}));
  assert.deepEqual(observations, []);
});

// Regression coverage for a real gap found against an ACTUAL Flamingo output (from a live run of
// this feature, not a synthetic guess): "This track is an energetic, nostalgic Synthwave piece
// that blends classic 1980s retro-futurist aesthetics with modern high-fidelity production." used
// to classify as musical-claim (CULTURAL didn't recognize any of "Synthwave"/"retro-futurist"/
// "1980s", so it fell through to MUSICAL matching "synth" inside "Synthwave") -- the caption's
// single richest piece of aesthetic content was being thrown away as a generic technical claim.
test('a real Flamingo prose sentence is classified for inspection but not promoted without a packet', () => {
  const review = reviewCaption({ caption: 'This track is an energetic, nostalgic Synthwave piece that blends classic 1980s retro-futurist aesthetics with modern high-fidelity production.' });
  assert.equal(review.claims[0].type, 'cultural-or-historical');
  assert.deepEqual(toObservations(review), []);
});

test('plain mood prose does not invoke a hardcoded impression dictionary', () => {
  const review = reviewCaption({ caption: 'The mix is polished.' });
  assert.equal(review.claims[0].type, 'impression');
  assert.deepEqual(toObservations(review), []);
});
