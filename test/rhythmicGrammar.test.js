const test = require("node:test");
const assert = require("node:assert/strict");
const RhythmicGrammar = require("../js/semantic/rhythmicGrammar");

const PERIOD = 500; // 120 BPM
const STEP = 16;     // ~60fps sampling

function beatsAt(count, period = PERIOD, start = 0) {
  return Array.from({ length: count }, (_, i) => start + i * period);
}

// Builds a beat-relative energy envelope that ducks sharply after each beat and recovers by the next.
function duckEnvelope(beats, period = PERIOD, { peak = 1, trough = 0.15, duckFraction = 0.28 } = {}) {
  const samples = [];
  for (let index = 0; index + 1 < beats.length; index++) {
    const start = beats[index];
    for (let t = 0; t < period; t += STEP) {
      const phase = t / period;
      let value;
      if (phase < duckFraction) {
        value = peak - (peak - trough) * (phase / duckFraction);
      } else {
        value = trough + (peak - trough) * ((phase - duckFraction) / (1 - duckFraction));
      }
      samples.push({ at: start + t, value });
    }
  }
  return samples;
}

// A flat envelope with only small random jitter: no consistent beat-relative shape.
function steadyEnvelope(beats, period = PERIOD, level = 0.6) {
  const samples = [];
  for (let index = 0; index + 1 < beats.length; index++) {
    const start = beats[index];
    for (let t = 0; t < period; t += STEP) samples.push({ at: start + t, value: level + (Math.sin(t) * 0.01) });
  }
  return samples;
}

test("a duck-then-recover energy shape aligned to the beat grid is detected as sidechain", () => {
  const beats = beatsAt(9);
  const envelope = duckEnvelope(beats);
  const result = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.85 });
  assert.ok(result.sidechain !== null, "expected a sidechain confidence, not null");
  assert.ok(result.sidechain > 0.4, `expected a reasonably strong sidechain signal, got ${result.sidechain}`);
});

test("a flat energy envelope is not mistaken for sidechain", () => {
  const beats = beatsAt(9);
  const envelope = steadyEnvelope(beats);
  const result = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.85 });
  assert.equal(result.sidechain, null);
});

test("low beat confidence refuses to claim sidechain even with a duck shape present", () => {
  const beats = beatsAt(9);
  const envelope = duckEnvelope(beats);
  const result = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.3 });
  assert.equal(result.sidechain, null);
});

test("too few beat windows refuses to claim sidechain", () => {
  const beats = beatsAt(4);
  const envelope = duckEnvelope(beats);
  const result = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.9 });
  assert.equal(result.sidechain, null);
});

test("sample-based production needs both high repetition and a capped brightness", () => {
  const both = RhythmicGrammar.production({}, [], { repetition: 0.85, masterBrightness: 0.25 });
  assert.ok(both.sampleBased !== null && both.sampleBased > 0);
  const onlyRepetition = RhythmicGrammar.production({}, [], { repetition: 0.9, masterBrightness: 0.8 });
  assert.equal(onlyRepetition.sampleBased, null);
  const onlyBrightness = RhythmicGrammar.production({}, [], { repetition: 0.3, masterBrightness: 0.2 });
  assert.equal(onlyBrightness.sampleBased, null);
});

test("vocal chop needs strong voice presence and an unusually high onset rate", () => {
  const both = RhythmicGrammar.production({}, [], { voiceConfidence: 0.8, onsetRate: 4 });
  assert.ok(both.vocalChop !== null && both.vocalChop > 0);
  const sustainedVocal = RhythmicGrammar.production({}, [], { voiceConfidence: 0.8, onsetRate: 1.2 });
  assert.equal(sustainedVocal.vocalChop, null);
  const noVoice = RhythmicGrammar.production({}, [], { voiceConfidence: 0.1, onsetRate: 4 });
  assert.equal(noVoice.vocalChop, null);
});

// Kicks land every OTHER beat (half the tempo's own period) while dense onsets fill every beat --
// the half-time perceptual layer the spec describes (BPM fast, kick pulse slower), computed from
// actual onset spacing, never from a genre label.
test("a kick pulse landing every other beat is read as half-time from real onset spacing", () => {
  const bpm = 170, period = 60000 / bpm;
  const events = [];
  for (let beat = 0; beat < 24; beat++) {
    const at = beat * period;
    events.push({ at, strength: 0.5, lowImpact: beat % 2 === 0 ? 0.9 : 0.2 });
    events.push({ at: at + period / 2, strength: 0.55, lowImpact: 0.15 });
  }
  const result = RhythmicGrammar.analyze(events, bpm, 0.9, events.at(-1).at + 10);
  assert.ok(result.halfTimeLikelihood > 0.4, `expected a real half-time signal, got ${result.halfTimeLikelihood}`);
  assert.ok(result.doubleTimeLikelihood < result.halfTimeLikelihood);
});

// Kicks land twice as often as the beat -- the double-time layer the spec's second example
// describes (dense subdivision felt faster than the tempo grid).
test("a kick pulse landing twice per beat is read as double-time from real onset spacing", () => {
  const bpm = 85, period = 60000 / bpm;
  const events = [];
  for (let beat = 0; beat < 30; beat++) {
    const at = beat * period;
    events.push({ at, strength: 0.6, lowImpact: 0.85 });
    events.push({ at: at + period / 2, strength: 0.6, lowImpact: 0.85 });
  }
  const result = RhythmicGrammar.analyze(events, bpm, 0.9, events.at(-1).at + 10);
  assert.ok(result.doubleTimeLikelihood > 0.4, `expected a real double-time signal, got ${result.doubleTimeLikelihood}`);
});

test("onsets that consistently land after the grid read as laid-back, not ahead", () => {
  const bpm = 120, period = 60000 / bpm;
  const events = [];
  for (let beat = 0; beat < 20; beat++) {
    const at = beat * period;
    // A low-impact anchor exactly ON the grid establishes the reference beat; the strong
    // (snare-like) onset lands consistently 8% of a beat LATE relative to that same grid.
    events.push({ at, strength: 0.5, lowImpact: 0.9 });
    events.push({ at: at + period * 0.08, strength: 0.7, lowImpact: 0.1 });
  }
  const result = RhythmicGrammar.analyze(events, bpm, 0.9, events.at(-1).at + 10);
  assert.ok(result.groovePushPull > 0.15, `expected a positive (laid-back) push-pull, got ${result.groovePushPull}`);
});

test("missing context leaves the advanced production fields honestly null", () => {
  const result = RhythmicGrammar.production({}, []);
  assert.equal(result.sidechain, null);
  assert.equal(result.sampleBased, null);
  assert.equal(result.vocalChop, null);
  assert.equal(result.stereoWidth, null);
});
