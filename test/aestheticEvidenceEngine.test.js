const test = require("node:test");
const assert = require("node:assert/strict");
const AestheticEvidence = require("../js/semantic/aestheticEvidenceEngine");
const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const aestheticAxes = require("../data/aestheticAxes.json");
const aestheticRegions = require("../data/aestheticRegions.json");

// Real data, not a hand-rolled stub -- these are the exact axis weights/regions production and
// the language-reform fixtures load, so a passing test here is a real guarantee, not an artifact
// of a convenient fake.
const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);

function futureFunkState(overrides = {}) {
  return {
    genre: { primary: "Future Funk", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    moodDimensions: { brightness: 0.72, valence: 0.68 },
    productionEvidence: { sampleBased: 0.7 },
    instrumentationEvidence: { strings: 0.5 },
    ...overrides
  };
}

test("kawaii is a continuous blend of the glossiness/artificiality axes, not a fixed-bar pass/fail", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  const brighter = engine.evaluate(futureFunkState({ moodDimensions: { brightness: 0.85, valence: 0.75 },
    productionEvidence: { sampleBased: 0.85 } }));
  const dimmer = engine.evaluate(futureFunkState({ moodDimensions: { brightness: 0.6, valence: 0.55 },
    productionEvidence: { sampleBased: 0.55 } }));
  assert.ok(brighter.kawaii !== null && dimmer.kawaii !== null, "both should clear the bar with genre + real signal present");
  assert.ok(brighter.kawaii > dimmer.kawaii, "a stronger measured signal must produce a stronger score, not an identical one");
});

test("kawaii stays null (not 0) when genre is known but no real acoustic signal backs the axis at all", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  // Genre alone is never grounding -- a confidently-known genre with a completely empty
  // evidence object must not let the genre-prior component alone manufacture a score.
  const result = engine.evaluate(futureFunkState({ moodDimensions: {}, productionEvidence: {}, instrumentationEvidence: {} }));
  assert.equal(result.kawaii, null);
  assert.equal(result.magicalGirl, null);
  assert.equal(result.anime, null);
});

test("kawaii stays null when the genre lineage does not match any aesthetic axis prior", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  const result = engine.evaluate(futureFunkState({ genre: { primary: "Death Metal", family: "Rock / Metal", confidence: 0.9, uncertain: false } }));
  assert.equal(result.kawaii, null);
});

test("magical girl requires kawaii plus strings plus very high brightness", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  const strong = engine.evaluate(futureFunkState({ moodDimensions: { brightness: 0.8, valence: 0.7 }, instrumentationEvidence: { strings: 0.6 } }));
  assert.ok(strong.magicalGirl !== null && strong.magicalGirl > 0);
  const noStrings = engine.evaluate(futureFunkState({ instrumentationEvidence: { strings: 0.05 } }));
  assert.equal(noStrings.magicalGirl, null);
});

test("anime derives from a strong kawaii or magical-girl signal, not a separate guess", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  const strong = engine.evaluate(futureFunkState({ moodDimensions: { brightness: 0.85, valence: 0.75 }, productionEvidence: { sampleBased: 0.85 } }));
  assert.ok(strong.anime !== null);
  const weak = engine.evaluate(futureFunkState({ moodDimensions: { brightness: 0.56, valence: 0.56 }, productionEvidence: { sampleBased: 0.5 } }));
  assert.equal(weak.anime, null);
});

test("y2k needs UK garage-adjacent lineage plus real motion evidence", () => {
  // STEP 2: UK Garage's genre-prior lives on the syncopation axis (2-step swing/displacement),
  // not drive -- so the real signal that must accompany the genre match is rhythmicGrammar's
  // syncopation/brokenBeat/swing, not production sidechain (which is drive's signal and carries
  // no UK Garage prior at all).
  const engine = new AestheticEvidence.Engine(axisEngine);
  const state = {
    genre: { primary: "UK Garage", family: "Electronic / Club", confidence: 0.8, uncertain: false },
    moodDimensions: { brightness: 0.6, valence: 0.5 },
    rhythmicGrammar: { syncopation: 0.6, brokenBeat: 0.5, swing: 0.4 },
    instrumentationEvidence: {}
  };
  const result = engine.evaluate(state);
  assert.ok(result.y2k !== null && result.y2k > 0);
  const noRhythmEvidence = engine.evaluate({ ...state, rhythmicGrammar: {} });
  assert.equal(noRhythmEvidence.y2k, null, "genre alone (no rhythm evidence) must not carry motion");
});

test("uncertain or low-confidence genre disables all aesthetic evidence", () => {
  const engine = new AestheticEvidence.Engine(axisEngine);
  const uncertain = engine.evaluate(futureFunkState({ genre: { primary: "Future Funk", confidence: 0.85, uncertain: true } }));
  assert.deepEqual(uncertain, { kawaii: null, magicalGirl: null, anime: null, y2k: null });
  const lowConfidence = engine.evaluate(futureFunkState({ genre: { primary: "Future Funk", family: "Pop / Internet", confidence: 0.3, uncertain: false } }));
  assert.deepEqual(lowConfidence, { kawaii: null, magicalGirl: null, anime: null, y2k: null });
});

test("without an axis engine wired in, evidence stays honestly null instead of falling back to old hardcoded thresholds", () => {
  const engine = new AestheticEvidence.Engine();
  assert.deepEqual(engine.evaluate(futureFunkState()), { kawaii: null, magicalGirl: null, anime: null, y2k: null });
});
