const test = require("node:test");
const assert = require("node:assert/strict");
const ConfidenceCalibration = require("../js/ml/confidenceCalibrator");

const familyFor = label => ({ House: "Electronic", Techno: "Electronic", Jazz: "Jazz", Metal: "Rock" })[label] || "Unknown";

test("calibration rewards temporal and family agreement without changing raw score", () => {
  const predictions = [
    { label: "House", confidence: 0.09 },
    { label: "Techno", confidence: 0.055 },
    { label: "Jazz", confidence: 0.02 }
  ];
  const weak = ConfidenceCalibration.calibrate({ predictions, stability: 0.1, temporalAgreement: 0.1, familyFor });
  const strong = ConfidenceCalibration.calibrate({ predictions, stability: 0.9, temporalAgreement: 0.95, familyFor });
  assert.equal(strong.rawConfidence, 0.09);
  assert.ok(strong.confidence > weak.confidence + 0.25);
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
