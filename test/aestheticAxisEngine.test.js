const test = require("node:test");
const assert = require("node:assert/strict");
const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const GenreContext = require("../js/semantic/genreContextEngine");
const Grammar = require("../js/semantic/rhythmicGrammar");
const aestheticAxes = require("../data/aestheticAxes.json");
const aestheticRegions = require("../data/aestheticRegions.json");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");

test("a missing component is excluded from the weighted average, never averaged in as 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [
      { path: "moodDimensions.warmth", weight: 0.5 },
      { path: "moodDimensions.valence", weight: 0.2 },
      { path: "moodDimensions.aggression", weight: 0.3, invert: true }
    ] } }
  }, { entries: [] });
  // Only warmth is present; valence/aggression are genuinely unmeasured. If they were silently
  // treated as 0 the result would be dragged down to well below 0.9 -- it must not be.
  const { axes } = engine.evaluateAxes({ moodDimensions: { warmth: 0.9 } }, {});
  assert.equal(axes.warmth, 0.9);
});

test("an axis with zero resolvable components stays null, never becomes 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { intimacy: { components: [
      { path: "productionEvidence.stereoWidth", weight: 0.35, invert: true },
      { path: "productionEvidence.reverb", weight: 0.35, invert: true },
      { path: "moodDimensions.warmth", weight: 0.3 }
    ] } }
  }, { entries: [] });
  const { axes, contributingPaths } = engine.evaluateAxes({ productionEvidence: {}, moodDimensions: {} }, {});
  assert.equal(axes.intimacy, null);
  assert.deepEqual(contributingPaths.intimacy, []);
});

test("a genre-prior component alone (no real acoustic signal) cannot manufacture an axis value", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { glossiness: { components: [
      { path: "moodDimensions.brightness", weight: 0.5 },
      { genrePriors: { "city pop": 0.8 }, weight: 0.5 }
    ] } }
  }, { entries: [] });
  const genre = { primary: "City Pop", confidence: 0.85, uncertain: false };
  const grounded = engine.evaluateAxes({ moodDimensions: { brightness: 0.7 } }, genre);
  assert.ok(grounded.axes.glossiness !== null, "brightness is a real measurement, so this must resolve");
  const genreOnly = engine.evaluateAxes({ moodDimensions: {} }, genre);
  assert.equal(genreOnly.axes.glossiness, null, "genre label alone must not fabricate an unmeasured axis");
});

// Regression coverage for the STEP-1 fix: genrePriorResult() used to return `value: 0` for a
// genre absent from an axis's prior table, and 0 is a finite number the weighted average happily
// summed in. That silently capped the axis below what the genre-prior weight alone could reach
// for every genre outside the (8-entry) table -- a confidently-known-but-untabled genre (Techno,
// Shoegaze) scored WORSE than an unconfirmed genre, which is backwards: "no prior researched for
// this genre" and "genre unknown" are the same absence of information and must resolve the same
// way (null), not two different numbers.
test("STEP 1: same acoustic evidence, a genre absent from the prior table now scores IDENTICALLY to an unconfirmed genre (not lower)", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const view = { moodDimensions: { warmth: 0.7, brightness: 0.6 },
    productionEvidence: { sampleBased: 0.6, distortion: 0.3 },
    rhythmicGrammar: { fourOnFloor: 0.6, syncopation: 0.3, brokenBeat: 0.2, swing: 0.1 } };
  const untabled = engine.evaluateAxes(view, { primary: "Techno", confidence: 0.85, uncertain: false });
  const alsoUntabled = engine.evaluateAxes(view, { primary: "Shoegaze", confidence: 0.85, uncertain: false });
  const unconfirmed = engine.evaluateAxes(view, { primary: "Unknown", confidence: 0.2, uncertain: true });
  for (const axis of ["nostalgia", "artificiality", "urbanity", "syncopation"]) {
    assert.equal(untabled.axes[axis], unconfirmed.axes[axis],
      `${axis}: Techno (untabled) must equal unconfirmed genre, not score lower`);
    assert.equal(alsoUntabled.axes[axis], unconfirmed.axes[axis], `${axis}: Shoegaze (untabled) must equal unconfirmed genre`);
  }
});

