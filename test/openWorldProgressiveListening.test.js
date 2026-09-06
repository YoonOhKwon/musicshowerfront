const test = require('node:test');
const assert = require('node:assert/strict');

const OpenWorldConceptRegistry = require('../js/semantic/openWorldConceptRegistry');
const ProgressiveListening = require('../js/semantic/progressiveListeningEngine');
const TemporalEvidence = require('../js/semantic/temporalEvidenceEngine');
const Facets = require('../js/semantic/semanticFacets');
const PhraseSelection = require('../js/visual/phraseSelection');
const DirectAudioReview = require('../lib/directAudioReview');
const LanguageCritic = require('../js/semantic/languageCritic');
const SemanticFacetManager = require('../js/semantic/semanticFacetManager');

test('1. Early listening (initial 5s): LIVE and FACT dominate, CONTEXT and AESTHETIC stay at 0 without evidence', () => {
  const engine = new ProgressiveListening.Engine();
  // State at 3 seconds: basic audio features, low primitive coverage, uncertain genre
  const state = {
    audio: { bpm: 120, beatConfidence: 0.5 },
    primitives: { "pulse.tempo": { value: 120 } },
    genre: { confidence: 0.3, uncertain: true }
  };
  const readiness = engine.update({ state, observationSeconds: 3 });
  assert.ok(readiness.fact >= 0.2, 'fact readiness should be active');
  assert.equal(readiness.context, 0, 'context readiness should be 0 without genre grounding');
  assert.equal(readiness.aesthetic, 0, 'aesthetic readiness should be 0 early on');

  const weights = engine.getLayerWeights();
  assert.ok(weights.LIVE >= 0.35, 'LIVE weight should be high initially');
  assert.ok(weights.FACT >= 0.30, 'FACT weight should be prominent initially');
  assert.equal(weights.CONTEXT, 0, 'CONTEXT weight must be 0 without evidence');
  assert.equal(weights.AESTHETIC, 0, 'AESTHETIC weight must be 0 without evidence');
});

test('2. Single Flamingo observation repeated across 100 semantic ticks maintains observation count === 1', () => {
  const engine = new TemporalEvidence.Engine();
  const obsId = 'flam-sha256-test-1';
  const observation = Facets.token('베이퍼웨이브 미학 연상', 'association', 0.65,
    ['directAudioEvidence.caption'], { source: 'directAudio', observationId: obsId });

  let now = 1000;
  // 100 ticks spaced 100ms apart with the EXACT same observationId
  for (let tick = 0; tick < 100; tick++) {
    now += 100;
    engine.update([observation], now);
  }

  const history = engine.history.get('association:베이퍼웨이브 미학 연상');
  assert.ok(history, 'history entry should exist');
  assert.equal(history.observations, 1, 'repeated ticks with the same observationId must NOT increment observation count');
});

test('3. Second unique Flamingo observation arriving increments temporal support to 2', () => {
  const engine = new TemporalEvidence.Engine();
  const obsId1 = 'flam-sha256-test-1';
  const obsId2 = 'flam-sha256-test-2';

  const obs1 = Facets.token('프렌치 하우스 계열', 'genre', 0.68,
    ['directAudioEvidence.genre'], { source: 'directAudio', observationId: obsId1 });
  const obs2 = Facets.token('프렌치 하우스 계열', 'genre', 0.72,
    ['directAudioEvidence.genre'], { source: 'directAudio', observationId: obsId2 });

  let now = 1000;
  // 10 ticks with first capture
  for (let i = 0; i < 10; i++) {
    now += 100;
    engine.update([obs1], now);
  }
  let history = engine.history.get('genre:프렌치 하우스 계열');
  assert.equal(history.observations, 1);

  // New unique capture arrives 35 seconds later
  now += 35000;
  engine.update([obs2], now);
  history = engine.history.get('genre:프렌치 하우스 계열');
  assert.equal(history.observations, 2, 'second unique Flamingo observation must increment temporal count');
});

