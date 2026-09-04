const test = require("node:test");
const assert = require("node:assert/strict");
const SemanticFusion = require("../js/ml/semanticFusion");

test("local mood responds without waiting for ML", () => {
  const local = { valence: 0.7, arousal: 0.9, tension: 0.2, warmth: 0.8, brightness: 0.7, spaciousness: 0.6 };
  assert.deepEqual(SemanticFusion.fuseMood(local, {}, false), local);
});

test("ML modifies mood but fast local dimensions remain dominant", () => {
  const fused = SemanticFusion.fuseMood(
    { valence: 0.6, arousal: 1, tension: 0.1, warmth: 0.7, brightness: 0.9, spaciousness: 0.5 },
    { valence: 0.2, arousal: 0, tension: 1, warmth: 0.1, brightness: 0, spaciousness: 1 },
    true
  );
  assert.ok(fused.arousal > 0.7);
  assert.ok(fused.brightness > 0.65);
  assert.ok(fused.spaciousness > 0.6);
});
