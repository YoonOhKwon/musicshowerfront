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

test("very low beat confidence still refuses to claim sidechain even with a duck shape present", () => {
  const beats = beatsAt(9);
  const envelope = duckEnvelope(beats);
  const result = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.15 });
  assert.equal(result.sidechain, null);
});

// Regression coverage for a real gap this exact class of bug already had one fix for elsewhere in
// this file: analyze()'s own fields used to hard-null below beatConfidence 0.6 until a real Future
// Funk recording showed moderate confidence (0.3-0.6) still carries usable phase evidence (see the
// comment on that gate). detectSidechain() had the SAME 0.6 cutoff, unfixed, on the SAME underlying
// confidence signal -- so a real duck-then-recover shape was silently discarded whenever the beat
// grid was only moderately confident, which real replay recordings of this exact Future Funk track
// show is common (rhythmicGrammar.confidence sits in the 0.3-0.6 band for a large fraction of a real
// session, not just as a rare edge case).
test("moderate beat confidence (0.3-0.6, the band the analyze() fix already covers) now reports a dampened sidechain instead of null", () => {
  const beats = beatsAt(9);
  const envelope = duckEnvelope(beats);
  const confident = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.85 });
  const moderate = RhythmicGrammar.production({}, [], { envelope, beatTimestamps: beats, beatConfidence: 0.45 });
  assert.ok(moderate.sidechain !== null, "moderate confidence must no longer discard a real duck-shape detection");
  assert.ok(moderate.sidechain < confident.sidechain,
    "lower confidence must still report a WEAKER value than high confidence on the identical shape, not the same one");
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

test("moderate beat confidence still yields conservative beat-grid and kick occupancy evidence", () => {
  const bpm = 124, period = 60000 / bpm;
  const events = Array.from({ length: 20 }, (_, beat) => ({
    at: beat * period, strength: 0.78, lowImpact: 0.9, midImpact: beat % 2 ? 0.7 : 0.2, highImpact: 0.25
  }));
  const result = RhythmicGrammar.analyze(events, bpm, 0.47, events.at(-1).at + 1);
  assert.ok(result.beatGridConfidence > 0.6);
  assert.ok(result.kickOccupancy > 0.9);
  assert.ok(result.fourOnFloor > 0.7);
  assert.equal(result.kickPattern, "four-on-the-floor");
});

test("variable non-kick onsets cannot manufacture breakbeat over a regular four-floor kick grid", () => {
  const bpm = 120, period = 60000 / bpm;
  const events = [];
  for (let beat = 0; beat < 20; beat++) {
    const at = beat * period;
    events.push({ at, strength: 0.8, lowImpact: 0.9 });
    if (beat % 3 === 0) events.push({ at: at + period * 0.31, strength: 0.75, lowImpact: 0.1 });
    if (beat % 4 === 1) events.push({ at: at + period * 0.73, strength: 0.7, lowImpact: 0.05 });
  }
  const result = RhythmicGrammar.analyze(events, bpm, 0.9, events.at(-1).at + 1);
  assert.ok(result.fourOnFloor > 0.72);
  assert.ok(result.brokenBeat < 0.35);
  assert.equal(result.candidates.some(item => item.text === "브레이크비트"), false);
});

test("a long monotonic centroid trajectory produces graded filter-sweep evidence", () => {
  const frames = [900, 1080, 1290, 1530, 1790, 2080, 2400, 2750]
    .map((centroid, index) => ({ centroid, rms: 0.1, at: index * 500 }));
  const confidence = RhythmicGrammar.detectFilterSweep({ deltaRms: 0.01 }, frames);
  assert.ok(confidence > 0.7, `expected displayable filter-sweep evidence, got ${confidence}`);
  assert.ok(confidence <= RhythmicGrammar.detectorCapabilities["productionEvidence.filterSweep"].max);
});

test("centroid zig-zag and loudness jumps are not called filter sweeps", () => {
  const zigZag = [900, 1450, 980, 1520, 1000, 1580, 1040, 1600].map(centroid => ({ centroid }));
  assert.equal(RhythmicGrammar.detectFilterSweep({ deltaRms: 0.01 }, zigZag), null);
  const monotonic = [900, 1100, 1320, 1560, 1820, 2100, 2400, 2750].map(centroid => ({ centroid }));
  assert.equal(RhythmicGrammar.detectFilterSweep({ deltaRms: 0.08 }, monotonic), null);
});
