const test = require('node:test');
const assert = require('node:assert/strict');
const TrackLifecycleEngine = require('../js/semantic/trackLifecycleEngine');

test('a pause followed by a genuinely different song is TRACK_CHANGED, never RESUMED_FROM_PAUSE', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };

  // Song A: 120 BPM house, establishes an acoustic signature.
  lifecycle.tick({ isAudible: true, now: 1000, features: { bpm: 120, bpmConfidence: 0.9 } });
  lifecycle.tick({ isAudible: true, now: 1200, features: { bpm: 120, bpmConfidence: 0.9 } });
  const epochBefore = lifecycle.getTrackEpoch();

  // User pauses Song A for 4 seconds (a normal pause length, well under the 12s remove threshold)...
  lifecycle.tick({ isAudible: false, now: 1400 });
  lifecycle.tick({ isAudible: false, now: 5400 }); // 4s silence -> PAUSED
  assert.equal(lifecycle.getState(), 'PAUSED');

  // ...but picks a completely different song (174 BPM DnB) before pressing play again.
  lifecycle.tick({ isAudible: true, now: 5500, features: { bpm: 174, bpmConfidence: 0.9, spectralNovelty: 0.95 } });

  assert.equal(lifecycle.getTrackEpoch(), epochBefore + 1, 'a real song change during the gap must still increment trackEpoch');
  assert.equal(resetCount, 1, 'onResetTrack must fire for a genuine track change, even though it arrived via a pause');
});

test('a pause followed by the SAME song resumes normally without a false track change', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };

  lifecycle.tick({ isAudible: true, now: 1000, features: { bpm: 120, bpmConfidence: 0.9 } });
  lifecycle.tick({ isAudible: true, now: 1200, features: { bpm: 120, bpmConfidence: 0.9 } });
  const epochBefore = lifecycle.getTrackEpoch();

  lifecycle.tick({ isAudible: false, now: 1400 });
  lifecycle.tick({ isAudible: false, now: 5400 }); // PAUSED
  assert.equal(lifecycle.getState(), 'PAUSED');

  // Resumes the SAME song at the same tempo.
  lifecycle.tick({ isAudible: true, now: 5500, features: { bpm: 121, bpmConfidence: 0.9 } });

  assert.equal(lifecycle.getTrackEpoch(), epochBefore, 'the same song resuming must not increment trackEpoch');
  assert.equal(resetCount, 0, 'onResetTrack must not fire for a genuine resume');
  assert.ok(['RESUMING', 'LISTENING_STABLE', 'LISTENING_NEW'].includes(lifecycle.getState()));
});

test('a sub-1.5s blip is observable as PAUSE_SUSPECTED and resolves back without any reset', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };

  for (let t = 1000; t <= 11000; t += 200) lifecycle.tick({ isAudible: true, now: t });
  assert.equal(lifecycle.getState(), 'LISTENING_STABLE');

  lifecycle.tick({ isAudible: false, now: 11200 }); // 200ms silence, well under the 1.5s pause threshold
  assert.equal(lifecycle.getState(), 'PAUSE_SUSPECTED');

  lifecycle.tick({ isAudible: true, now: 11400 }); // resumes before ever reaching PAUSED
  assert.equal(lifecycle.getState(), 'LISTENING_STABLE', 'a brief blip must resolve straight back to the state it was already in');
  assert.equal(resetCount, 0);
});

test('discontinuityScore returns null (not 0) when there is nothing yet to compare against', () => {
  const detector = new TrackLifecycleEngine.TrackBoundaryDetector();
  assert.equal(detector.discontinuityScore({ bpm: 120 }), null);
  detector.evaluate({ isAudible: true, now: 1000, features: { bpm: 120, bpmConfidence: 0.9 } });
  assert.equal(detector.discontinuityScore({ bpm: 120, bpmConfidence: 0.9 }), 0);
});