test("STEP 1: a genre actually IN the prior table still gets a real boost from it", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const view = { moodDimensions: { warmth: 0.7, brightness: 0.6 },
    productionEvidence: { sampleBased: 0.6, distortion: 0.3 }, rhythmicGrammar: { fourOnFloor: 0.6 } };
  const tabled = engine.evaluateAxes(view, { primary: "City Pop", confidence: 0.85, uncertain: false });
  const untabled = engine.evaluateAxes(view, { primary: "Techno", confidence: 0.85, uncertain: false });
  // City Pop has a genrePriors entry on nostalgia/urbanity (not artificiality) -- confirms the
  // prior itself still functions, this was never about disabling genre priors altogether.
  assert.ok(tabled.axes.nostalgia > untabled.axes.nostalgia);
  assert.ok(tabled.axes.urbanity > untabled.axes.urbanity);
  assert.equal(tabled.axes.artificiality, untabled.axes.artificiality, "city pop has no artificiality prior, so no difference is expected there");
});

test("STEP 1: zero measured components still keeps the axis null regardless of genre-table membership (unaffected by this fix)", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const emptyView = { moodDimensions: {}, productionEvidence: {}, rhythmicGrammar: {} };
  assert.equal(engine.evaluateAxes(emptyView, { primary: "City Pop", confidence: 0.85, uncertain: false }).axes.nostalgia, null);
  assert.equal(engine.evaluateAxes(emptyView, { primary: "Techno", confidence: 0.85, uncertain: false }).axes.nostalgia, null);
  assert.equal(engine.evaluateAxes(emptyView, { primary: "Unknown", confidence: 0.2, uncertain: true }).axes.nostalgia, null);
});

test("region text is keyed to axis combinations, not genre identity: same genre, different production/mood values produce different words", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const genre = { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false };

  // Same genre and genre-confidence throughout -- only the measured evidence differs.
  const nostalgicDecayed = engine.evaluate({
    moodDimensions: { warmth: 0.75, brightness: 0.3, valence: 0.6, aggression: 0.2 },
    productionEvidence: { sampleBased: 0.8, distortion: 0.7 },
    rhythmicGrammar: {}
  }, genre);
  const glossyUrban = engine.evaluate({
    moodDimensions: { warmth: 0.3, brightness: 0.85, valence: 0.6, aggression: 0.2 },
    productionEvidence: { filterSweep: 0.8, stereoWidth: 0.75, sidechain: 0.1, distortion: 0.05 },
    rhythmicGrammar: { fourOnFloor: 0.8 }
  }, genre);

  const decayedTexts = nostalgicDecayed.candidates.map(c => c.text);
  const urbanTexts = glossyUrban.candidates.map(c => c.text);
  assert.ok(decayedTexts.length > 0, "decayed/nostalgic evidence should surface at least one region");
  assert.ok(urbanTexts.length > 0, "glossy/urban evidence should surface at least one region");
  assert.ok(decayedTexts.some(text => !urbanTexts.includes(text)),
    `same genre, different evidence must not converge on identical wording; got ${JSON.stringify(decayedTexts)} vs ${JSON.stringify(urbanTexts)}`);
  // The specific expected direction: decay-flavored evidence should not surface the urban/glossy
  // 80s-style region, and vice versa.
  assert.ok(!decayedTexts.includes("도시의 야경"));
  assert.ok(!urbanTexts.includes("바스러진 테이프 소리"));
});