test('4. Taxonomy-absent genres (Mallsoft, Singeli, Zamrock) create open-world concept nodes and advance belief status', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  const concept = registry.propose({
    label: 'Mallsoft',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'flam-capture-1',
    confidence: 0.62,
    supportingEvidence: ['reverb.decay', 'timbre.muffled']
  });

  assert.ok(concept, 'concept node should be created');
  assert.equal(concept.canonicalLabel, 'Mallsoft');
  assert.equal(concept.openWorld, true);
  assert.equal(concept.status, 'provisional', 'first observation with temporal support >= 1 is provisional');
  assert.equal(registry.realizePhrase(concept), 'Mallsoft 계열');

  // Second observation corroborating the open-world genre
  const updated = registry.propose({
    label: 'Mallsoft',
    conceptType: 'genre',
    source: 'llm',
    observationId: 'flam-capture-2',
    confidence: 0.78,
    supportingEvidence: ['genreEvidence.vaporwave']
  });
  assert.equal(updated.status, 'stable');
  assert.equal(registry.realizePhrase(updated), 'Mallsoft');
});

test('5. Unregistered genre or core candidate is not rejected purely for missing local taxonomy', () => {
  // safeText performs language hygiene. Support/critic/registry stages decide whether the claim
  // is grounded, so a spelling absent from a developer-maintained list is not auto-rejected.
  assert.equal(Facets.safeText('글리치코어', 'genre'), true);
  assert.equal(Facets.safeText('아직등록되지않은코어', 'genre'), true);
  assert.equal(Facets.safeText('아직등록되지않은코어 연상', 'association'), true);
});

test('5b. Untranslated Flamingo prose stays as evidence while an international genre label remains displayable', () => {
  const candidates = DirectAudioReview.toObservations(DirectAudioReview.reviewCaption({
    structuredPacket: {
      genreHypotheses: [{ label: 'Mallsoft', confidence: 0.76 }],
      aestheticConcepts: [{ text: 'degraded commercial nostalgia', confidence: 0.67 }]
    }
  }));
  const visible = SemanticFacetManager.local({
    expressionFeatures: { audible: true },
    stateV2: { displayCandidates: candidates },
    directAudioCandidates: candidates
  });
  assert.ok(visible.some(item => item.text === 'Mallsoft'));
  assert.ok(!visible.some(item => item.text === 'degraded commercial nostalgia'));
  assert.ok(candidates.some(item => item.text === 'degraded commercial nostalgia'),
    'the English concept must remain available to snapshot/language realization');
});

test('5c. A direct open-world genre becomes less qualified only after belief stabilization', () => {
  const [genre] = DirectAudioReview.toObservations(DirectAudioReview.reviewCaption({
    structuredPacket: { genreHypotheses: [{ label: 'Mallsoft', confidence: 0.76 }] }
  }));
  const local = status => SemanticFacetManager.local({
    expressionFeatures: { audible: true },
    stateV2: { displayCandidates: [genre] },
    directAudioCandidates: [genre],
    openWorldConcepts: [{ canonicalLabel: 'Mallsoft', conceptType: 'genre', status }]
  })[0];
  assert.equal(local('provisional').text, 'Mallsoft 계열');
  assert.equal(local('stable').text, 'Mallsoft');
  assert.equal(local('weakened').text, 'Mallsoft 연상');
});

test('6. Flamingo claim contradicting local acoustic measurements receives lowered confidence', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  const initial = registry.propose({
    label: 'Ambient',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-1',
    confidence: 0.70
  });
  const initialConf = initial.confidence;

  // Local DSP detects 140 BPM four-on-the-floor heavy kicks (contradicting Ambient)
  const contradicted = registry.propose({
    label: 'Ambient',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-1',
    confidence: 0.70,
    contradictions: [{ path: 'rhythmicGrammar.fourOnFloor', value: 0.95 }, { path: 'audio.bpm', value: 140 }]
  });

  assert.ok(contradicted.confidence < initialConf, 'contradictions must decrease hypothesis confidence');
});

