const test = require("node:test");
const assert = require("node:assert/strict");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Rhythm = require("../js/semantic/rhythmicGrammar");
const Instruments = require("../js/semantic/instrumentationEventEngine");

const eventsFromIntervals = intervals => {
  let at = 0;
  return [{ at, strength: 1 }, ...intervals.map((interval, index) => ({ at: at += interval, strength: index % 2 ? 0.4 : 1 }))];
};

test("equal and 2:1 onset pairs expose continuous subdivision ratios", () => {
  assert.equal(Rhythm.subdivisionRatio(eventsFromIntervals(Array(8).fill(100))), 1);
  assert.ok(Math.abs(Rhythm.subdivisionRatio(eventsFromIntervals([200, 100, 200, 100, 200, 100, 200, 100])) - 2) < 0.01);
});

test("a repeated five-accent pattern reports period five", () => {
  const events = Array.from({ length: 25 }, (_, index) => ({ at: index * 100, strength: index % 5 === 0 ? 1 : 0.15 }));
  assert.equal(Rhythm.accentPeriodicity(events).period, 5);
});

test("instrument families use noisy-OR and expose normalized dominance dispersion", () => {
  const observed = Instruments.normalize([
    { label: "trumpet", confidence: 0.4 }, { label: "brass", confidence: 0.35 }, { label: "saxophone", confidence: 0.3 }
  ]);
  const families = Instruments.familyRollup(observed);
  assert.ok(Math.abs(families.brass.confidence - 0.61) < 0.001);
  assert.ok(Instruments.dominanceDispersion(observed) > 0.9);
});

test("primitive texture distinguishes one voice, distributed voices and a dominant lead", () => {
  const base = { rhythm: { bpm: 110, confidence: 0.8, tempoStability: 0.8 }, rhythmicGrammar: {},
    trackCharacter: { confidence: 0.8, rhythm: { pulseRegularity: 0.8 }, texture: { sustainedness: 0.4, density: 0.5 },
      harmony: {}, timbre: {}, dynamics: {}, structure: {}, production: {}, space: {} }, arrangement: { density: 0.5 } };
  const mono = Primitives.analyze({ ...base, instrumentation: { observed: [{ confidence: 0.8 }], families: { voice: { confidence: 0.8 } }, confidence: 0.8 } });
  assert.equal(mono.texture.textureClass, "monophonic");
  const poly = Primitives.analyze({ ...base, instrumentation: { observed: [{ confidence: .7 }, { confidence: .69 }, { confidence: .68 }, { confidence: .67 }],
    families: { brass: { confidence: .7 }, reed: { confidence: .69 }, keys: { confidence: .68 }, bass: { confidence: .67 } }, dominanceDispersion: .95, confidence: .8 } });
  assert.equal(poly.texture.textureClass, "polyphonic");
  const homophonic = Primitives.analyze({ ...base, instrumentation: { observed: [{ confidence: .9 }, { confidence: .5 }],
    families: { voice: { confidence: .9 }, keys: { confidence: .5 } }, dominanceDispersion: .35, confidence: .8 } });
  assert.equal(homophonic.texture.textureClass, "homophonic");
});

test("missing primitive input remains null instead of pretending absence is zero", () => {
  const empty = Primitives.analyze({});
  for (const [axis, fields] of Object.entries(empty)) {
    if (axis === "meta") continue;
    assert.ok(Object.values(fields).every(value => value === null));
  }
});
