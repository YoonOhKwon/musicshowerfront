const test = require("node:test");
const assert = require("node:assert/strict");
const ReplayRecorder = require("../js/debug/replayRecorder");

test("start/stop records frames only while active, and reports frame count/track name live", () => {
  assert.equal(ReplayRecorder.isActive(), false);
  ReplayRecorder.capture({ genre: { primary: "Test" } }, 0);
  assert.equal(ReplayRecorder.frameCount(), 0, "capture before start() must be a no-op");
  ReplayRecorder.start("future_funk_01");
  assert.equal(ReplayRecorder.isActive(), true);
  assert.equal(ReplayRecorder.snapshot().track, "future_funk_01");
  ReplayRecorder.capture({ genre: { primary: "Future Funk" } }, 0);
  assert.equal(ReplayRecorder.frameCount(), 1);
  const recording = ReplayRecorder.stop();
  assert.equal(ReplayRecorder.isActive(), false);
  assert.equal(recording.frames.length, 1);
  assert.equal(recording.frames[0].genre.primary, "Future Funk");
  ReplayRecorder.capture({ genre: { primary: "Ignored" } }, 10000);
  assert.equal(ReplayRecorder.frameCount(), 1, "capture after stop() must be a no-op -- frame count stays whatever it was at stop()");
});

test("capture is throttled to the fixed interval, not every call", () => {
  ReplayRecorder.start("throttle_test");
  ReplayRecorder.capture({ genre: {} }, 0);
  ReplayRecorder.capture({ genre: {} }, 10);
  ReplayRecorder.capture({ genre: {} }, 100);
  assert.equal(ReplayRecorder.frameCount(), 1, "captures within the throttle window must be dropped");
  ReplayRecorder.capture({ genre: {} }, 600);
  assert.equal(ReplayRecorder.frameCount(), 2, "a capture past the throttle window must be recorded");
  ReplayRecorder.stop();
});

test("frame timestamps are relative to when recording started, not absolute", () => {
  ReplayRecorder.start("relative_time_test", 5000);
  ReplayRecorder.capture({ genre: {} }, 5000);
  ReplayRecorder.capture({ genre: {} }, 5700);
  const recording = ReplayRecorder.stop();
  assert.equal(recording.frames[0].t, 0);
  assert.equal(recording.frames[1].t, 700);
});

test("recording includes the required metadata fields for drift detection", () => {
  ReplayRecorder.start("metadata_test");
  const recording = ReplayRecorder.stop();
  assert.equal(typeof recording.track, "string");
  assert.equal(typeof recording.recordedAt, "string");
  assert.equal(typeof recording.modelVersion, "string");
  assert.equal(typeof recording.preprocessingConfig, "object");
  assert.equal(recording.axisSchemaVersion, ReplayRecorder.SCHEMA_VERSION);
  assert.ok(Array.isArray(recording.frames));
});

test("captured frames are deep-cloned: mutating the live state afterward cannot corrupt an already-captured frame", () => {
  ReplayRecorder.start("clone_test");
  const liveState = { genre: { primary: "Techno" }, moodDimensions: { warmth: 0.5 } };
  ReplayRecorder.capture(liveState, 0);
  liveState.genre.primary = "Mutated After Capture";
  liveState.moodDimensions.warmth = 0.99;
  const recording = ReplayRecorder.stop();
  assert.equal(recording.frames[0].genre.primary, "Techno");
  assert.equal(recording.frames[0].moodDimensions.warmth, 0.5);
});

test("a missing/undefined field on the source state clones to null, never throws", () => {
  ReplayRecorder.start("missing_field_test");
  ReplayRecorder.capture({ genre: { primary: "Test" } }, 0);
  const recording = ReplayRecorder.stop();
  assert.equal(recording.frames[0].productionEvidence, null);
  assert.equal(recording.frames[0].instruments, null);
});
