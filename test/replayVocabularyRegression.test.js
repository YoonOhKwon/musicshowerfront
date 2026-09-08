const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Replay = require("../scripts/replay.cjs");

const replayDir = path.join(__dirname, "fixtures/replays");
const replayNames = ["futurefunk1.json", "futurefunk2.json", "jazz_01.json"];
const missingReplays = replayNames.filter(name => !fs.existsSync(path.join(replayDir, name)));

function recording(name) {
  return JSON.parse(fs.readFileSync(path.join(replayDir, name), "utf8"));
}

if (missingReplays.length) {
  test("historical replay vocabulary captures are absent and are not architecture regression targets", {
    skip: `missing ${missingReplays.join(", ")}`
  }, () => {});
} else {
  const futurefunk1 = recording("futurefunk1.json");
  const futurefunk2 = recording("futurefunk2.json");
  const jazz01 = recording("jazz_01.json");
  const runFf1 = Replay.replayTrack(futurefunk1);
  const runFf2 = Replay.replayTrack(futurefunk2);
  const runJazz = Replay.replayTrack(jazz01);

  test("a jazz trio recording with no synth/sampler/computer evidence never speaks sample-based vocabulary", () => {
    const sampleBasedTerms = runJazz.selected.filter(item => /샘플/.test(item.text));
    assert.deepEqual(sampleBasedTerms.map(item => item.text), []);
  });

  test("the same jazz recording DOES still speak sample-based vocabulary if the electronic-instrument evidence is fabricated (proves this is a real gate, not a genre-name blocklist)", () => {
    const fabricated = { ...jazz01, frames: jazz01.frames.map(frame => ({
      ...frame, instrumentationEvidence: { ...frame.instrumentationEvidence, sampler: 0.5 } })) };
    const run = Replay.replayTrack(fabricated);
    const sampleBasedTerms = run.selected.filter(item => /샘플/.test(item.text));
    assert.ok(sampleBasedTerms.length > 0,
      "with real electronic-instrument evidence injected, sample-based vocabulary must be reachable again");
  });

  test("local replay selection contains no developer-authored subjective or genre-prior sources", () => {
    const forbidden = new Set(["aesthetic-axis", "aesthetic-induction", "local-grammar",
      "impression-synthesis", "evidence-gated-prior", "genre-relation"]);
    for (const run of [runFf1, runFf2, runJazz]) {
      assert.deepEqual(run.selected.filter(item => forbidden.has(item.source)).map(item => item.text), [], run.track);
      assert.equal(run.selected.some(item => ["AESTHETIC", "IMPRESSION"].includes(item.layer)), false, run.track);
    }
  });

  test("no single-axis aestheticRegions.json entry survives selection any more (all 3 real recordings)", () => {
    for (const run of [runFf1, runFf2, runJazz]) {
      const singleAxis = run.selected.filter(item => item.source === "aesthetic-axis" &&
        Array.isArray(item.axes) && item.axes.length === 1);
      assert.deepEqual(singleAxis.map(item => item.text), [], `${run.track}: expected zero 1-axis aesthetic-region matches`);
    }
  });
}
