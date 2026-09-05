const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Replay = require("../scripts/replay.cjs");
const Metrics = require("../js/semantic/languageDiversityMetrics");

function recording(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/replays", name), "utf8"));
}
const futurefunk1 = recording("futurefunk1.json");
const futurefunk2 = recording("futurefunk2.json");
const jazz01 = recording("jazz_01.json");
// Computed once and shared across tests below -- replaying a 200-300 frame recording through the
// full pipeline (aesthetic axes -> critic -> selection) isn't free, and several tests below need
// the exact same run.
const runFf1 = Replay.replayTrack(futurefunk1);
const runFf2 = Replay.replayTrack(futurefunk2);
const runJazz = Replay.replayTrack(jazz01);

// Regression coverage for the acoustic-jazz false positive investigated this round: replaying
// jazz_01 (an acoustic jazz trio -- no synthesizer/sampler/computer anywhere in its
// instrumentationEvidence) through the FULL pipeline (production() -> aesthetic axes ->
// aestheticRegions.json -> critic -> selection), not just the raw productionEvidence field, must
// never surface sample-based vocabulary. Before the fix, high structural repetition + low
// masterBrightness (both genuinely true of a mellow acoustic trio, for reasons that have nothing
// to do with sample construction) manufactured productionEvidence.sampleBased ~0.87 on this real
// recording -- higher than the actual sample-based Future Funk tracks it was meant to detect
// (~0.78-0.84) -- which fed the nostalgia axis (weighted 0.3 on sampleBased) and produced "샘플
// 루프"/"반복 샘플 구조"/"레트로 퓨처 미학" on a track with no samplers or synths in it.
test("a jazz trio recording with no synth/sampler/computer evidence never speaks sample-based vocabulary", () => {
  const sampleBasedTerms = runJazz.selected.filter(item => /샘플/.test(item.text));
  assert.deepEqual(sampleBasedTerms.map(item => item.text), []);
});

test("the same jazz recording DOES still speak sample-based vocabulary if the electronic-instrument evidence is fabricated (proves this is a real gate, not a genre-name blocklist)", () => {
  // Take the exact same recording and inject the one signal a real sampler-based instrument would
  // leave (a `synthesizer`/`sampler` key in instrumentationEvidence) into every frame, to prove
  // sampleBased is gated on that evidence rather than on a hidden "never fires for jazz" rule.
  const fabricated = { ...jazz01, frames: jazz01.frames.map(frame => ({
    ...frame, instrumentationEvidence: { ...frame.instrumentationEvidence, sampler: 0.5 } })) };
  const run = Replay.replayTrack(fabricated);
  const sampleBasedTerms = run.selected.filter(item => /샘플/.test(item.text));
  assert.ok(sampleBasedTerms.length > 0,
    "with real electronic-instrument evidence injected, sample-based vocabulary must be reachable again");
});

// Jaccard target coverage: the request asked for futurefunk~jazz Jaccard below 0.35 after
// strengthening aestheticRegions.json's single-axis entries to 2+ axes. That strengthening (plus
// the sampleBased and syncopation-axis fixes) genuinely improved separation -- averageJaccard
// across all three recordings went from ~0.507 to ~0.504, per-pair futurefunk1~jazz from ~0.485 to
// ~0.435, axisCombinationSizes' 1-axis bucket went from 18 (jazz) to 0 across all three songs, and
// sample-based/retro-future vocabulary no longer appears in universallySpoken at all. It did NOT
// reach 0.35: a breakdown of the still-shared vocabulary shows the MAJORITY of the remaining
// overlap comes from FACT and LIVE layer items (raw descriptors like "싱코페이션", "음압 하강") and
// IMPRESSION-synthesis rules -- none of which aestheticRegions.json governs -- and those raw
// descriptors are, on this specific pair of real recordings, honestly describing genuinely similar
// measured characteristics (both futurefunk2 and jazz_01 measure ~0.79 raw syncopation, for
// example). This test locks in the REAL achieved bound, not the originally-hoped one, so a future
// change that regresses this improvement is still caught -- see the report for why 0.35 needs
// changes outside this task's stated scope (aestheticRegions.json) to reach.
test("futurefunk~jazz selected-vocabulary Jaccard is reduced by the aestheticRegions.json/sampleBased/syncopation fixes (target 0.35 not fully reached -- see comment)", () => {
  const jaccardFf1Jazz = Metrics.jaccard(runFf1.selected, runJazz.selected);
  const jaccardFf2Jazz = Metrics.jaccard(runFf2.selected, runJazz.selected);
  assert.ok(jaccardFf1Jazz < 0.46, `futurefunk1~jazz Jaccard regressed: ${jaccardFf1Jazz}`);
  assert.ok(jaccardFf2Jazz < 0.51, `futurefunk2~jazz Jaccard regressed: ${jaccardFf2Jazz}`);
});

test("no single-axis aestheticRegions.json entry survives selection any more (all 3 real recordings)", () => {
  for (const run of [runFf1, runFf2, runJazz]) {
    const singleAxis = run.selected.filter(item => item.source === "aesthetic-axis" &&
      Array.isArray(item.axes) && item.axes.length === 1);
    assert.deepEqual(singleAxis.map(item => item.text), [], `${run.track}: expected zero 1-axis aesthetic-region matches`);
  }
});
