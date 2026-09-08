const test = require("node:test");
const assert = require("node:assert/strict");

const TrackLifecycleEngine = require("../lib/trackLifecycleEngine");
const FlamingoWordReservoir = require("../lib/flamingoWordReservoir");
const DirectAudioRealizer = require("../lib/directAudioRealizer");
const OpenWorld = require("../js/semantic/openWorldConceptRegistry");
const ProgressiveListening = require("../js/semantic/progressiveListeningEngine");
const SemanticFacetManager = require("../js/semantic/semanticFacetManager");
const { createLanguageService } = require("../lib/languageService");

test("CASE A: Stale response from Song A is discarded when Song B starts before response arrives", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  const reservoir = new FlamingoWordReservoir.Reservoir({ trackEpoch: lifecycle.getTrackEpoch() });
  lifecycle.onResetTrack = newEpoch => reservoir.reset(newEpoch);

  // Track 1 begins
  lifecycle.tick({ isAudible: true, now: 1000 });
  const reqTrack1 = lifecycle.createCompoundIdentity("req-1");
  assert.equal(reqTrack1.trackEpoch, 1);

  // Song 1 Flamingo packet is in flight...
  // Song 2 begins before response arrives!
  lifecycle.resetForNewTrack("track_change_detected");
  assert.equal(lifecycle.getTrackEpoch(), 2);
  assert.equal(reservoir.trackEpoch, 2);

  // Late response for Track 1 arrives
  const isAccepted = lifecycle.validateResponse(reqTrack1.trackEpoch);
  assert.equal(isAccepted, false, "Response for old trackEpoch 1 must be rejected by lifecycle engine");
  assert.equal(lifecycle.staleResponseDropCount, 1);

  // Reservoir must not ingest stale packet
  const ingested = reservoir.ingestPacket({
    genreHypotheses: [{ label: "Atmospheric Drum and Bass", confidence: 0.85 }],
    aestheticConcepts: [{ text: "nocturnal atmosphere", confidence: 0.80 }],
    impressions: [{ text: "melancholic propulsion", confidence: 0.75 }]
  }, { trackEpoch: reqTrack1.trackEpoch });

  assert.equal(ingested, false, "Reservoir must refuse to ingest stale packet");
  assert.equal(reservoir.pools.genre.length, 0, "Song B reservoir must remain completely clean of Song A genres");
  assert.equal(reservoir.pools.aesthetic.length, 0, "Song B reservoir must remain completely clean of Song A aesthetics");
});

test("CASE B: Song A pauses for 5 seconds then resumes; state is frozen but preserved with same trackEpoch", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  const reservoir = new FlamingoWordReservoir.Reservoir({ trackEpoch: lifecycle.getTrackEpoch() });
  lifecycle.onResetTrack = newEpoch => reservoir.reset(newEpoch);

  // Song A plays for 15s
  for (let t = 1000; t <= 16000; t += 200) {
    lifecycle.tick({ isAudible: true, now: t });
  }
  assert.equal(lifecycle.getState(), "LISTENING_STABLE");
  const epochBefore = lifecycle.getTrackEpoch();

  // Ingest Flamingo interpretation
  reservoir.ingestPacket({
    genreHypotheses: [{ label: "Future Funk", confidence: 0.80 }],
    aestheticConcepts: [{ text: "neon city aesthetics", confidence: 0.75 }]
  }, { trackEpoch: epochBefore });
  assert.equal(reservoir.pools.genre.length, 1);

  // Song A pauses for 5s (silence between 1.5s and 10s)
  lifecycle.tick({ isAudible: false, now: 16100 }); // silence begins
  lifecycle.tick({ isAudible: false, now: 18100 }); // 2s silence -> PAUSED
  assert.equal(lifecycle.getState(), "PAUSED");
  assert.equal(lifecycle.getTrackEpoch(), epochBefore, "Pause must not increment trackEpoch");

  lifecycle.tick({ isAudible: false, now: 21100 }); // 5s silence -> still PAUSED
  assert.equal(lifecycle.getState(), "PAUSED");

  // Song A resumes
  lifecycle.tick({ isAudible: true, now: 22000 });
  assert.ok(["RESUMING", "LISTENING_STABLE"].includes(lifecycle.getState()));
  assert.equal(lifecycle.getTrackEpoch(), epochBefore, "Resumed playback must retain the same trackEpoch");
  assert.equal(reservoir.pools.genre.length, 1, "Flamingo reservoir must be preserved without reset");
});