test('7. Deep Listen result arrival progressively increases aesthetic and context phrase ratio', () => {
  const engine = new ProgressiveListening.Engine();
  const state = {
    audio: { bpm: 124, beatConfidence: 0.8 },
    genre: { confidence: 0.75, uncertain: false, entropy: 0.3, margin: 0.4 },
    genreReasoning: { primary: { independentEvidenceCount: 3, temporalStability: 0.8 } }
  };

  // Pre-deep-listen at 25s
  engine.update({ state, observationSeconds: 25 });
  const preWeights = engine.getLayerWeights();

  // Deep listen arrives at 30s
  engine.noteDeepListen('flam-30s');
  engine.update({ state, observationSeconds: 30 });
  const postWeights = engine.getLayerWeights();

  assert.ok(postWeights.AESTHETIC > preWeights.AESTHETIC, 'AESTHETIC share must increase after deep listen');
  assert.ok(postWeights.IMPRESSION > preWeights.IMPRESSION, 'IMPRESSION share must increase after deep listen');
  assert.ok(postWeights.FACT >= 0.30, 'FACT share must never drop below floor');
});

test('8. Semantic change temporarily elevates LIVE/FACT share, then recovers interpretive layers', () => {
  const engine = new ProgressiveListening.Engine();
  const state = {
    audio: { bpm: 128, beatConfidence: 0.85 },
    genre: { confidence: 0.8, uncertain: false, entropy: 0.2 },
    genreReasoning: { primary: { independentEvidenceCount: 3, temporalStability: 0.9 } }
  };

  // Established late listening at 45s
  engine.noteDeepListen('obs-1');
  engine.update({ state, observationSeconds: 45 }, 1000);
  const stableWeights = engine.getLayerWeights();

  // Sudden drop / section transition detected
  engine.update({ state, observationSeconds: 46, semanticChange: true }, 2000);
  const transitionWeights = engine.getLayerWeights();

  assert.ok(transitionWeights.LIVE > stableWeights.LIVE, 'LIVE share must rise on section transition');
  assert.ok(transitionWeights.FACT >= stableWeights.FACT, 'FACT share must rise/hold on section transition');
  assert.ok(transitionWeights.AESTHETIC < stableWeights.AESTHETIC, 'AESTHETIC share should temporarily yield during re-interpretation');

  // 10 seconds later: re-interpretation settles
  engine.update({ state, observationSeconds: 56, semanticChange: false }, 12000);
  const recoveredWeights = engine.getLayerWeights();

  assert.ok(recoveredWeights.AESTHETIC > transitionWeights.AESTHETIC, 'AESTHETIC share recovers as new section stabilizes');
});

test('9. Alternating observation sequence (A -> B -> A) with seenObservationIds preserves observation count 1 for A', () => {
  const engine = new TemporalEvidence.Engine();
  const obsA = Facets.token('로파이 힙합', 'genre', 0.65, ['directAudioEvidence.genre'], {
    source: 'directAudio',
    observationId: 'flam-capture-A'
  });
  const obsB = Facets.token('칠합', 'genre', 0.60, ['directAudioEvidence.genre'], {
    source: 'directAudio',
    observationId: 'flam-capture-B'
  });

  let now = 1000;
  // Step 1: Observation A arrives
  engine.update([obsA], now);
  let histA = engine.history.get('genre:로파이 힙합');
  assert.equal(histA.observations, 1);

  // Step 2: Observation B arrives
  now += 500;
  engine.update([obsB], now);
  let histB = engine.history.get('genre:칠합');
  assert.equal(histB.observations, 1);

  // Step 3: Observation A is polled again with the SAME observationId ('flam-capture-A')
  now += 500;
  engine.update([obsA], now);
  histA = engine.history.get('genre:로파이 힙합');
  assert.equal(histA.observations, 1, 'seenObservationIds prevents re-incrementing count on alternating sequence');
});

test('10. Multiple claims in a single Flamingo packet sharing independenceGroup do not artificially multiply independent group boost', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  const sharedGroupId = 'flam-packet-xyz';

  // Propose claim 1 from packet
  const c1 = registry.propose({
    label: 'Synthwave',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-pkt-1',
    independenceGroup: sharedGroupId,
    confidence: 0.60
  });
  assert.equal(c1.independenceGroups.length, 1);

  // Propose claim 2 (e.g. repeat or variation in same packet sharing independenceGroup)
  const c2 = registry.propose({
    label: 'Synthwave',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-pkt-1',
    independenceGroup: sharedGroupId,
    confidence: 0.60
  });
  assert.equal(c2.independenceGroups.length, 1, 'shared independenceGroup must not increase group count');
  assert.equal(c2.temporalSupport, 1, 'same observationId must not increase temporal support');
});