test("aesthetic-axis region candidates flow through genreContextEngine alongside rule/relation candidates", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const result = engine.evaluate({
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.75, swing: 0.2 },
    productionEvidence: { sampleBased: 0.8, filterSweep: 0.75, stereoWidth: 0.7 },
    moodDimensions: { brightness: 0.8, warmth: 0.35, valence: 0.6, aggression: 0.2 },
    instruments: [], expressionFeatures: {}
  });
  const axisCandidates = result.candidates.filter(item => item.source === "aesthetic-axis");
  assert.ok(axisCandidates.length > 0, "a confidently-known genre with real glossy/urban evidence should surface at least one axis-based candidate");
  for (const candidate of axisCandidates) assert.ok(candidate.anchors.length >= 2, "axis candidates must carry real evidence anchors");
});

test("genreContextEngine exposes axisSignature on its result when an axis engine is wired (section 5's runtime call gate reads this)", () => {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const engine = new GenreContext.Engine(genreContextKnowledge, axisEngine);
  const state = {
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.3, uncertain: true },
    rhythmicGrammar: { fourOnFloor: 0.75 }, productionEvidence: { sampleBased: 0.8 },
    moodDimensions: { brightness: 0.8 }, instruments: [], expressionFeatures: {}
  };
  const result = engine.evaluate(state);
  assert.equal(typeof result.axisSignature, "string");
  const directAxisResult = axisEngine.evaluate({
    measurements: {}, rhythmicGrammar: state.rhythmicGrammar, productionEvidence: state.productionEvidence,
    instrumentationEvidence: {}, moodDimensions: state.moodDimensions, aestheticEvidence: {}
  }, state.genre);
  assert.equal(result.axisSignature, directAxisResult.axisSignature);
  // STEP 3: the raw axis vector must also be exposed (scripts/replay.cjs reads it for real
  // per-song axis-value distributions), not just the coarse signature.
  assert.deepEqual(result.axes, directAxisResult.axes);
  assert.ok(typeof result.axes.urbanity === "number", "urbanity should resolve from the real evidence in this fixture");
});

test("without a wired axis engine, genreContextEngine's result carries no axisSignature at all", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge);
  const result = engine.evaluate({
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.75 }, productionEvidence: { sampleBased: 0.8 },
    moodDimensions: { brightness: 0.8 }, instruments: [], expressionFeatures: {}
  });
  assert.equal(result.axisSignature, undefined);
});

test("without a wired axis engine, genreContextEngine behaves exactly as before (no axis candidates, no crash)", () => {
  const engine = new GenreContext.Engine(genreContextKnowledge);
  const result = engine.evaluate({
    genre: { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false },
    rhythmicGrammar: { fourOnFloor: 0.75 }, productionEvidence: { sampleBased: 0.8 },
    moodDimensions: { brightness: 0.8 }, instruments: [], expressionFeatures: {}
  });
  assert.equal(result.candidates.some(item => item.source === "aesthetic-axis"), false);
});

test("axes report a delta/direction, not just a current value, once a trailing-window baseline exists", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { nostalgia: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 1_000_000;
  const first = engine.evaluate({ moodDimensions: { warmth: 0.3 } }, {}, t0);
  assert.equal(first.delta.nostalgia, null, "no baseline yet -- must not report a fabricated 0 delta");
  assert.equal(first.direction.nostalgia, null);
  const later = engine.evaluate({ moodDimensions: { warmth: 0.75 } }, {}, t0 + 12000);
  assert.ok(later.delta.nostalgia > 0.4, `expected a strong rising delta, got ${later.delta.nostalgia}`);
  assert.equal(later.direction.nostalgia, "rising");
  const fallen = engine.evaluate({ moodDimensions: { warmth: 0.3 } }, {}, t0 + 24000);
  assert.ok(fallen.delta.nostalgia < 0);
  assert.equal(fallen.direction.nostalgia, "falling");
});

test("a tiny axis fluctuation reports as stable, not a spurious rising/falling flip", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 2_000_000;
  engine.evaluate({ moodDimensions: { warmth: 0.5 } }, {}, t0);
  const result = engine.evaluate({ moodDimensions: { warmth: 0.52 } }, {}, t0 + 12000);
  assert.equal(result.direction.warmth, "stable");
});

