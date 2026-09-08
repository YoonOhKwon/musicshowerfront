const test = require("node:test");
const assert = require("node:assert/strict");
const Axis = require("../js/semantic/evidenceAxis");
const TemporalEvidence = require("../js/semantic/temporalEvidenceEngine");

test("Case A: pulse syncopation and bass kick interaction are two independent axes", () => {
  const axes = Axis.independentAxes([
    "primitives.pulse.syncopation",
    "primitives.bass.kickInteraction"
  ]);
  assert.equal(axes.length, 2);
  assert.ok(axes.includes("pulse"));
  assert.ok(axes.includes("bass"));
});

test("Case B: two pulse-family derivatives do not count as two independent axes", () => {
  const axes = Axis.independentAxes([
    "primitives.pulse.syncopation",
    "primitives.pulse.offbeatStrength"
  ]);
  assert.equal(axes.length, 1);
  assert.equal(axes[0], "pulse");
});

test("Case C: melody, harmony and vocal presence are three independent axes", () => {
  const axes = Axis.independentAxes([
    "primitives.melody.contour",
    "primitives.harmony.chordChangeRate",
    "instrumentation.vocal.presence"
  ]);
  assert.equal(axes.length, 3);
  assert.ok(axes.includes("melody"));
  assert.ok(axes.includes("harmony"));
  assert.ok(axes.includes("instrumentation.vocal"));
});

test("first-segment slicing is not used: both primitives.* paths stay distinct", () => {
  assert.equal(Axis.resolveEvidenceAxis("primitives.pulse.syncopation"), "pulse");
  assert.equal(Axis.resolveEvidenceAxis("primitives.bass.kickInteraction"), "bass");
  assert.notEqual(
    Axis.resolveEvidenceAxis("primitives.pulse.syncopation"),
    Axis.resolveEvidenceAxis("primitives.bass.kickInteraction")
  );
});

test("production evidence resolves to production sub-axes, not the productionEvidence token", () => {
  assert.equal(Axis.resolveEvidenceAxis("productionEvidence.sidechain"), "production.dynamics");
  assert.equal(Axis.resolveEvidenceAxis("productionEvidence.filterSweep"), "production.filter");
  assert.equal(Axis.resolveEvidenceAxis("productionEvidence.sampleBased"), "production.sampling");
});

test("multi-axis evidence is required for early Track Trait promotion", () => {
  const single = {
    text: "오프비트 강세", category: "rhythm", confidence: 0.7, source: "rhythm",
    anchors: ["primitives.pulse.syncopation"]
  };
  const multi = {
    text: "킥-베이스 밀착", category: "performance", confidence: 0.7, source: "instrument",
    anchors: ["primitives.pulse.syncopation", "primitives.bass.bassKickInteraction"]
  };
  const singleEngine = new TemporalEvidence.Engine({ traitMinimumMs: 1000 });
  const multiEngine = new TemporalEvidence.Engine({ traitMinimumMs: 1000 });
  let singleResult, multiResult;
  for (const at of [0, 500, 1000]) {
    singleResult = singleEngine.update([single], at);
    multiResult = multiEngine.update([multi], at);
  }
  assert.equal(singleResult.trackTraits.some(item => item.text === "오프비트 강세"), false,
    "one pulse axis must not promote at 3 observations / 0.70 confidence");
  const promoted = multiResult.trackTraits.find(item => item.text === "킥-베이스 밀착");
  assert.ok(promoted, "pulse + bass axes should promote");
  assert.equal(promoted.promotionReason, "multi-axis");
});