test('11. Context readiness emerges independently from production/lineage/cultural evidence even when genre is tentative', () => {
  const engine = new ProgressiveListening.Engine();
  // Genre classifier is tentative / uncertain
  const state = {
    audio: { bpm: 110, beatConfidence: 0.6 },
    genre: { confidence: 0.25, uncertain: true },
    genreContextEvidence: { candidates: ['소련 포스트펑크 씬', '80년대 테이프 질감', '기타 코러스 이펙트'] },
    openWorldConcepts: [
      { canonicalLabel: 'Soviet Post-Punk', conceptType: 'scene', confidence: 0.72 }
    ]
  };

  const readiness = engine.update({ state, observationSeconds: 15 });
  assert.ok(readiness.genre < 0.35, 'genre readiness should remain tentative');
  assert.ok(readiness.context >= 0.35, 'context readiness must emerge independently based on scene and production evidence');
});

test('12. Concept constellations support hypothesis revision (French House demoted to influence of Future Funk)', () => {
  const registry = new OpenWorldConceptRegistry.Registry();

  // Phase 1: French House is initially provisional
  const frenchHouse = registry.propose({
    label: 'French House',
    conceptType: 'genre',
    source: 'genreModel',
    observationId: 'obs-early',
    confidence: 0.68
  });
  assert.equal(frenchHouse.status, 'provisional');

  // Phase 2: Future Funk emerges with high temporal support and sampling evidence
  const futureFunk = registry.propose({
    label: 'Future Funk',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-deep-1',
    audioSegmentId: 'seg-1',
    confidence: 0.82
  });
  registry.propose({
    label: 'Future Funk',
    conceptType: 'genre',
    source: 'llm',
    observationId: 'obs-deep-2',
    audioSegmentId: 'seg-2',
    confidence: 0.88
  });

  const stableFutureFunk = registry.get('Future Funk', 'genre');
  assert.equal(stableFutureFunk.status, 'stable');

  // Connect into constellation: Future Funk has influence French House
  const linked = registry.relate('Future Funk', 'French House', 'influence', 0.85);
  assert.ok(linked, 'relation should be created');

  // Demote French House from primary hypothesis to provisional/influence
  const demoted = registry.demote('French House', 'provisional', 'takeover-by-future-funk');
  assert.equal(demoted.status, 'provisional');

  const constellation = registry.constellation('Future Funk');
  assert.ok(constellation, 'constellation should exist');
  assert.equal(constellation.concept.canonicalLabel, 'Future Funk');
  assert.equal(constellation.relations.length, 1);
  assert.equal(constellation.relations[0].relationType, 'influence');
  assert.equal(constellation.relations[0].concept.canonicalLabel, 'French House');
});

test('13. Reversible belief state: stable concept demotes to provisional/weakened upon contradicting evidence or decay', () => {
  const registry = new OpenWorldConceptRegistry.Registry({ decayHalfLifeMs: 5000 });

  // Establish stable concept
  registry.propose({
    label: 'Ambient Drone',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-1',
    audioSegmentId: 'seg-1',
    confidence: 0.80
  }, 1000);
  const stable = registry.propose({
    label: 'Ambient Drone',
    conceptType: 'genre',
    source: 'llm',
    observationId: 'obs-2',
    audioSegmentId: 'seg-2',
    confidence: 0.85
  }, 2000);
  assert.equal(stable.status, 'stable');

  // Strong contradicting evidence arrives (sudden 150 BPM gabber kicks)
  const contradicted = registry.propose({
    label: 'Ambient Drone',
    conceptType: 'genre',
    source: 'directAudio',
    observationId: 'obs-2',
    confidence: 0.40,
    contradictions: [
      { metric: 'rhythm.bpm', value: 150 },
      { metric: 'dynamics.transientDensity', value: 0.92 }
    ]
  }, 3000);

  assert.ok(contradicted.confidence < 0.65, 'contradiction drops confidence');
  assert.equal(contradicted.status, 'provisional', 'contradiction demotes stable status to provisional');

  // Temporal decay without re-observation weakens it further
  registry.tick(3000 + 15000);
  const decayed = registry.get('Ambient Drone', 'genre');
  assert.ok(decayed.confidence < 0.35);
  assert.equal(decayed.status, 'weakened');
});

