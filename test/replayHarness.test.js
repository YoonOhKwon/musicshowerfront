const test = require("node:test");
const assert = require("node:assert/strict");
const Replay = require("../scripts/replay.cjs");
const ReplayRecorder = require("../js/debug/replayRecorder");

test("percentiles computes the requested points from a value list, ignoring non-finite entries", () => {
  const result = Replay.percentiles([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, NaN, undefined, null]);
  assert.equal(result.p50, 0.6, `expected the median-ish bucket, got ${result.p50}`);
  assert.ok(result.p10 < result.p90, "p10 must be below p90 for a spread distribution");
});

test("percentiles on an empty/all-non-finite list returns null for every point, never NaN or a fabricated 0", () => {
  const result = Replay.percentiles([]);
  for (const key of Object.keys(result)) assert.equal(result[key], null, key);
  const allNonFinite = Replay.percentiles([NaN, undefined, null]);
  for (const key of Object.keys(allNonFinite)) assert.equal(allNonFinite[key], null, key);
});

test("axisDistributions reports percentiles per named axis, independent of extra samples missing some axes", () => {
  const samples = [{ nostalgia: 0.6, warmth: 0.5 }, { nostalgia: 0.8 }, { warmth: 0.4 }];
  const result = Replay.axisDistributions(samples, ["nostalgia", "warmth", "tension"]);
  assert.equal(result.nostalgia.p50, 0.8, `nostalgia should only average its own two present samples, got ${result.nostalgia.p50}`);
  assert.equal(result.tension.p50, null, "an axis with zero samples must report null percentiles, not 0");
});

test("combinationSizeDistribution counts only aesthetic-axis-sourced items, keyed by how many axes each satisfied", () => {
  const items = [
    { source: "aesthetic-axis", axes: ["nostalgia", "decay"] },
    { source: "aesthetic-axis", axes: ["warmth"] },
    { source: "evidence-gated-prior", axes: ["nostalgia", "decay", "urbanity"] }, // not aesthetic-axis -- must be excluded
    { source: "idiom" }
  ];
  const result = Replay.combinationSizeDistribution(items);
  assert.equal(result[2], 1);
  assert.equal(result[1], 1);
  assert.equal(Object.values(result).reduce((sum, n) => sum + n, 0), 2, "only the two aesthetic-axis items should be counted");
});

test("checkDrift warns on a schema/model/preprocessing mismatch, and stays silent when everything matches", () => {
  const matching = { axisSchemaVersion: ReplayRecorder.SCHEMA_VERSION, modelVersion: ReplayRecorder.MODEL_VERSION,
    preprocessingConfig: ReplayRecorder.PREPROCESSING_CONFIG };
  assert.deepEqual(Replay.checkDrift("test.json", matching), []);
  const staleSchema = { ...matching, axisSchemaVersion: matching.axisSchemaVersion - 1 };
  assert.ok(Replay.checkDrift("test.json", staleSchema).some(warning => warning.includes("axisSchemaVersion")));
  const staleModel = { ...matching, modelVersion: "some-old-model" };
  assert.ok(Replay.checkDrift("test.json", staleModel).some(warning => warning.includes("modelVersion")));
  const stalePreprocessing = { ...matching, preprocessingConfig: { frameSize: 999 } };
  assert.ok(Replay.checkDrift("test.json", stalePreprocessing).some(warning => warning.includes("preprocessingConfig")));
});

test("stateFromFrame reconstructs a pipeline-shaped state, defaulting every missing field to an empty container rather than undefined", () => {
  const state = Replay.stateFromFrame({});
  assert.deepEqual(state.genre, {});
  assert.deepEqual(state.moodDimensions, {});
  assert.deepEqual(state.instruments, []);
  const populated = Replay.stateFromFrame({ genre: { primary: "Techno" }, instruments: [{ label: "drums" }] });
  assert.equal(populated.genre.primary, "Techno");
  assert.equal(populated.instruments[0].label, "drums");
});

test("replayTrack runs a small real recording through the full pipeline in well under a second and returns per-frame axis samples", () => {
  const frames = Array.from({ length: 10 }, (_, index) => ({
    t: index * 500,
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    moodDimensions: { warmth: 0.7, brightness: 0.6, valence: 0.6, arousal: 0.5, aggression: 0.2, tension: 0.2, spaciousness: 0.5, weight: 0.4 },
    productionEvidence: { sampleBased: 0.7, filterSweep: 0.6 },
    rhythmicGrammar: { fourOnFloor: 0.7, confidence: 0.7 },
    instruments: [{ label: "synth", confidence: 0.6, source: "ml" }],
    trackCharacter: {}, expressionFeatures: { audible: true, observationSeconds: 30 }
  }));
  const startedAt = Date.now();
  const result = Replay.replayTrack({ track: "unit_test_track", frames });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 2000, `replayTrack took ${elapsedMs}ms for 10 frames -- should be near-instant`);
  assert.equal(result.frameCount, 10);
  assert.equal(result.axisSamples.length, 10);
  assert.ok(typeof result.axisSamples[0].urbanity === "number", "a real evidence frame should resolve at least some axes");
  assert.ok(Array.isArray(result.selected));
});
