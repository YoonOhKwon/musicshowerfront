const test = require('node:test');
const assert = require('node:assert/strict');
const DirectAudioRealizer = require('../js/semantic/directAudioRealizer');
const FlamingoWordReservoir = require('../js/semantic/flamingoWordReservoir');

test('an unrecognized aesthetic phrase never mixes raw English with a Korean grammatical suffix', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  const family = realizer.realize('energetic yet contemplative', 'impression');
  assert.deepEqual(family, ['energetic yet contemplative']);
  assert.ok(!family[0].includes('적 감각'), 'must not stitch a Korean suffix onto untranslated English');
});

test('an unrecognized context phrase stays plain English rather than hybrid grammar', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  const family = realizer.realize('a global internet-driven music culture', 'context');
  assert.deepEqual(family, ['a global internet-driven music culture']);
  assert.ok(!family[0].includes('요소'));
});

test('an unrecognized aesthetic English phrase stays plain (no "적 분위기" stitched on)', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  const family = realizer.realize('future-forward sound design', 'aesthetic');
  assert.deepEqual(family, ['future-forward sound design']);
  assert.ok(!family[0].includes('적 분위기'));
});

test('subjective known entries stay model-owned until an external realization is registered', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  assert.deepEqual(realizer.realize('melancholic propulsion', 'impression'), ['melancholic propulsion']);
  assert.deepEqual(realizer.realize('nocturnal atmosphere', 'aesthetic'), ['nocturnal atmosphere']);
  realizer.registerFamily('melancholic propulsion', ['외부 모델 표현']);
  assert.deepEqual(realizer.realize('melancholic propulsion', 'impression'), ['외부 모델 표현']);
  assert.ok(realizer.realize('deep sub-bass', 'instrumentation').some(value => /[가-힣]/.test(value)),
    'FACT translation remains available to the permitted local/Flamingo fact path');
});

test('Reservoir.applyRealization replaces (never merges into) a fallback family and resets rotation', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    impressions: [{ text: 'energetic yet contemplative', confidence: 0.7 }]
  }, { trackEpoch: 1 });

  const key = FlamingoWordReservoir.conceptKeyFor('energetic yet contemplative', 'mood');
  const before = reservoir.conceptRegistry.get(key);
  assert.deepEqual(before.family, ['energetic yet contemplative'], 'fallback family is plain English before realization arrives');

  reservoir.rotate(key); // simulate this bad phrase having already been displayed once
  const applied = reservoir.applyRealization('energetic yet contemplative', ['활기차면서도 사색적인 느낌', '들뜬 사색'], 'mood');
  assert.equal(applied, true);

  const after = reservoir.conceptRegistry.get(key);
  assert.deepEqual(after.family, ['활기차면서도 사색적인 느낌', '들뜬 사색'], 'family is replaced, not unioned with the stale English fallback');
  assert.equal(reservoir.rotationIndexes.get(key), 0, 'rotation resets so the first real Korean variant is shown next, not an out-of-range index');
});

test('Reservoir concept identity includes the canonical facet, so identical wording in two roles does not collide', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({
    audibleObservations: [{ text: 'weightless drift', category: 'production', confidence: 0.7 }],
    impressions: [{ text: 'weightless drift', confidence: 0.7 }]
  }, { trackEpoch: 1 });

  assert.equal(reservoir.conceptRegistry.size, 2);
  assert.ok(reservoir.conceptRegistry.has(FlamingoWordReservoir.conceptKeyFor('weightless drift', 'production')));
  assert.ok(reservoir.conceptRegistry.has(FlamingoWordReservoir.conceptKeyFor('weightless drift', 'mood')));
});

test('Reservoir.applyRealization is a safe no-op for an unregistered concept or an empty/non-Korean family', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  assert.equal(reservoir.applyRealization('never seen', ['어떤 표현']), false);

  reservoir.ingestPacket({ impressions: [{ text: 'dreamy haze', confidence: 0.6 }] }, { trackEpoch: 1 });
  assert.equal(reservoir.applyRealization('dreamy haze', []), false);
  assert.equal(reservoir.applyRealization('dreamy haze', ['still english']), false, 'a non-Korean family must not be applied');
});

