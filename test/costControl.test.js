const test = require("node:test");
const assert = require("node:assert/strict");
const CostControl = require("../js/ai/costControl");

const stats = value => ({
  mean: value,
  std: value / 2,
  min: 0,
  max: value * 2,
  range: value * 2,
  median: value,
  p10: value / 4,
  p90: value * 1.5
});

test("AI feature packet keeps high-value descriptors and removes redundant statistics", () => {
  const audio = {
    samples: 360,
    realtimeSamples: 720,
    sampleRate: 48000,
    fftSize: 4096,
    harmony: {
      chroma: {
        vector: Array.from({ length: 12 }, (_, index) => index / 11),
        dominantNotes: [{ note: "C", strength: 0.45678 }],
        entropy: 0.65432,
        confidence: 0.34567
      },
      mfcc: {
        mean: Array.from({ length: 20 }, (_, index) => index + 0.12345),
        std: Array.from({ length: 20 }, (_, index) => index / 10)
      }
    },
    dynamics: {
      rms: stats(0.12345),
      energy: stats(0.23456),
      loudness: stats(0.34567),
      realtimeEnergy: stats(0.45678)
    },
    timbre: { flatness: stats(0.34567) },
    spectrum: {
      bands: { bass: stats(0.45678) },
      flux: stats(0.11111),
      centroid: stats(1200.12345),
      balance: stats(-0.12345)
    },
    instrumentationEvidence: {
      descriptors: { tonalFocus: 0.45678 },
      candidates: [{ id: "pianoKeys", score: 0.76543 }]
    },
    localMood: { warmth: 0.45678 }
  };

  const packet = CostControl.createFeaturePacket({
    audio,
    rhythm: { bpm: 127.89123, confidence: 0.81234 },
    inputMode: "file",
    windowSeconds: 15.12345
  });

  assert.equal(packet.version, 3);
  assert.equal(packet.audio.harmony.mfcc.mean.length, 13);
  assert.equal(packet.audio.harmony.mfcc.std.length, 13);
  assert.equal(packet.audio.dynamics.rms.mean, 0.123);
  assert.equal(packet.audio.dynamics.realtimeEnergy, undefined);
  assert.equal(packet.audio.realtimeSamples, undefined);
  assert.deepEqual(Object.keys(packet.audio.timbre.flatness), ["mean", "std", "median", "p10", "p90"]);
  assert.equal(packet.audio.timbre.flatness.max, undefined);
  assert.equal(packet.rhythm.bpm, 127.891);
});

test("fingerprint keys group nearby profiles into the same local cache bucket", () => {
  assert.equal(
    CostControl.fingerprintKey([0.101, 0.249, 0.899], 0.05),
    CostControl.fingerprintKey([0.099, 0.251, 0.901], 0.05)
  );
  assert.notEqual(
    CostControl.fingerprintKey([0.1, 0.25, 0.9], 0.05),
    CostControl.fingerprintKey([0.2, 0.25, 0.9], 0.05)
  );
});