test('14. Anti-hallucination isolation: displayed words and phrasePool outputs are blocked by firewall from upstream evidence fusion', () => {
  const EvidenceFusion = require('../js/semantic/evidenceFusionEngine');
  const engine = new EvidenceFusion.Engine();

  const legitimateDSP = [Facets.token('4/4 킥', 'rhythm', 0.8, ['rhythm.kick'], { source: 'local' })];
  const hallucinatedWords = [Facets.token('감미로운 달빛의 왈츠', 'mood', 0.95, [], { source: 'words' })];
  const phrasePoolArtifacts = [Facets.token('네온빛 사이버펑크 멜로디', 'association', 0.9, [], { source: 'phrasePool' })];

  const fused = engine.fuse({
    local: legitimateDSP,
    words: hallucinatedWords,
    phrasePool: phrasePoolArtifacts
  });

  assert.equal(fused.length, 1);
  assert.equal(fused[0].text, '4/4 킥');
  assert.equal(fused.some(item => item.text.includes('달빛')), false, 'words source must be rejected by firewall');
  assert.equal(fused.some(item => item.text.includes('사이버펑크')), false, 'phrasePool source must be rejected by firewall');
});

test('15. End-to-end Progressive Listening timeline scenario (5s -> 15s -> 30s deep listen -> 60s section transition -> 75s recovery)', () => {
  const engine = new ProgressiveListening.Engine();

  // T = 5s: Startup, basic audio, uncertain genre
  const state5s = {
    audio: { bpm: 124, beatConfidence: 0.6 },
    primitives: { "pulse.tempo": { value: 124 } },
    genre: { confidence: 0.25, uncertain: true }
  };
  const r5 = engine.update({ state: state5s, observationSeconds: 5 }, 5000);
  const w5 = engine.getLayerWeights();
  assert.ok(w5.LIVE >= 0.35, '5s: LIVE weight should be high');
  assert.ok(w5.FACT >= 0.30, '5s: FACT weight should be prominent');
  assert.equal(w5.AESTHETIC, 0, '5s: AESTHETIC should be 0');

  // T = 15s: Rhythm and primitives consolidate, genre hypothesis forming
  const state15s = {
    audio: { bpm: 124, beatConfidence: 0.85 },
    primitives: { "pulse.tempo": { value: 124 }, "drum.kick": { value: 1 }, "drum.hihat": { value: 1 } },
    genre: { confidence: 0.58, uncertain: false, entropy: 0.45, margin: 0.25 },
    genreReasoning: { primary: { independentEvidenceCount: 2, temporalStability: 0.6 } }
  };
  const r15 = engine.update({ state: state15s, observationSeconds: 15 }, 15000);
  assert.ok(r15.fact > r5.fact, '15s: fact readiness matures');
  assert.ok(r15.genre > r5.genre, '15s: genre readiness starts growing');

  // T = 30s: First deep listen arrives with structured packet
  engine.noteDeepListen('obs-flam-1', 30000);
  const state30s = {
    ...state15s,
    openWorldConcepts: [
      { canonicalLabel: 'Future Funk', conceptType: 'genre', confidence: 0.75 },
      { canonicalLabel: '시티팝 샘플링', conceptType: 'scene', confidence: 0.70 },
      { canonicalLabel: '80년대 레트로 미학', conceptType: 'aesthetic', confidence: 0.72 }
    ]
  };
  const r30 = engine.update({ state: state30s, observationSeconds: 30 }, 30000);
  const w30 = engine.getLayerWeights();
  assert.ok(r30.aesthetic > 0.40, '30s: aesthetic readiness rises on deep listen');
  assert.ok(w30.AESTHETIC > 0.15, '30s: aesthetic layer is now sampled');
  assert.ok(w30.FACT >= 0.30, '30s: FACT layer never drops below floor');

  // T = 60s: Section transition / drop occurs
  const r60 = engine.update({ state: state30s, observationSeconds: 60, sectionChange: true }, 60000);
  const w60 = engine.getLayerWeights();
  assert.ok(w60.LIVE > w30.LIVE, '60s: LIVE share temporarily jumps on section change');
  assert.ok(w60.FACT >= w30.FACT, '60s: FACT share holds/rises for re-interpretation');
  assert.ok(w60.AESTHETIC < w30.AESTHETIC, '60s: AESTHETIC temporarily yields for re-interpretation');

  // T = 75s: Re-interpretation completes, new section evidence consolidates
  const r75 = engine.update({ state: state30s, observationSeconds: 75, sectionChange: false }, 75000);
  const w75 = engine.getLayerWeights();
  assert.ok(w75.AESTHETIC > w60.AESTHETIC, '75s: interpretive layers smoothly recover');
  assert.ok(w75.FACT >= 0.30, '75s: FACT floor remains guaranteed throughout');
});