test("composeKoreanFamily never substitutes a generic filler noun for one it did not actually recognize", () => {
  const realizer = new DirectAudioRealizer.Realizer();
  // Only "digital" is in ADJECTIVE_MAP; "clarity"/"production"/"trends" are not in NOUN_MAP. The
  // old fallback filled in a generic noun ("공기감"/"질감"/"정서") anyway, producing a confident
  // translation of a DIFFERENT, blander idea. It must now keep the honest original instead.
  assert.deepEqual(realizer.realize("digital clarity", "aesthetic"), ["digital clarity"]);
  assert.deepEqual(realizer.realize("late-2010s digital production trends", "context"),
    ["late-2010s digital production trends"]);
  assert.deepEqual(realizer.realize("future-forward ambience", "aesthetic"), ["future-forward ambience"]);
});

test("subjective layers do not use morphological composition even when a noun is recognized", () => {
  const realizer = new DirectAudioRealizer.Realizer();
  const family = realizer.realize("warm textures", "aesthetic");
  assert.deepEqual(family, ["warm textures"]);
});

test('faithful fallback keeps compound Flamingo observations instead of collapsing to one noun', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  const arrangement = realizer.realize('drums and synths in a balanced mix', 'arrangement');
  const placement = realizer.realize('vocals sit centrally in the mix', 'arrangement');
  const aesthetic = realizer.realize('bright and airy', 'aesthetic');
  assert.ok(arrangement.length >= 3 && arrangement.every(text => /드럼/.test(text) && /신스/.test(text)));
  assert.ok(placement.length >= 3 && placement.every(text => /보컬/.test(text) && /중앙|센터/.test(text)));
  assert.ok(aesthetic.length >= 3 && aesthetic.every(text => /[가-힣]/.test(text)));
});

test('musical notation survives normalized dictionary lookup', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  assert.deepEqual(realizer.realize('steady 4/4 drum beat', 'rhythm'), [
    '안정적인 4/4 드럼 비트',
    '일정하게 이어지는 사분의 사박 드럼',
    '고른 4/4 드럼 박자'
  ]);
});

test('compositional FACT fallback rejects partial translation and preserves every recognized noun', () => {
  const realizer = new DirectAudioRealizer.Realizer();
  assert.deepEqual(realizer.realize('bright synth pads', 'instrumentation'), [
    '밝은 음색의 신스 패드', '환한 신스 패드 레이어', '명료하게 들리는 신스 패드'
  ]);
  assert.deepEqual(realizer.realize('bright mystery pads', 'instrumentation'), ['bright mystery pads'],
    'an unknown content word must not be silently dropped');
});

test('assisted FACT concepts remain inspectable but cannot enter the display pool without a blind hearing', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer: new DirectAudioRealizer.Realizer() });
  reservoir.ingestPacket({ audibleObservations: [
    { text: 'steady electronic beat', category: 'rhythm', confidence: 0.95, listeningMode: 'assisted' }
  ] }, { trackEpoch: 1, observationId: 'assisted-1', listeningMode: 'assisted' });
  const assisted = [...reservoir.conceptRegistry.values()][0];
  assert.equal(assisted.confidence, 0.95, 'raw model confidence remains inspectable in the registry');
  assert.equal(reservoir.isPromotionEligible(assisted), false);
  assert.equal(reservoir.promotionHoldReason(assisted), '독립청취 미확인');

  reservoir.ingestPacket({ audibleObservations: [
    { text: 'steady electronic beat', category: 'rhythm', confidence: 0.72, listeningMode: 'independent' }
  ] }, { trackEpoch: 1, observationId: 'independent-1', listeningMode: 'independent' });
  const corroborated = [...reservoir.conceptRegistry.values()][0];
  assert.equal(reservoir.isPromotionEligible(corroborated), true);
  assert.deepEqual([...corroborated.independentObservationIds], ['independent-1']);
});