test('chroma meaningfully raises the discontinuity score even though it alone stays under threshold', () => {
  // By design, chroma (0.35) or spectralNovelty (0.30) alone must NOT cross the 0.72 threshold --
  // a key/chord change or a loud section is normal WITHIN one song, not proof of a new one. Chroma
  // is a corroborating signal, not a standalone trigger; this only proves it now contributes at
  // all (js/main.js used to never pass it, so it contributed exactly 0 no matter how different).
  const detector = new TrackLifecycleEngine.TrackBoundaryDetector();
  const chromaA = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
  const chromaB = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];
  detector.evaluate({ isAudible: true, now: 1000, features: { bpm: 124, bpmConfidence: 0.9, chroma: chromaA } });

  const withoutChromaShift = detector.discontinuityScore({ bpm: 124, bpmConfidence: 0.9, chroma: chromaA });
  const withChromaShift = detector.discontinuityScore({ bpm: 124, bpmConfidence: 0.9, chroma: chromaB });
  assert.equal(withoutChromaShift, 0);
  assert.ok(withChromaShift >= 0.35, 'a real tonal-center shift must add its full weight to the score');
  assert.ok(withChromaShift < 0.72, 'chroma alone must still stay under the reset threshold');
});

test('a same-tempo track change combining chroma AND spectral novelty with even a modest tempo drift crosses threshold', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };

  const chromaA = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
  lifecycle.tick({ isAudible: true, now: 1000, features: { bpm: 124, bpmConfidence: 0.9, chroma: chromaA } });
  lifecycle.tick({ isAudible: true, now: 1200, features: { bpm: 124, bpmConfidence: 0.9, chroma: chromaA } });

  // Song B: a large enough tempo drift to clear the 35% ratio threshold on its own, PLUS a tonal
  // shift and a spectral novelty spike -- three independent cues agreeing, the realistic shape of
  // an actual song change rather than a single glitchy reading.
  const chromaB = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];
  lifecycle.tick({ isAudible: true, now: 2000, features: { bpm: 174, bpmConfidence: 0.9, chroma: chromaB, spectralNovelty: 0.9 } });

  assert.equal(resetCount, 1, 'multiple agreeing signals (now including chroma) must trigger a track change');
});

test('an exact-same-BPM track change is detected when tonal, novelty, and timbre signatures agree', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };
  const chromaA = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
  const chromaB = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];

  lifecycle.tick({ isAudible: true, now: 1000, features: {
    bpm: 124, bpmConfidence: 0.9, chroma: chromaA, centroid: 1400, flatness: 0.08, rms: 0.08
  } });
  lifecycle.tick({ isAudible: true, now: 1800, features: {
    bpm: 124, bpmConfidence: 0.9, chroma: chromaB, spectralNovelty: 0.92,
    centroid: 2600, flatness: 0.31, rms: 0.08
  } });

  assert.equal(resetCount, 1, 'same tempo must not conceal a multi-signal acoustic boundary');
});

test('a same-tempo crossfade with several moderate identity shifts is confirmed persistently', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };
  const songA = {
    bpm: 116, bpmConfidence: 0.9,
    chroma: [1, 0.2, 0, 0.8, 0.1, 0, 0.7, 0.2, 0, 0.6, 0.1, 0],
    mfcc: [20, 8, 5, 3, 2, 1, -1, -2, -3],
    bands: [0.62, 0.28, 0.10], centroid: 1700, flatness: 0.09, rms: 0.08
  };
  const songB = {
    bpm: 116, bpmConfidence: 0.9,
    chroma: [0.1, 0.7, 0.2, 0, 0.8, 0.1, 0, 0.7, 0.1, 0, 0.6, 0.2],
    mfcc: [20, -4, 7, -5, 6, -3, 4, -2, 5],
    bands: [0.14, 0.34, 0.52], centroid: 2050, flatness: 0.16, rms: 0.075
  };

  lifecycle.tick({ isAudible: true, now: 1000, features: songA });
  lifecycle.tick({ isAudible: true, now: 1600, features: songB });
  assert.equal(resetCount, 0, 'moderate evidence must not reset on one observation');
  lifecycle.tick({ isAudible: true, now: 2100, features: songB });
  lifecycle.tick({ isAudible: true, now: 2600, features: songB });

  assert.equal(resetCount, 1, 'persistent multi-feature identity change must reset a continuous stream');
  assert.equal(lifecycle.getTrackEpoch(), 2);
});