test("a null current or baseline value keeps delta/direction null, never fabricated as 0", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [] }, { historyWindowMs: 10000 });
  const t0 = 3_000_000;
  engine.evaluate({ moodDimensions: {} }, {}, t0);
  const result = engine.evaluate({ moodDimensions: { warmth: 0.6 } }, {}, t0 + 12000);
  assert.equal(result.delta.warmth, null);
  assert.equal(result.direction.warmth, null);
});

test("a region barely clearing its min threshold does not fire just because genre confidence is high (selectivity is margin-based, not genre-based)", () => {
  const engine = new AestheticAxisEngine.Engine({
    axes: { warmth: { components: [{ path: "moodDimensions.warmth", weight: 1 }] } }
  }, { entries: [{ text: "따뜻한 아날로그 온기", category: "association", requires: [{ axis: "warmth", min: 0.5 }], minAxes: 1 }] });
  const genre = { primary: "City Pop", confidence: 0.9, uncertain: false };
  assert.equal(engine.evaluate({ moodDimensions: { warmth: 0.55 } }, genre).candidates.length, 0,
    "barely over the min threshold, even with a very confident genre, must not be enough");
  assert.equal(engine.evaluate({ moodDimensions: { warmth: 0.8 } }, genre).candidates.length, 1,
    "comfortably clearing the threshold should fire");
});

test("a region can require an axis direction (e.g. 'deepening nostalgia'), not just its current value", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions, { historyWindowMs: 10000 });
  const genre = { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false };
  const t0 = 4_000_000;
  const flatState = { moodDimensions: { warmth: 0.5, brightness: 0.4, valence: 0.5, aggression: 0.3 },
    productionEvidence: { sampleBased: 0.75 }, rhythmicGrammar: {} };
  const first = engine.evaluate(flatState, genre, t0);
  assert.ok(!first.candidates.some(item => item.text === "짙어지는 향수"), "no baseline yet, direction-gated region must not fire");
  const deepening = engine.evaluate({ ...flatState, moodDimensions: { ...flatState.moodDimensions, warmth: 1 } }, genre, t0 + 12000);
  assert.ok(deepening.candidates.some(item => item.text === "짙어지는 향수"),
    `expected the rising-nostalgia region once warmth clearly climbed; got ${JSON.stringify(deepening.candidates.map(c => c.text))}`);
});

test("axisSignature is deterministic regardless of key order, and distinguishes genuinely different axis territories", () => {
  const axes = { nostalgia: 0.8, warmth: 0.3 };
  assert.equal(AestheticAxisEngine.axisSignature(axes), AestheticAxisEngine.axisSignature({ warmth: 0.3, nostalgia: 0.8 }),
    "key order must not affect the signature -- it is a cache key");
  assert.notEqual(AestheticAxisEngine.axisSignature({ nostalgia: 0.8, warmth: 0.3 }),
    AestheticAxisEngine.axisSignature({ nostalgia: 0.1, warmth: 0.3 }), "a genuinely different territory must produce a different signature");
});

test("axisSignature treats a null axis as its own distinct band, never confusing it with a real low value", () => {
  const withNull = AestheticAxisEngine.axisSignature({ nostalgia: null, warmth: 0.3 });
  const withLow = AestheticAxisEngine.axisSignature({ nostalgia: 0.01, warmth: 0.3 });
  assert.notEqual(withNull, withLow);
  assert.ok(withNull.includes("nostalgia:null"));
});

test("evaluate() exposes an axisSignature alongside its candidates, matching axisSignature() computed directly from the same axes", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, aestheticRegions);
  const genre = { primary: "City Pop", family: "Pop / Internet", confidence: 0.85, uncertain: false };
  const result = engine.evaluate({ moodDimensions: { warmth: 0.7, brightness: 0.4 }, productionEvidence: { sampleBased: 0.6 } }, genre);
  assert.equal(result.axisSignature, AestheticAxisEngine.axisSignature(result.axes));
});

