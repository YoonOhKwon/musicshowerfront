const test = require("node:test");
const assert = require("node:assert/strict");
const TrackCharacter = require("../js/semantic/trackCharacterEngine");

function fixture(overrides = {}) {
  return {
    audio: { bpm: 128, beatConfidence: 0.84, bass: 0.55, high: 0.32, energy: 0.42, centroid: 3200, flatness: 0.18 },
    rhythm: { bpm: 128, confidence: 0.84, onsetRate: 2.2, beatIntervalMean: 468, beatIntervalStd: 22 },
    advanced: {
      samples: 180,
      harmony: { chroma: { confidence: 0.68, entropy: 0.42, dominantNotes: [{ note: "A", strength: 0.22 }] } },
      timbre: {
        centroid: { mean: 3200 }, spread: { mean: 2800 }, crest: { mean: 12 }, flatness: { mean: 0.18 },
        sharpness: { mean: 1.8 }, zcr: { mean: 0.08 }
      },
      dynamics: { rms: { mean: 0.18, median: 0.17, p10: 0.1, p90: 0.28 }, realtimeEnergy: { mean: 0.38 } },
      spectrum: { flux: { mean: 0.015, std: 0.007, p90: 0.032 } },
      instrumentationEvidence: { descriptors: { lowShare: 0.48, midShare: 0.36, transientDensity: 0.55, bassVariation: 0.46, sustain: 0.34, chromaMotion: 0.18 } },
      localMood: { spaciousness: 0.42 }
    },
    temporal: { observations: 5, embeddingAgreement: 0.88 },
    novelty: { score: 0.08 },
    ...overrides
  };
}

test("stable evidence produces a stable bounded Track Character", () => {
  const engine = new TrackCharacter.Engine({ smoothing: 0.3, historySize: 5 });
  const first = engine.update(fixture());
  for (let index = 0; index < 9; index++) engine.update(fixture());
  const last = engine.current;
  assert.ok(TrackCharacter.distance(first, last) < 0.02);
  assert.equal(engine.history.length, 5);
  assert.equal(last.harmony.dominantPitchClass, "A");
  assert.equal(last.harmony.keyEstimate, null);
  assert.ok(last.rhythm.pulseRegularity > 0.7);
});

test("large sonic evidence change changes Track Character", () => {
  const steady = TrackCharacter.rawProfile(fixture());
  const broken = TrackCharacter.rawProfile(fixture({
    audio: { bpm: 174, beatConfidence: 0.22, bass: 0.2, high: 0.9, energy: 0.82, centroid: 9200, flatness: 0.76 },
    rhythm: { bpm: 174, confidence: 0.22, onsetRate: 4.8, beatIntervalMean: 345, beatIntervalStd: 118 },
    advanced: {
      ...fixture().advanced,
      timbre: { centroid: { mean: 9200 }, spread: { mean: 6700 }, crest: { mean: 25 }, flatness: { mean: 0.76 }, sharpness: { mean: 4.2 }, zcr: { mean: 0.28 } },
      spectrum: { flux: { mean: 0.044, std: 0.026, p90: 0.09 } },
      instrumentationEvidence: { descriptors: { lowShare: 0.18, midShare: 0.4, transientDensity: 0.9, bassVariation: 0.8, sustain: 0.08, chromaMotion: 0.72 } },
      localMood: { spaciousness: 0.76 }
    },
    novelty: { score: 0.9 }
  }));
  assert.ok(TrackCharacter.distance(steady, broken) > 0.2);
  assert.ok(broken.rhythm.breakbeatLikelihood > steady.rhythm.breakbeatLikelihood);
});
