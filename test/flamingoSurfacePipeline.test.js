const test = require('node:test');
const assert = require('node:assert/strict');

const FlamingoWordReservoir = require('../js/semantic/flamingoWordReservoir');
const DirectAudioRealizer = require('../js/semantic/directAudioRealizer');
const SemanticFacets = require('../js/semantic/semanticFacets');
const SemanticFacetManager = require('../js/semantic/semanticFacetManager');
const LanguageCritic = require('../js/semantic/languageCritic');
const PhrasePool = require('../js/semantic/phrasePoolEngine');

test('accepted Flamingo observations can restore an empty structured-packet transport', () => {
  const observations = [
    { text: 'porous midnight glass', sourceText: 'porous midnight glass', category: 'association',
      layer: 'AESTHETIC', evidenceType: 'aestheticConcept', confidence: 0.58, independent: true },
    { text: 'hopeful unease', sourceText: 'hopeful unease', category: 'mood',
      layer: 'IMPRESSION', evidenceType: 'impression', confidence: 0.54, independent: true }
  ];
  const packet = FlamingoWordReservoir.packetFromObservations(observations);
  assert.equal(FlamingoWordReservoir.packetConceptCount(packet), 2);

  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  assert.equal(reservoir.ingestPacket(packet, { trackEpoch: 1, observationId: 'restored-1' }), true);
  assert.deepEqual([...reservoir.conceptRegistry.values()].map(item => item.layer).sort(),
    ['AESTHETIC', 'IMPRESSION']);
});

test('one low-confidence genre hearing is retained for inspection but not surfaced', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    genreHypotheses: [{ label: 'Uncatalogued Pulse', confidence: 0.40 }]
  }, { trackEpoch: 1, observationId: 'weak-genre-1' });

  assert.ok([...reservoir.conceptRegistry.values()].some(item => item.canonicalText === 'Uncatalogued Pulse'));
  assert.equal(reservoir.getCandidates().some(item => item.canonicalText === 'Uncatalogued Pulse'), false);
});

test('a repeated open-world genre can enter the surface pool without a name registry', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  const packet = { genreHypotheses: [{ label: 'Uncatalogued Pulse', confidence: 0.44 }] };
  reservoir.ingestPacket(packet, { trackEpoch: 1, observationId: 'weak-genre-1' });
  reservoir.ingestPacket(packet, { trackEpoch: 1, observationId: 'weak-genre-2' });

  assert.ok(reservoir.getCandidates().some(item => item.canonicalText === 'Uncatalogued Pulse'));
});

test('reservoir confidence is reversible and duplicate copies in one observation are not corroboration', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({ aestheticConcepts: [
    { text: 'porous night texture', confidence: 0.9 },
    { text: 'porous night texture', confidence: 0.9 }
  ] }, { trackEpoch: 1, observationId: 'window-1', audioSegmentId: 'segment-1', listeningMode: 'independent' });
  let candidate = reservoir.getCandidates().find(item => item.canonicalText === 'porous night texture');
  assert.equal(candidate.independentObservationCount, 1);
  assert.equal(candidate.confidence, 0.9);

  reservoir.ingestPacket({ aestheticConcepts: [
    { text: 'porous night texture', confidence: 0.3 }
  ] }, { trackEpoch: 1, observationId: 'window-2', audioSegmentId: 'segment-2', listeningMode: 'independent' });
  candidate = reservoir.getCandidates().find(item => item.canonicalText === 'porous night texture');
  assert.ok(candidate.confidence < 0.9, 'later weak evidence must be able to lower an early overconfident reading');
  assert.equal(candidate.independentObservationCount, 2);
  assert.equal(candidate.crossSegmentSupport, 2);
  assert.equal(candidate.resolutionMomentum, true, 'Korean reservoir surfaces retain direct-listening selection priority');
  const diagnostics = reservoir.inspect();
  assert.equal(diagnostics.canonicalConceptCount, 1);
  assert.equal(diagnostics.crossSegmentConceptCount, 1);
  assert.ok(diagnostics.surfacePhraseCount >= diagnostics.canonicalConceptCount);
});

test('signature relations retain their support ids in the canonical reservoir', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({ signatureRelations: [
    { text: 'bass answers clipped vocal', confidence: 0.68, supportRefs: ['f1', 'f2'] }
  ] }, { trackEpoch: 1, observationId: 'window-1', audioSegmentId: 'segment-1' });
  const candidate = reservoir.getCandidates().find(item => item.canonicalText === 'bass answers clipped vocal');
  assert.ok(candidate);
  assert.equal(candidate.layer, 'FACT');
  assert.deepEqual(candidate.supportRefs, ['f1', 'f2']);
});