test('a normal same-track section hit with novelty and a chord shift does not reset the track', () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };
  const base = {
    bpm: 124, bpmConfidence: 0.9,
    chroma: [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05],
    mfcc: [20, 8, 5, 3, 2, 1, -1, -2, -3], bands: [0.4, 0.4, 0.2]
  };
  const chorus = { ...base,
    chroma: [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0], spectralNovelty: 0.95 };
  lifecycle.tick({ isAudible: true, now: 1000, features: base });
  for (let now = 1300; now <= 4000; now += 300) {
    lifecycle.tick({ isAudible: true, now, features: chorus });
  }
  assert.equal(resetCount, 0, 'section novelty without a second identity family must stay within the song');
});

test("gradual drift of smoothed acoustic features (how bpm/chroma/novelty actually behave -- rolling averages, not instant values) is still caught once the baseline is old enough", () => {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resetCount = 0;
  lifecycle.onResetTrack = () => { resetCount += 1; };

  const chromaA = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
  const chromaB = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];
  const lerp = (a, b, t) => a + (b - a) * t;

  // 16 ticks, 100ms apart (1.5s total, well inside the 2.5s baseline hold) drifting linearly from
  // Song A's signature to Song B's. Each SINGLE step is tiny (~3.6 bpm, ~3% ratio) -- far below
  // tempoJumpThreshold (35%) -- so a naive tick-to-tick comparison (the previous behavior) could
  // never see this as anything but continuous, no matter how far the cumulative drift eventually
  // goes. This is exactly how bpm/chroma/novelty behave in the real pipeline: smoothed, gradual.
  let now = 1000;
  let sawTrackChange = false;
  let firstSeenAtTick = -1;
  for (let i = 0; i <= 15; i++) {
    const t = i / 15;
    const features = {
      bpm: lerp(120, 174, t),
      bpmConfidence: 0.9,
      chroma: chromaA.map((v, idx) => lerp(v, chromaB[idx], t))
    };
    const result = lifecycle.tick({ isAudible: true, now, features });
    if (result.boundary?.type === "TRACK_CHANGED" && !sawTrackChange) { sawTrackChange = true; firstSeenAtTick = i; }
    now += 100;
  }
  assert.equal(sawTrackChange, true, "cumulative drift across the held baseline window must eventually register as a real track change");
  assert.ok(firstSeenAtTick > 0 && firstSeenAtTick < 15, "must fire mid-drift, once enough real time has passed -- not only at the final, most-different tick");
  assert.equal(resetCount, 1);
});

test("the SAME gradual drift never fires if the baseline were naively refreshed every tick (regression guard for the original bug)", () => {
  // Rebuilds the old (buggy) per-tick comparison directly to prove it is genuinely blind to this
  // case -- not a strawman. If this assertion ever fails, the two implementations have converged
  // and the scenario above no longer demonstrates anything.
  const detector = new TrackLifecycleEngine.TrackBoundaryDetector();
  const chromaA = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
  const chromaB = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];
  const lerp = (a, b, t) => a + (b - a) * t;

  let maxScore = 0;
  for (let i = 0; i <= 15; i++) {
    const t = i / 15;
    const features = { bpm: lerp(120, 174, t), bpmConfidence: 0.9,
      chroma: chromaA.map((v, idx) => lerp(v, chromaB[idx], t)) };
    const score = detector.discontinuityScore(features);
    if (score !== null) maxScore = Math.max(maxScore, score);
    // The bug: refresh the baseline to the CURRENT tick every single time, unconditionally.
    detector.lastAcousticFeatures = { ...features };
  }
  assert.ok(maxScore < 0.72, "naive per-tick baseline refresh never accumulates enough delta to cross the threshold, even though the song fully changed");
});