test("CASE C: Song A ends and Song B begins immediately with 0 silence; acoustic discontinuity triggers new track", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  const reservoir = new FlamingoWordReservoir.Reservoir({ trackEpoch: lifecycle.getTrackEpoch() });
  lifecycle.onResetTrack = newEpoch => reservoir.reset(newEpoch);

  // Song A: 120 BPM House
  lifecycle.tick({ isAudible: true, now: 1000, features: { bpm: 120, bpmConfidence: 0.9 } });
  reservoir.ingestPacket({
    genreHypotheses: [{ label: "Deep House", confidence: 0.8 }]
  }, { trackEpoch: 1 });
  assert.equal(reservoir.pools.genre.length, 1);

  // Instant switch to Song B: 174 BPM Drum & Bass with almost 0 silence
  const boundaryFeatures = { bpm: 174, bpmConfidence: 0.9, spectralNovelty: 0.95 };
  lifecycle.tick({ isAudible: true, now: 2000, features: boundaryFeatures });
  lifecycle.tick({ isAudible: true, now: 2200, features: boundaryFeatures });

  assert.equal(lifecycle.getTrackEpoch(), 2, "Acoustic discontinuity must increment trackEpoch to 2");
  assert.equal(reservoir.trackEpoch, 2);
  assert.equal(reservoir.pools.genre.length, 0, "Song A Flamingo pool must clear on track boundary");
});

test("CASE D: Audio is stopped for a long time (>12s silence); transitions to AUDIO_REMOVED and clears memory", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  const reservoir = new FlamingoWordReservoir.Reservoir({ trackEpoch: lifecycle.getTrackEpoch() });
  lifecycle.onAudioRemoved = () => reservoir.reset(lifecycle.getTrackEpoch());

  lifecycle.tick({ isAudible: true, now: 1000 });
  reservoir.ingestPacket({
    genreHypotheses: [{ label: "Ambient", confidence: 0.7 }]
  }, { trackEpoch: 1 });
  assert.equal(reservoir.pools.genre.length, 1);

  // Silence for 13 seconds
  lifecycle.tick({ isAudible: false, now: 3000 });  // 2s -> PAUSED
  lifecycle.tick({ isAudible: false, now: 15000 }); // 14s -> AUDIO_REMOVED
  assert.equal(lifecycle.getState(), "AUDIO_REMOVED");
  assert.equal(reservoir.pools.genre.length, 0, "Reservoir must be cleared when audio is removed");
});

test("CASE E: Flamingo identifies unknown open-world genres without local whitelist rejection", () => {
  const registry = new OpenWorld.Registry();
  const unknownGenres = ["Singeli", "Gqom", "Mallsoft", "Atmospheric Drum and Bass"];

  for (const genreName of unknownGenres) {
    const concept = registry.propose({
      label: genreName,
      conceptType: "genre",
      source: "directAudio",
      sourceModel: "music-flamingo",
      confidence: 0.72
    });
    assert.ok(concept, `${genreName} must be successfully registered in OpenWorldConceptRegistry`);
    assert.equal(concept.canonicalLabel, genreName);
    assert.equal(concept.status, "provisional");
  }

  // Display candidates through SemanticFacetManager must keep open-world genre
  const state = {
    openWorldConcepts: registry.all(),
    directAudioCandidates: unknownGenres.map(g => ({
      text: g,
      canonicalText: g,
      category: "genre",
      layer: "CONTEXT",
      source: "directAudio",
      confidence: 0.72,
      requiresKoreanRealization: false
    }))
  };

  const localCandidates = SemanticFacetManager.local(state);
  const localTexts = localCandidates.map(c => c.text);
  assert.ok(localTexts.some(t => t.includes("Singeli")), "Singeli must be present in local display candidates");
  assert.ok(localTexts.some(t => t.includes("Gqom")), "Gqom must be present in local display candidates");
});

test("CASE F: Flamingo subjective concepts stay exact until external Korean realization arrives", () => {
  const realizer = new DirectAudioRealizer.Realizer();

  const nocturnal = realizer.realize("nocturnal atmosphere", "aesthetic");
  assert.deepEqual(nocturnal, ["nocturnal atmosphere"]);

  const propulsion = realizer.realize("melancholic propulsion", "impression");
  assert.deepEqual(propulsion, ["melancholic propulsion"]);

  const liquid = realizer.realize("liquid atmospheric textures", "aesthetic");
  assert.deepEqual(liquid, ["liquid atmospheric textures"]);

  // Verify reservoir candidate conversion
  const reservoir = new FlamingoWordReservoir.Reservoir({ realizer });
  reservoir.ingestPacket({
    aestheticConcepts: [{ text: "nocturnal atmosphere", confidence: 0.8 }],
    impressions: [{ text: "melancholic propulsion", confidence: 0.75 }]
  }, { trackEpoch: 1 });

  reservoir.applyRealization("nocturnal atmosphere", ["외부 표현 하나", "외부 표현 둘"], "association");
  reservoir.applyRealization("melancholic propulsion", ["외부 인상 하나", "외부 인상 둘"], "mood");

  const candidates = reservoir.getCandidates();
  assert.equal(candidates.length, 2);
  for (const c of candidates) {
    assert.equal(c.requiresKoreanRealization, false, "Externally realized candidates must be ready for Korean UI");
    assert.ok(/[가-힣]/.test(c.text), `Candidate text must be Korean: ${c.text}`);
  }
});