test('Flamingo packet reaches reservoir, stateV2 merge, critic, PhrasePool, and rotates its Korean surface', async () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    audibleObservations: [{ text: 'deep sub-bass', category: 'instrumentation', confidence: 0.8 }],
    genreHypotheses: [{ label: 'Atmospheric Drum and Bass', confidence: 0.78 }],
    contextHypotheses: [{ text: 'uk rave lineage', category: 'lineage', confidence: 0.72 }],
    aestheticConcepts: [{ text: 'nocturnal atmosphere', confidence: 0.76 }],
    impressions: [{ text: 'melancholic propulsion', confidence: 0.74 }]
  }, { trackEpoch: 1, observationId: 'flam-e2e-1' });
  // Korean surface families are externally realized from Flamingo concepts, not selected from a
  // developer-authored aesthetic/impression dictionary.
  reservoir.applyRealization('nocturnal atmosphere', ['야간의 공기감', '심야의 여백'], 'association');
  reservoir.applyRealization('melancholic propulsion', ['추진과 애상의 공존', '앞서는 슬픔'], 'mood');
  reservoir.applyRealization('uk rave lineage', ['UK 레이브 계보'], 'lineage');

  const reservoirCandidates = reservoir.getCandidates();
  assert.deepEqual(new Set(reservoirCandidates.map(item => item.category)),
    new Set(['instrumentation', 'genre', 'lineage', 'association', 'mood']));
  assert.ok(reservoirCandidates.every(item => SemanticFacets.names.includes(item.category)),
    'every reservoir item must use a real display facet');

  const staleRawSurface = {
    text: 'nocturnal atmosphere', canonicalText: 'nocturnal atmosphere', sourceText: 'nocturnal atmosphere',
    category: 'association', layer: 'AESTHETIC', source: 'directAudio', sourceFamily: 'directAudio',
    confidence: 0.76, requiresKoreanRealization: true
  };
  const state = {
    sessionId: 31,
    semanticEpoch: 1,
    expressionFeatures: { audible: true, sampleCount: 100, observationSeconds: 30 },
    trackCharacter: { confidence: 0.8 },
    stateV2: { displayCandidates: [staleRawSurface] },
    flamingoReservoirCandidates: reservoirCandidates,
    openWorldConcepts: [],
    audio: { bpm: 174 },
    genre: { primary: 'Atmospheric Drum and Bass', confidence: 0.78 },
    mood: { fused: { arousal: 0.65, brightness: 0.4 } }
  };

  const local = SemanticFacetManager.local(state);
  assert.equal(local.some(item => item.text === 'nocturnal atmosphere'), false,
    'stateV2 raw English surface must be replaced by the reservoir realization');
  assert.ok(local.some(item => item.canonicalText === 'nocturnal atmosphere' && /[가-힣]/.test(item.text)));

  const ranked = LanguageCritic.rank(local, { context: { eligibleTexts: local.map(item => item.text), snapshot: {} }, limit: 40 });
  assert.ok(ranked.selected.some(item => item.category === 'association'));
  assert.ok(ranked.selected.some(item => item.category === 'mood'));

  const pool = new PhrasePool.Engine({ poolSize: 25 });
  await pool.regenerate({ state, sessionId: 31, epoch: 1, force: true });
  const firstSurface = pool.snapshot().find(item => item.canonicalText === 'nocturnal atmosphere')?.text;
  assert.ok(firstSurface);

  const firstToken = pool.snapshot().find(item => item.canonicalText === 'nocturnal atmosphere');
  assert.ok(firstToken.surfaceConceptKey, 'facet-aware reservoir identity must survive to the selected token');
  assert.equal(reservoir.noteUsed(firstSurface, firstToken.surfaceConceptKey), true);
  state.flamingoReservoirCandidates = reservoir.getCandidates();
  await pool.regenerate({ state, sessionId: 31, epoch: 1, force: false });
  const secondSurface = pool.snapshot().find(item => item.canonicalText === 'nocturnal atmosphere')?.text;
  assert.ok(secondSurface);
  assert.notEqual(secondSurface, firstSurface, 'the next phrase-pool projection must use the next family member');
});
