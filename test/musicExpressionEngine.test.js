const test = require("node:test");
const assert = require("node:assert/strict");
const Expressions = require("../js/semantic/musicExpressionEngine");

function state() {
  return {
    genre: { primary: "Jersey Club", confidence: 0.82, uncertain: false, fineCandidates: [{ label: "Juke", confidence: 0.52 }] },
    audio: { rms: 0.21, energy: 0.46 },
    novelty: { transitionDetected: true },
    mood: { fused: { arousal: 0.86, valence: 0.46, tension: 0.8, warmth: 0.22, spaciousness: 0.38 } },
    trackCharacter: {
      rhythm: { bpm: 142, pulseRegularity: 0.83, onsetDensity: 0.8, rhythmicComplexity: 0.72, breakbeatLikelihood: 0.73 },
      harmony: { tonalness: 0.6, harmonicMotion: 0.74, chromaEntropy: 0.4 },
      timbre: { brightness: 0.76, warmth: 0.22, roughness: 0.74, noisiness: 0.42, transientSharpness: 0.82 },
      texture: { density: 0.79, sustainedness: 0.25, granularness: 0.7 },
      dynamics: { dynamicRange: 0.22, compressionDensity: 0.84, pumping: 0.75, crestFactor: 0.72, dropIntensity: 0.66 },
      production: { subWeight: 0.74 },
      structure: { sectionNovelty: 0.8, buildupLikelihood: 0.72, breakdownLikelihood: 0.2, repetition: 0.7 }
    }
  };
}

test("stable expression exposes genre, FACT traits and mood without inventing LIVE change", () => {
  const words = Expressions.generate(state());
  const categories = new Set(words.map(item => item.category));
  assert.deepEqual([...categories].sort(), ["dynamics", "genre", "mood", "rhythm"]);
  assert.equal(words.filter(item => item.layer === "LIVE").length, 0);
  assert.ok(words.filter(item => ["dynamics", "rhythm"].includes(item.category)).every(item => item.layer === "FACT"));
  assert.ok(words.some(item => item.text === "Jersey Club"));
  assert.ok(words.some(item => item.text.includes("브레이크") || item.text.includes("펄스")));
  assert.ok(words.some(item => item.text === "높은 음압"));
  assert.ok(words.some(item => item.text.includes("긴장")));
});
