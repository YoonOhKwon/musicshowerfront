const test = require("node:test");
const assert = require("node:assert/strict");
const BackgroundAudioMapping = require("../js/visual/backgroundAudioMapper");
const BackgroundPerformance = require("../js/visual/backgroundGovernor");

test("bass drives macro deformation while highs drive micro shimmer", () => {
  const quiet = BackgroundAudioMapping.target({ bass: 0.1, high: 0.1 });
  const bass = BackgroundAudioMapping.target({ bass: 0.9, high: 0.1 });
  const high = BackgroundAudioMapping.target({ bass: 0.1, high: 0.9 });
  assert.ok(bass.deformation > quiet.deformation + 0.4);
  assert.ok(high.shimmer > quiet.shimmer + 0.4);
});

test("novelty increases procedural turbulence", () => {
  const stable = BackgroundAudioMapping.target({ state: { novelty: { score: 0.05 } } });
  const changed = BackgroundAudioMapping.target({ state: { novelty: { score: 0.9 } } });
  assert.ok(changed.turbulence > stable.turbulence + 0.4);
});

test("tracks in the same family retain different motion from Track Character", () => {
  const steady = BackgroundAudioMapping.target({ state: {
    genre: { family: "Electronic / Club" },
    trackCharacter: { rhythm: { rhythmicComplexity: 0.1, breakbeatLikelihood: 0.05 }, timbre: { roughness: 0.1 }, texture: { granularness: 0.1 } }
  } });
  const broken = BackgroundAudioMapping.target({ state: {
    genre: { family: "Electronic / Club" },
    trackCharacter: { rhythm: { rhythmicComplexity: 0.9, breakbeatLikelihood: 0.9 }, timbre: { roughness: 0.8 }, texture: { granularness: 0.8 } }
  } });
  assert.ok(broken.turbulence > steady.turbulence + 0.12);
  assert.ok(broken.regularity < steady.regularity);
  assert.ok(broken.shimmer > steady.shimmer);
});

test("background governor degrades only after sustained pressure", () => {
  const governor = new BackgroundPerformance.Governor("high");
  for (let index = 0; index < 89; index++) governor.observe({ fps: 30 });
  assert.equal(governor.profile().level, "high");
  governor.observe({ fps: 30 });
  assert.equal(governor.profile().level, "medium");
  assert.ok(governor.profile().languageMultiplier > governor.profile().mlMultiplier);
  assert.equal(governor.profile().zeroShotAllowed, false);
});
