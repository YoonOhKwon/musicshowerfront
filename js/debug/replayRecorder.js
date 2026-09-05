// STEP 3: records the exact fields the axis engine / genreContextEngine / phrasePoolEngine /
// phraseSelection pipeline reads, at every semantic update, into a JSON file the replay harness
// (scripts/replay.cjs) can feed back through that same pipeline deterministically -- no audio is
// stored, and none is needed once a track is recorded. Wired into the debug panel (press D, then
// R to start/stop, downloads automatically on stop) rather than a separate UI, per the request.
const ReplayRecorder = (() => {
  // Bump whenever the FRAME shape below changes (a field added/removed/renamed) -- scripts/
  // replay.cjs warns instead of silently misreading an older recording against newer code.
  const SCHEMA_VERSION = 3;
  // Static identifiers, not runtime-introspected: the ML worker's model manifest lives in a
  // Worker thread and isn't reachable from this main-thread debug tool without new message-
  // passing plumbing (out of scope for a recording utility) -- update these two constants by hand
  // if models/music-shower/assets/discogs-effnet-bsdynamic-1.json or its preprocessing block ever
  // changes, matching scripts/model-smoke.mjs's own hardcoded copy of the same preprocessing config.
  const MODEL_VERSION = "discogs-effnet-bsdynamic-1";
  const PREPROCESSING_CONFIG = { frameSize: 512, hopSize: 256, patchFrames: 128, melBands: 96 };
  // Throttled well below the ~500ms semantic refresh cadence elsewhere in this app -- a 3-5 minute
  // recording at 2/s is still only a few thousand frames (a few MB of JSON), plenty of resolution
  // for the replay harness's per-song metrics without the file becoming unwieldy to commit/share.
  const CAPTURE_INTERVAL_MS = 500;

  let active = false;
  let track = "";
  let startedAt = 0;
  let lastCaptureAt = -Infinity;
  let frames = [];

  function isActive() { return active; }
  function frameCount() { return frames.length; }

  function start(trackName, atMs = performance.now()) {
    active = true;
    track = String(trackName || `recording_${Date.now()}`).trim() || `recording_${Date.now()}`;
    startedAt = atMs;
    lastCaptureAt = -Infinity;
    frames = [];
  }

  // Deep-cloned via JSON round-trip (these objects are already JSON-safe evidence, same as
  // js/semantic/semanticSnapshot.js's own serialization philosophy) so a later mutation of the
  // live semantic state can never retroactively corrupt an already-captured frame.
  function safeClone(value) {
    try { return value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { return null; }
  }

  function capture(state = {}, atMs = performance.now()) {
    if (!active) return;
    if (atMs - lastCaptureAt < CAPTURE_INTERVAL_MS) return;
    lastCaptureAt = atMs;
    frames.push({
      t: Math.round(atMs - startedAt),
      classifierGenre: safeClone(state.classifierGenre),
      genre: safeClone(state.genre),
      genreHypotheses: safeClone(state.genreHypotheses),
      moodDimensions: safeClone(state.moodDimensions),
      productionEvidence: safeClone(state.productionEvidence),
      rhythmicGrammar: safeClone(state.rhythmicGrammar),
      instruments: safeClone(state.instruments),
      instrumentation: safeClone(state.instrumentation),
      instrumentationEvidence: safeClone(state.instrumentationEvidence),
      instrumentEvents: safeClone(state.instrumentEvents),
      performance: safeClone(state.performance),
      arrangement: safeClone(state.arrangement),
      mir: safeClone(state.mir),
      trackCharacter: safeClone(state.trackCharacter),
      expressionFeatures: safeClone(state.expressionFeatures)
    });
  }

  // Returns the recording without clearing capture state -- stop() (below) is the one that ends
  // the session; this lets a caller inspect frame count/contents mid-recording if ever needed.
  function snapshot() {
    return { track, recordedAt: new Date().toISOString(), modelVersion: MODEL_VERSION,
      preprocessingConfig: PREPROCESSING_CONFIG, axisSchemaVersion: SCHEMA_VERSION, frames };
  }

  function stop() {
    const recording = snapshot();
    active = false;
    return recording;
  }

  // Browser-only: triggers a normal file-save-as download of the recording JSON. Not reachable
  // (and not needed) from Node -- scripts/replay.cjs reads the saved file straight off disk.
  function download(recording = snapshot(), filename = `${recording.track}.json`) {
    if (typeof document === "undefined" || typeof Blob === "undefined") return;
    const blob = new Blob([JSON.stringify(recording, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.endsWith(".json") ? filename : `${filename}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // MODEL_VERSION/PREPROCESSING_CONFIG exported so scripts/replay.cjs can compare a recording's
  // stamped values against the CURRENT constants without duplicating them a third place.
  return { start, stop, capture, snapshot, download, isActive, frameCount,
    SCHEMA_VERSION, MODEL_VERSION, PREPROCESSING_CONFIG };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ReplayRecorder;