// --- Track signature: "is this still the same piece of music?" -------------------------------
// The 2.5s baseline only answers "did something just change?", which a drop, a breakdown and a
// brand new song all answer YES to. These cover both failure directions that caused: cutting
// mid-song, and missing a real change between two songs that share tempo and key.
const PALETTE_A = [-200, 40, -12, 18, -6, 9, -3, 5, 2];
const PALETTE_B = [-200, -30, 25, -14, 20, -11, 14, -8, 6];
const KEY_A = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.1, 0, 0.05];
const KEY_B = [0, 0.9, 0, 0.05, 0, 1, 0.1, 0, 0.85, 0, 0.2, 0];
const boundaryFeatures = (mfcc, chroma, extra = {}) => ({
  bpm: 124, bpmConfidence: 0.9, mfcc, chroma,
  centroid: 2000, flatness: 0.3, rms: 0.05, bands: [0.4, 0.35, 0.25], ...extra
});

function runMatureTrack(tailFeatures, tailTicks = 40) {
  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resets = 0;
  lifecycle.onResetTrack = () => { resets += 1; };
  let now = 1000;
  // Long enough for the signature to mature (minSignatureSamples).
  for (let i = 0; i < 70; i++) {
    lifecycle.tick({ isAudible: true, now, features: boundaryFeatures(PALETTE_A, KEY_A) });
    now += 100;
  }
  for (let i = 0; i < tailTicks; i++) {
    lifecycle.tick({ isAudible: true, now, features: tailFeatures });
    now += 100;
  }
  return { resets, inspect: lifecycle.inspect() };
}

test('a mid-song drop -- novelty spike, loudness/centroid jump AND a chord change -- does not reset the track', () => {
  // Everything the 2.5s baseline can see screams "changed", but the instrument palette is
  // untouched, so the signature still recognises the same piece. This exact shape was cutting
  // mid-song before the signature existed.
  const { resets } = runMatureTrack(
    boundaryFeatures(PALETTE_A, KEY_B, { spectralNovelty: 0.95, rms: 0.2, centroid: 4200 }));
  assert.equal(resets, 0, 'a drop is a section, not a new track');
});

test('a quiet mid-song breakdown does not reset the track', () => {
  const { resets } = runMatureTrack(
    boundaryFeatures(PALETTE_A, KEY_A, { spectralNovelty: 0.6, rms: 0.01, centroid: 1200 }));
  assert.equal(resets, 0);
});

test('a NEW song sharing tempo AND key is still caught, because its timbral signature is gone', () => {
  // Tempo identical, key identical, no silence gap: the baseline sees almost nothing. Only the
  // track signature moved, so it has to carry both the cue AND enough score to be believed --
  // otherwise this transition stays invisible, which is exactly what used to happen.
  const { resets } = runMatureTrack(boundaryFeatures(PALETTE_B, KEY_A, { spectralNovelty: 0.5 }));
  assert.equal(resets, 1, 'a same-tempo, same-key track change must still be detected');
});

test('an established signature is not walked into the next song by its own running mean', () => {
  // The signature stops updating as soon as the audio no longer clearly matches it. Without that
  // guard a slow crossfade would blend Song B into the profile and erase its own evidence.
  const { inspect } = runMatureTrack(boundaryFeatures(PALETTE_B, KEY_A, { spectralNovelty: 0.5 }), 8);
  assert.ok(inspect.signatureSimilarity !== null && inspect.signatureSimilarity < 0.5,
    `signature should still report the mismatch, got ${inspect.signatureSimilarity}`);
});

test('steady continuation keeps the signature matched and never resets', () => {
  const { resets, inspect } = runMatureTrack(boundaryFeatures(PALETTE_A, KEY_A));
  assert.equal(resets, 0);
  assert.ok(inspect.signatureSimilarity > 0.95);
});