test("CASE G: Flamingo realization bypasses the ~45s regular language pool cooldown", async () => {
  // Normal language pool service has 45s cooldown
  const langService = createLanguageService({
    client: { responses: { create: async () => ({ status: "completed", output_text: "{}" }) } },
    model: "test-model",
    minimumIntervalMs: 45000
  });

  // DirectAudioRealizer executes immediately without being throttled by minimumIntervalMs
  const startTime = Date.now();
  const phrases1 = DirectAudioRealizer.realize("glossy late-night urban atmosphere", "aesthetic");
  const phrases2 = DirectAudioRealizer.realize("digital nostalgia", "aesthetic");
  const elapsed = Date.now() - startTime;

  assert.ok(elapsed < 50, "Direct realization must be instant (< 50ms) and bypass 45s cooldown");
  assert.ok(phrases1.length > 0);
  assert.ok(phrases2.length > 0);
});

test("CASE H: Flamingo packet with rich aesthetics but weak context boosts AESTHETIC without inflating CONTEXT", () => {
  const engine = new ProgressiveListening.Engine();
  const state = {
    audio: { bpm: 120, beatConfidence: 0.8 },
    genre: { confidence: 0.5, uncertain: true, entropy: 0.6 }
  };

  // 10s baseline
  engine.update({ state, observationSeconds: 10 }, 10000);
  const preReadiness = engine.readiness;
  assert.equal(preReadiness.aesthetic, 0);

  // Deep listen packet arrives with 3 rich aesthetic concepts and 0 context hypotheses
  engine.noteDeepListen("obs-flam-1", {
    aestheticConcepts: [
      { text: "liquid atmospheric textures" },
      { text: "nocturnal urban atmosphere" },
      { text: "spacious reverb tails" }
    ],
    contextHypotheses: [] // Empty context!
  }, 10500);

  engine.update({ state, observationSeconds: 11 }, 11000);
  const postReadiness = engine.readiness;

  assert.ok(postReadiness.aesthetic > 0.40, `Aesthetic readiness must rise strongly on rich aesthetics (got ${postReadiness.aesthetic})`);
  assert.ok(postReadiness.context < 0.15, `Context readiness must stay low without context hypotheses (got ${postReadiness.context})`);
});

test("CASE I: Progressive 5-layer evolution on a new track (LIVE/FACT first -> Genre/Context -> Aesthetics/Impressions)", () => {
  const engine = new ProgressiveListening.Engine();
  const state = {
    primitives: { "pulse.tempo": { value: 128 }, "drum.kick": { value: 1 } },
    genre: { confidence: 0.20, uncertain: true, entropy: 0.8 }
  };

  // 1. T = 2s (New Track): LIVE and FACT divide 100% of display space
  engine.update({ state, observationSeconds: 2 }, 2000);
  const earlyWeights = engine.getLayerWeights();
  assert.ok(earlyWeights.LIVE > 0.40, "Early track: LIVE must be prominent");
  assert.ok(earlyWeights.FACT > 0.40, "Early track: FACT must be prominent");
  assert.equal(earlyWeights.CONTEXT, 0, "Early track: CONTEXT must be 0 without evidence");
  assert.equal(earlyWeights.AESTHETIC, 0, "Early track: AESTHETIC must be 0 without evidence");
  assert.equal(earlyWeights.IMPRESSION, 0, "Early track: IMPRESSION must be 0 without evidence");

  // 2. T = 15s: Patterns and genre hypotheses emerge
  state.genre = { confidence: 0.68, uncertain: false, entropy: 0.35 };
  state.openWorldConcepts = [{ conceptType: "genre", canonicalLabel: "Future Funk", confidence: 0.75 }];
  engine.update({ state, observationSeconds: 15 }, 15000);
  const midWeights = engine.getLayerWeights();
  assert.ok(midWeights.CONTEXT > 0, "Mid track: CONTEXT opens up");
  assert.ok(midWeights.FACT >= 0.30, "FACT floor (>=0.30) must be preserved");

  // 3. T = 30s: Flamingo deep listening arrives with rich aesthetic & impression concepts
  engine.noteDeepListen("obs-flam-1", {
    aestheticConcepts: [{ text: "japanese bubble era resonance" }, { text: "soft metallic distance" }],
    impressions: [{ text: "bittersweet euphoric rush" }, { text: "guarded warmth" }],
    contextHypotheses: [{ text: "japanese city pop influence" }]
  }, 30000);
  state.openWorldConcepts.push(
    { conceptType: "aesthetic", canonicalLabel: "버블기 잔향", confidence: 0.75 },
    { conceptType: "impression", canonicalLabel: "달콤씁쓸한 고양감", confidence: 0.70 }
  );

  engine.update({ state, observationSeconds: 30 }, 30000);
  const deepWeights = engine.getLayerWeights();
  assert.ok(deepWeights.AESTHETIC > 0.12, "Deep track: AESTHETIC layer is actively sampled");
  assert.ok(deepWeights.IMPRESSION > 0.12, "Deep track: IMPRESSION layer is actively sampled");
  assert.ok(deepWeights.FACT >= 0.15, "FACT keeps an adaptive safety floor even in deep immersion");
});