test('reservoir volatility: an un-reheard concept fades in weight and is eventually swept, while a re-heard one survives', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({
    realizer: new DirectAudioRealizer.Realizer(),
    conceptTtlMs: 1000,
    decayHalfLifeMs: 400
  });
  reservoir.ingestPacket({
    aestheticConcepts: [{ text: 'nocturnal atmosphere', confidence: 0.9 }],
    impressions: [{ text: 'melancholic propulsion', confidence: 0.9 }]
  }, { trackEpoch: 1, observationId: 'o1' });
  assert.equal(reservoir.conceptRegistry.size, 2);
  const initial = reservoir.getCandidates().find(c => c.canonicalText === 'nocturnal atmosphere');

  // Age both concepts, then re-hear only one of them.
  const aged = reservoir.conceptRegistry.get([...reservoir.conceptRegistry.keys()]
    .find(k => k.includes('nocturnal')));
  const kept = reservoir.conceptRegistry.get([...reservoir.conceptRegistry.keys()]
    .find(k => k.includes('melancholic')));
  aged.lastSeenAt -= 600;
  kept.lastSeenAt -= 600;
  const decayed = reservoir.getCandidates().find(c => c.canonicalText === 'nocturnal atmosphere');
  assert.ok(decayed.reservoirScore < initial.reservoirScore,
    `an un-reheard concept must lose standing (${decayed.reservoirScore} should be < ${initial.reservoirScore})`);
  // Volatility is a freshness PREFERENCE, expressed as a multiplier the selector applies. It must
  // not masquerade as the quality score, which semanticFacetManager.curate() ranks against the
  // language critic's scores for locally-composed phrases: publishing the decay there sank every
  // Flamingo concept below every local phrase within about a minute of the song starting.
  assert.equal(decayed.score, initial.score,
    'age must not rewrite how good the concept is, only how fresh');
  assert.equal(decayed.evidenceScore, initial.evidenceScore);
  assert.ok(decayed.freshness < initial.freshness);

  // A later capture re-hears only "melancholic propulsion".
  reservoir.ingestPacket({ impressions: [{ text: 'melancholic propulsion', confidence: 0.9 }] },
    { trackEpoch: 1, observationId: 'o2' });
  aged.lastSeenAt -= 1200; // push the un-reheard one past its TTL

  reservoir.getCandidates(); // getCandidates sweeps
  const surviving = [...reservoir.conceptRegistry.values()].map(e => e.canonicalText);
  assert.deepEqual(surviving, ['melancholic propulsion'],
    'being heard again buys another lifetime; silence expires the concept');
});

test('reservoir size cap evicts the stalest concept, not simply the oldest-added one', () => {
  const reservoir = new FlamingoWordReservoir.Reservoir({
    realizer: new DirectAudioRealizer.Realizer(), maxConcepts: 3
  });
  reservoir.ingestPacket({
    aestheticConcepts: [{ text: 'nocturnal atmosphere', confidence: 0.9 }, { text: 'digital nostalgia', confidence: 0.9 }]
  }, { trackEpoch: 1, observationId: 'o1' });
  // The first-added concept keeps being re-heard, so it must NOT be the one evicted.
  reservoir.ingestPacket({ aestheticConcepts: [{ text: 'nocturnal atmosphere', confidence: 0.95 }] },
    { trackEpoch: 1, observationId: 'o2' });
  const stale = reservoir.conceptRegistry.get([...reservoir.conceptRegistry.keys()]
    .find(k => k.includes('digital')));
  stale.lastSeenAt -= 120000;

  reservoir.ingestPacket({
    impressions: [{ text: 'weightless drift', confidence: 0.8 }, { text: 'hypnotic trance', confidence: 0.8 }]
  }, { trackEpoch: 1, observationId: 'o3' });

  const remaining = [...reservoir.conceptRegistry.values()].map(e => e.canonicalText);
  assert.ok(remaining.includes('nocturnal atmosphere'), 'a repeatedly re-heard concept must survive eviction');
  assert.ok(!remaining.includes('digital nostalgia'), 'the stalest concept is the one that gives way');
});