// The cases above feed noiseless constants, where "same song" means a similarity of exactly 1.
// Real analysis frames never repeat: measured same-song similarity has a p10 near 0.83, which is
// why a fixed hold threshold cut songs in half in practice while these tests stayed green. These
// replay the same questions through jittered features, which is the shape the detector really sees.
function noisyRun(tailFeatures, { headSeconds = 60, tailSeconds = 25 } = {}) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const jitter = (value, pct) => value * (1 + (rnd() - 0.5) * 2 * pct);
  const noisy = (f) => ({
    ...f,
    bpm: jitter(f.bpm, 0.015),
    chroma: f.chroma.map((v) => Math.max(0, jitter(v + 0.02, 0.18))),
    mfcc: f.mfcc.map((v) => v + (rnd() - 0.5) * 1.2),
    bands: f.bands.map((v) => Math.max(0, jitter(v, 0.06))),
    centroid: jitter(f.centroid, 0.05),
    flatness: jitter(f.flatness, 0.1),
    rms: jitter(f.rms, 0.08),
    spectralNovelty: jitter(f.spectralNovelty === undefined ? 0.18 : f.spectralNovelty, 0.1)
  });

  const lifecycle = new TrackLifecycleEngine.LifecycleEngine();
  let resets = 0;
  lifecycle.onResetTrack = () => { resets += 1; };
  let now = 1000;
  const feed = (features, seconds) => {
    for (let i = 0; i < seconds * 2; i++) { // 500ms ticks, the real cadence
      lifecycle.tick({ isAudible: true, now, features: noisy(features) });
      now += 500;
    }
  };
  feed(boundaryFeatures(PALETTE_A, KEY_A), headSeconds);
  const resetsDuringHead = resets;
  feed(tailFeatures, tailSeconds);
  return { resets, resetsDuringHead };
}

test('a full minute of ONE noisy song never resets itself (the mid-song cutting bug)', () => {
  const { resets } = noisyRun(boundaryFeatures(PALETTE_A, KEY_A));
  assert.equal(resets, 0, 'frame-to-frame noise must not read as a track boundary');
});

test('a noisy mid-song drop does not reset -- the tempo is locked and the palette still matches', () => {
  const { resets, resetsDuringHead } = noisyRun(
    boundaryFeatures(PALETTE_A, KEY_A, { spectralNovelty: 0.88, rms: 0.16, centroid: 2450, flatness: 0.24,
      bands: [0.72, 0.2, 0.08] }));
  assert.equal(resetsDuringHead, 0);
  assert.equal(resets, 0, 'a drop is a section, not a song');
});

test('a noisy mid-song breakdown does not reset even though every level collapses', () => {
  const { resets } = noisyRun(
    boundaryFeatures(PALETTE_A, KEY_A, { spectralNovelty: 0.8, rms: 0.03, centroid: 2900, flatness: 0.3,
      bands: [0.22, 0.36, 0.42] }));
  assert.equal(resets, 0);
});

test('a noisy mid-song section change -- new key AND new layer -- does not reset', () => {
  const { resets } = noisyRun(
    boundaryFeatures(PALETTE_A, KEY_B, { spectralNovelty: 0.75, centroid: 2100, flatness: 0.17 }));
  assert.equal(resets, 0);
});

test('a noisy NEW song beatmatched to the same tempo AND key is still caught exactly once', () => {
  const { resets, resetsDuringHead } = noisyRun(
    boundaryFeatures(PALETTE_B, KEY_A, { spectralNovelty: 0.9, centroid: 2750, flatness: 0.28,
      bands: [0.16, 0.33, 0.51] }));
  assert.equal(resetsDuringHead, 0);
  assert.equal(resets, 1, 'noise tolerance must not cost us real, hard-to-see transitions');
});

test('a noisy NEW song with a different tempo is caught exactly once', () => {
  const { resets } = noisyRun(
    boundaryFeatures(PALETTE_B, KEY_B, { bpm: 92, spectralNovelty: 0.9, centroid: 2750, flatness: 0.28,
      bands: [0.16, 0.33, 0.51] }));
  assert.equal(resets, 1);
});