test('16. Music Flamingo structured observations flow seamlessly into displayCandidates, Manager.local, Critic.rank, and PhrasePool selection without whitelist or anchor blockers', () => {
  const Fusion = require('../js/semantic/evidenceFusionEngine');
  const Temporal = require('../js/semantic/temporalEvidenceEngine');
  const DirectAudioReview = require('../lib/directAudioReview');
  const Critic = require('../js/semantic/languageCritic');
  const Manager = require('../js/semantic/semanticFacetManager');
  const PhrasePool = require('../js/semantic/phrasePoolEngine');

  const fusion = new Fusion.Engine();
  const temporal = new Temporal.Engine();

  const review = DirectAudioReview.reviewCaption({
    caption: 'Electronic synth track with strong four-on-the-floor kick beat and bright melody.',
    structuredPacket: {
      audibleObservations: [{ text: '4/4 킥 비트', category: 'production', confidence: 0.8 }],
      genreHypotheses: [{ label: 'Synthpop', confidence: 0.75 }],
      contextHypotheses: [{ text: '80년대 레트로 씬', category: 'scene', confidence: 0.7 }],
      aestheticConcepts: [{ text: '네온 신스웨이브 미학', confidence: 0.7 }],
      impressions: [{ text: '고양되는 에너제틱 바이브', confidence: 0.7 }]
    },
    provider: 'music-flamingo'
  });
  const directAudio = DirectAudioReview.toObservations(review);
  assert.equal(directAudio.length, 5, 'All 5 packet facets converted to observations');

  const now = 10000;
  const fused = fusion.fuse({ directAudio }, now);
  const tempRes = temporal.update(fused, now);

  assert.ok(tempRes.displayCandidates.length >= 5, 'Temporal engine promotes directAudio observations to displayCandidates');

  const state = {
    sessionId: 10,
    semanticEpoch: 1,
    audio: { bpm: 120 },
    stateV2: { displayCandidates: tempRes.displayCandidates },
    directAudioCandidates: directAudio,
    directAudioObservationId: 'flam-test-16',
    expressionFeatures: { audible: true, sampleCount: 100, observationSeconds: 30 },
    trackCharacter: { confidence: 0.8 },
    genre: { primary: 'Synthpop', confidence: 0.8, displayLabel: 'Synthpop' },
    mood: { fused: { arousal: 0.7, brightness: 0.6 } }
  };

  const localCandidates = Manager.local(state);
  assert.ok(localCandidates.length >= 5, 'Manager.local contains directAudio candidates');

  const ranked = Critic.rank(localCandidates, { context: { snapshot: { primaryGenre: 'Synthpop', confidence: 0.8 } } });
  assert.ok(ranked.assessed.every(x => x.valid), 'All Flamingo directAudio candidates must pass critic validation');
  assert.ok(ranked.selected.length >= 5, 'All Flamingo directAudio candidates are selected');

  const poolEngine = new PhrasePool.Engine({ poolSize: 20 });
  poolEngine.regenerate({ state, sessionId: 10, epoch: 1, force: true });
  const poolWords = poolEngine.snapshot();
  assert.ok(poolWords.length >= 5, 'PhrasePool snapshot contains Flamingo words');

  const inspection = poolEngine.inspection();
  assert.ok(inspection.candidates.length >= 5, 'Inspection contains Flamingo candidates');
  assert.ok(inspection.selected.length >= 5, 'Inspection contains selected Flamingo candidates');
});
