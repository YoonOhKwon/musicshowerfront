const test = require("node:test");
const assert = require("node:assert/strict");
const ConfidenceCalibration = require("../js/ml/confidenceCalibrator");

const familyFor = label => ({ House: "Electronic", Techno: "Electronic", Jazz: "Jazz", Metal: "Rock" })[label] || "Unknown";

test("temporal persistence never inflates semantic confidence", () => {
  const predictions = [
    { label: "House", confidence: 0.09 },
    { label: "Techno", confidence: 0.055 },
    { label: "Jazz", confidence: 0.02 }
  ];
  const weak = ConfidenceCalibration.calibrate({ predictions, stability: 0.1, temporalAgreement: 0.1, familyFor });
  const strong = ConfidenceCalibration.calibrate({ predictions, stability: 0.9, temporalAgreement: 0.95, familyFor });
  assert.equal(strong.rawConfidence, 0.09);
  assert.equal(strong.confidence, weak.confidence);
  assert.equal(strong.semanticConfidence, weak.semanticConfidence);
  assert.ok(strong.temporalStability > weak.temporalStability);
});

test("close cross-family candidates are marked hybrid", () => {
  const result = ConfidenceCalibration.calibrate({
    predictions: [{ label: "Jazz", confidence: 0.08 }, { label: "Metal", confidence: 0.07 }],
    stability: 0.7,
    temporalAgreement: 0.8,
    familyFor
  });
  assert.equal(result.hybrid, true);
  assert.equal(result.certainty, "hybrid");
});

test("raw score, margin and entropy stay inspectable beside heuristic semantic confidence", () => {
  const result = ConfidenceCalibration.calibrate({
    predictions: [
      { label: "House", confidence: 0.09 },
      { label: "Techno", confidence: 0.055 },
      { label: "Jazz", confidence: 0.02 }
    ],
    familyFor
  });
  assert.equal(result.rawTopScore, 0.09);
  assert.equal(result.runnerUpScore, 0.055);
  assert.ok(result.margin > 0);
  assert.ok(result.normalizedMargin > 0);
  assert.ok(result.entropy > 0);
  assert.equal(result.reliability, result.semanticConfidence);
  assert.equal(result.displayConfidence, result.semanticConfidence);
  assert.ok(result.semanticConfidence > result.rawTopScore,
    "the heuristic may be larger than the raw head score, so it must not replace raw diagnostics");
});
