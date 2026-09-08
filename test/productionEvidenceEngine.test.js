const test = require("node:test");
const assert = require("node:assert/strict");
const Production = require("../js/semantic/productionEvidenceEngine");
const Grammar = require("../js/semantic/rhythmicGrammar");

test("capability: stereo width is unavailable on mono input and never invented", () => {
  const report = Production.stereoWidth({ stereo: { available: false, reason: "mono_input", channels: 1 } });
  assert.equal(report.available, false);
  assert.equal(report.reason, "mono_input");
  assert.equal(report.value, null);
  const runtime = Grammar.production({ rms: 0.2, peak: 0.3, flatness: 0.2, crestFactorDb: 12 }, [], {});
  assert.equal(runtime.stereoWidth, null);
  assert.equal(runtime.reports.stereoWidth.reason, "mono_input");
});

test("capability: stereo width uses L/R correlation when a stereo analysis window exists", () => {
  const report = Production.stereoWidth({
    stereo: { available: true, channels: 2, correlation: 0.15, sideRatio: 0.55, stability: 0.7 }
  });
  assert.equal(report.available, true);
  assert.ok(report.value > 0.4);
  assert.ok(report.confidence >= Production.FACT_CONFIDENCE);
});

test("capability: reverb needs a decay window and stays null when confidence is low", () => {
  const empty = Production.reverb({}, []);
  assert.equal(empty.available, false);
  const frames = Array.from({ length: 12 }, (_, index) => ({
    rms: index % 4 === 0 ? 0.2 : 0.16, flux: 0.04
  }));
  const wet = Production.reverb({ transientDensity: 0.2, sustainedness: 0.8 }, frames);
  assert.equal(wet.available, true);
  if (wet.confidence < Production.FACT_CONFIDENCE) assert.equal(wet.value, null);
});

test("capability: bright clean audio is not reported as distortion", () => {
  const bright = Production.distortion({
    crestFactorDb: 14, flatness: 0.08, peak: 0.4, rms: 0.08, centroid: 7200, brightness: 0.9
  });
  assert.equal(bright.available, true);
  assert.equal(bright.value, null);
  assert.ok(bright.confidence < Production.FACT_CONFIDENCE);
});

test("capability: clipped low-crest audio can become distortion FACT", () => {
  const harsh = Production.distortion({
    crestFactorDb: 2.2, flatness: 0.55, peak: 0.99, rms: 0.45, brightness: 0.4
  });
  assert.equal(harsh.available, true);
  assert.ok(harsh.value > 0.4);
  assert.ok(harsh.confidence >= Production.FACT_CONFIDENCE);
});

test("integration: production() still leaves stereo/reverb/distortion null without those windows", () => {
  const result = Grammar.production({ rms: 0.05, peak: 0.08, flatness: 0.1, crestFactorDb: 11, pumping: 0.2 }, [], {
    envelope: [], beatTimestamps: [], beatConfidence: 0.2
  });
  assert.equal(result.stereoWidth, null);
  assert.equal(result.reverb, null);
  assert.equal(result.distortion, null);
  assert.equal(result.reports.stereoWidth.available, false);
  assert.notEqual(result.reports.reverb.available, undefined);
  assert.notEqual(result.reports.distortion.available, undefined);
});