// STEP 2 gate: every path an axis component references must be a genuinely LIVE snapshot field
// (capable of holding a real value under some realistic input), never one that is structurally
// hardcoded to null. This is the exact class of bug STEP 1's fix was framed around, one level
// deeper: js/semantic/rhythmicGrammar.js's production() unconditionally returns
// `stereoWidth: null, reverb: null, distortion: null` -- discovered while doing this audit,
// confirmed empirically below, not merely by reading the source. Three axis components (decay's
// distortion at 0.45 weight -- its LARGEST component -- plus glossiness's stereoWidth, nostalgia's
// distortion, tension's distortion, and BOTH of intimacy's two production components) referenced
// these before this fix, meaning intimacy was silently "= warmth alone" this whole time.
const KNOWN_DEAD_PATHS = new Set([
  "productionEvidence.stereoWidth", "productionEvidence.reverb", "productionEvidence.distortion"
]);
const KNOWN_LIVE_PATHS = new Set([
  "productionEvidence.sampleBased", "productionEvidence.sidechain", "productionEvidence.filterSweep",
  "productionEvidence.pumping", "productionEvidence.vocalChop",
  "moodDimensions.aggression", "moodDimensions.arousal", "moodDimensions.brightness",
  "moodDimensions.spaciousness", "moodDimensions.tension", "moodDimensions.valence",
  "moodDimensions.warmth", "moodDimensions.weight",
  "rhythmicGrammar.confidence", "rhythmicGrammar.onsetCount", "rhythmicGrammar.fourOnFloor",
  "rhythmicGrammar.swing", "rhythmicGrammar.syncopation", "rhythmicGrammar.brokenBeat",
  "rhythmicGrammar.subdivisionRatio", "rhythmicGrammar.accentPeriodicity",
  "rhythmicGrammar.accentPeriodicityConfidence", "rhythmicGrammar.accentPlacement",
  "rhythmicGrammar.halfTimeLikelihood", "rhythmicGrammar.doubleTimeLikelihood",
  "rhythmicGrammar.microTimingDeviation", "rhythmicGrammar.groovePushPull",
  "rhythmicGrammar.kickPeriodicity", "rhythmicGrammar.rhythmicEntropy",
  "measurements.transientDensity", "measurements.onsetRate", "measurements.bass",
  "measurements.bpm", "measurements.flatness", "measurements.harmonicMovement",
  "measurements.tempoStability", "measurements.tonalFocus"
]);

test("STEP 2 gate: no axis component references a path known to be structurally dead", () => {
  for (const [axisName, def] of Object.entries(aestheticAxes.axes)) {
    for (const component of def.components || []) {
      if (!component.path) continue;
      assert.ok(!KNOWN_DEAD_PATHS.has(component.path),
        `${axisName} references ${component.path}, hardcoded to always-null in rhythmicGrammar.js's production() -- this component can never contribute`);
    }
  }
});

test("STEP 2 gate: every axis component path is on the verified-live snapshot field list", () => {
  for (const [axisName, def] of Object.entries(aestheticAxes.axes)) {
    for (const component of def.components || []) {
      if (!component.path) continue;
      assert.ok(KNOWN_LIVE_PATHS.has(component.path),
        `${axisName} references ${component.path}, which is not on the verified-live path list -- ` +
        `confirm by reading the producing source that it can hold a real value, then add it there`);
    }
  }
});

test("STEP 2 gate meta-test: productionEvidence.stereoWidth/reverb/distortion are empirically confirmed always-null, even under maximally favorable input", () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({ centroid: 1000 + index * 200 }));
  const envelope = [];
  const beatTimestamps = [];
  for (let beat = 0; beat < 10; beat++) {
    const start = beat * 500;
    beatTimestamps.push(start);
    for (let index = 0; index < 10; index++)
      envelope.push({ at: start + index * 50, value: index < 3 ? 0.2 : index > 7 ? 0.9 : 0.5 });
  }
  const result = Grammar.production({ deltaRms: 0.01, deltaCentroid: 1000, pumping: 0.5 }, frames, {
    envelope, beatTimestamps, beatConfidence: 0.9, repetition: 0.9, masterBrightness: 0.2, voiceConfidence: 0.8, onsetRate: 4
  });
  assert.equal(result.stereoWidth, null);
  assert.equal(result.reverb, null);
  assert.equal(result.distortion, null);
  // Contrast: other optional fields DO resolve under this same favorable input, proving the three
  // above are dead by design, not just unlucky with this particular synthetic input.
  assert.ok(Number.isFinite(result.filterSweep), "filterSweep should resolve under this favorable input, unlike the three dead fields");
  assert.ok(Number.isFinite(result.sampleBased), "sampleBased should resolve under this favorable input, unlike the three dead fields");
});

