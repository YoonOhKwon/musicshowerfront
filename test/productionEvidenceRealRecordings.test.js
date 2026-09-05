const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Two real in-app recordings (js/debug/replayRecorder.js) of the same Future Funk track,
// 191/217 frames. Investigated because productionEvidence.filterSweep/sidechain/stereoWidth/
// reverb/distortion/vocalChop were null in every single frame while pumping/sampleBased were
// not -- this locks in the real cause found for each field so a future change can't silently
// reintroduce (or silently "fix" without anyone noticing) the same pattern.
const RECORDINGS = ["futurefunk1.json", "futurefunk2.json"].map(name =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/replays", name), "utf8")));

for (const recording of RECORDINGS) {
  test(`${recording.track}: stereoWidth/reverb/distortion stay null in every frame (hardcoded -- no detector attempts them)`, () => {
    for (const frame of recording.frames) {
      assert.equal(frame.productionEvidence.stereoWidth, null);
      assert.equal(frame.productionEvidence.reverb, null);
      assert.equal(frame.productionEvidence.distortion, null);
    }
  });

  test(`${recording.track}: pumping is a real number in every frame (unaffected by the beat-confidence gate that blocks sidechain)`, () => {
    for (const frame of recording.frames) {
      assert.equal(typeof frame.productionEvidence.pumping, "number");
    }
  });

  test(`${recording.track}: vocalChop is null in every frame BECAUSE this track has no detected voice instrument -- not a broken gate`, () => {
    for (const frame of recording.frames) {
      assert.equal(frame.productionEvidence.vocalChop, null);
      // The real cause: instrumentationEvidence never has a `voice` key at all in this
      // instrumental track, so context.voiceConfidence is always undefined, which fails
      // Number.isFinite() in rhythmicGrammar.js's vocalChop gate. If a future instrumentation
      // change ever DOES report `voice` here, vocalChop firing would be a real, checkable change
      // -- not the silent one this test currently guards against.
      assert.equal(frame.instrumentationEvidence.voice, undefined);
    }
  });

  test(`${recording.track}: sampleBased is non-null exactly on frames where repetition>=0.75 AND masterBrightness<=0.4 (the real gate, not just a similar rate)`, () => {
    for (const frame of recording.frames) {
      const repetition = frame.trackCharacter?.structure?.repetition;
      const masterBrightness = frame.trackCharacter?.production?.masterBrightness;
      const expectedNonNull = Number.isFinite(repetition) && Number.isFinite(masterBrightness) &&
        repetition >= 0.75 && masterBrightness <= 0.4;
      assert.equal(frame.productionEvidence.sampleBased !== null, expectedNonNull,
        `frame ${frame.t}: repetition=${repetition} masterBrightness=${masterBrightness} sampleBased=${frame.productionEvidence.sampleBased}`);
    }
  });

  test(`${recording.track}: rhythmicGrammar.confidence sits in the 0.3-0.6 band often enough that the sidechain fix (see rhythmicGrammar.test.js) actually matters on real data, not just synthetic edge cases`, () => {
    const confidences = recording.frames.map(f => f.rhythmicGrammar?.confidence).filter(Number.isFinite);
    const moderateBand = confidences.filter(c => c >= 0.3 && c < 0.6).length;
    assert.ok(moderateBand / confidences.length > 0.15,
      `expected a real (not negligible) share of frames in the 0.3-0.6 band, got ${moderateBand}/${confidences.length}`);
  });

  test(`${recording.track}: filterSweep is null in every frame; no monotonic centroid-sweep shape is found in this recording's captured windows either (approximation using per-tick centroid, since the detector's real frame-level trajectory buffer isn't part of the recording schema)`, () => {
    for (const frame of recording.frames) assert.equal(frame.productionEvidence.filterSweep, null);
    const centroids = recording.frames.map(f => f.expressionFeatures?.centroid).filter(Number.isFinite);
    // Mirrors detectFilterSweep()'s real gate (rhythmicGrammar.js) in full, not just its first two
    // conditions -- an earlier draft of this test checked only monotonicRatio/travel and found 6
    // false "passing" windows in futurefunk2 that meanStep/reversal correctly reject.
    let passingWindows = 0, totalWindows = 0;
    for (let index = 0; index + 8 <= centroids.length; index++) {
      totalWindows++;
      const window = centroids.slice(index, index + 8);
      const direction = Math.sign(window.at(-1) - window[0]);
      if (!direction) continue;
      const directed = window.slice(1).map((value, i) => (value - window[i]) * direction);
      const monotonicRatio = directed.filter(change => change > 45).length / directed.length;
      const travel = Math.abs(window.at(-1) - window[0]);
      const positive = directed.filter(value => value > 0);
      const meanStep = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 0;
      const negative = directed.filter(value => value < 0).map(Math.abs);
      const reversal = negative.length ? negative.reduce((a, b) => a + b, 0) / negative.length : 0;
      if (monotonicRatio >= 0.72 && travel >= 700 && meanStep >= 70 && reversal <= meanStep * 0.45) passingWindows++;
    }
    assert.equal(passingWindows, 0,
      "if this ever fails, a real monotonic sweep shape exists in the recording that filterSweep is nonetheless missing -- investigate the real internal frame buffer, not this approximation");
  });
}