test("STEP 2: motion split into drive (steady propulsion) and syncopation (off-beat displacement), fourOnFloor now actually drives an axis", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const genre = { primary: "Techno", confidence: 0.85, uncertain: false };
  const fourOnFloorHeavy = engine.evaluateAxes({ rhythmicGrammar: { fourOnFloor: 0.95, kickPeriodicity: 0.9, confidence: 0.9, syncopation: 0.05, brokenBeat: 0.05, swing: 0.05 },
    moodDimensions: { arousal: 0.8 }, productionEvidence: { sidechain: 0.7 } }, genre);
  assert.ok(fourOnFloorHeavy.axes.drive > 0.7, `a 0.95-fourOnFloor techno track should score high on drive, got ${fourOnFloorHeavy.axes.drive}`);
  const syncopationHeavy = engine.evaluateAxes({ rhythmicGrammar: { fourOnFloor: 0.05, kickPeriodicity: 0.1, confidence: 0.3, syncopation: 0.9, brokenBeat: 0.85, swing: 0.7 },
    moodDimensions: { arousal: 0.3 }, productionEvidence: {} }, genre);
  assert.ok(syncopationHeavy.axes.syncopation > 0.6, `a heavily syncopated/broken pattern should score high on syncopation, got ${syncopationHeavy.axes.syncopation}`);
  assert.ok(syncopationHeavy.axes.drive < fourOnFloorHeavy.axes.drive, "the syncopation-heavy pattern should score lower on drive than the four-on-floor one");
  assert.equal(aestheticAxes.axes.motion, undefined, "the old combined motion axis should no longer exist");
});

test("STEP 2: density and clarity axes exist and resolve from real signals", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const genre = { primary: "Shoegaze", confidence: 0.85, uncertain: false };
  const busy = engine.evaluateAxes({ measurements: { transientDensity: 0.8 }, moodDimensions: { arousal: 0.7, aggression: 0.7 } }, genre);
  assert.ok(busy.axes.density !== null && busy.axes.density > 0.5);
  assert.ok(busy.axes.clarity !== null && busy.axes.clarity < 0.5, "high aggression/transientDensity should read as LOW clarity");
  const clean = engine.evaluateAxes({ measurements: { transientDensity: 0.1 }, moodDimensions: { arousal: 0.2, aggression: 0.1 } }, genre);
  assert.ok(clean.axes.clarity > busy.axes.clarity, "low aggression/transientDensity should read as higher clarity than the busy case");
});

test("STEP 2: intimacy no longer silently reduces to warmth alone -- spaciousness now genuinely moves it", () => {
  const engine = new AestheticAxisEngine.Engine(aestheticAxes, { entries: [] });
  const genre = { primary: "Ambient", confidence: 0.85, uncertain: false };
  const close = engine.evaluateAxes({ moodDimensions: { warmth: 0.6, spaciousness: 0.1, aggression: 0.2 } }, genre);
  const spacious = engine.evaluateAxes({ moodDimensions: { warmth: 0.6, spaciousness: 0.9, aggression: 0.2 } }, genre);
  assert.ok(close.axes.intimacy > spacious.axes.intimacy,
    `same warmth, but low spaciousness must read as more intimate than high spaciousness (got ${close.axes.intimacy} vs ${spacious.axes.intimacy})`);
});
