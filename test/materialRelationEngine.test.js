const test = require("node:test");
const assert = require("node:assert/strict");
const Relations = require("../js/semantic/materialRelationEngine");
const Facts = require("../js/semantic/factComposer");
const Claims = require("../js/semantic/verifiedClaimStore");

function state(extra = {}) {
  return {
    verifiedClaims: { byConcept: {}, licensed: new Set(), items: [] },
    instrumentation: { observed: [] },
    primitives: { pulse: {}, bass: {}, melody: {}, form: {}, arrangement: {}, role: {}, instrument: {}, harmony: {}, production: {} },
    rhythmicGrammar: {},
    productionEvidence: {},
    trackCharacter: { production: {}, texture: {}, structure: {}, space: {}, dynamics: {}, rhythm: {} },
    performance: {},
    expressionFeatures: {},
    ...extra
  };
}

function collect(base) {
  const next = { ...base };
  next.verifiedClaims = Claims.collect(next);
  return next;
}

test("LOCK requires kick periodicity and bass-kick alignment, not bass presence alone", () => {
  const missing = collect(state({
    instrumentation: { observed: [{ id: "bass", label: "Bass", confidence: 0.8 }] },
    rhythmicGrammar: { fourOnFloor: 0.9, kickPeriodicity: 0.88 },
    primitives: { pulse: { kickPeriodicity: 0.88 }, bass: { bassPresence: 0.8 } }
  }));
  assert.equal(Relations.evaluate(missing).relations.some(item => item.relationType === "LOCK"), false);

  const locked = collect(state({
    instrumentation: { observed: [{ id: "bass", label: "Bass", confidence: 0.8 }] },
    rhythmicGrammar: { fourOnFloor: 0.9, kickPeriodicity: 0.88 },
    primitives: { pulse: { kickPeriodicity: 0.88 }, bass: { bassPresence: 0.8, bassKickInteraction: 0.84 } }
  }));
  const lock = Relations.evaluate(locked).relations.find(item => item.relationId === "bass.kick.lock");
  assert.ok(lock);
  assert.equal(lock.relationType, "LOCK");
  assert.equal(lock.subjectConceptId, "bass");
  assert.equal(lock.objectConceptId, "kick");
  assert.ok(lock.confidence >= 0.7);
  assert.ok(lock.anchors.includes("primitives.bass.bassKickInteraction"));
  assert.ok(lock.evidenceAxes.includes("bass"));
  assert.ok(lock.evidenceAxes.includes("pulse"));
});

test("OFFSET needs bass, low kick alignment, and syncopation together", () => {
  const result = Relations.evaluate(collect(state({
    instrumentation: { observed: [{ id: "bass", label: "Bass", confidence: 0.78 }] },
    primitives: {
      bass: { bassPresence: 0.76, bassKickInteraction: 0.22, syncopation: 0.72 },
      pulse: { syncopation: 0.7 }
    }
  })));
  const offset = result.relations.find(item => item.relationId === "bass.offset_from_pulse");
  assert.ok(offset);
  assert.equal(offset.relationType, "OFFSET");
});

test("RESPONSE refuses a single coincidental onset without recurrence", () => {
  const once = Relations.evaluate(state({
    primitives: {
      melody: { callResponseLikelihood: 0.82, motifRecurrence: 0.2 },
      role: { callResponse: 0.8 },
      instrument: { callResponse: 0.8 }
    }
  }));
  assert.equal(once.relations.some(item => item.relationType === "RESPONSE"), false);

  const repeated = Relations.evaluate(state({
    primitives: {
      melody: { callResponseLikelihood: 0.82, motifRecurrence: 0.7 },
      role: { callResponse: 0.8 },
      instrument: { callResponse: 0.8 }
    }
  }));
  assert.ok(repeated.relations.some(item => item.relationId === "melody.call_response"));
});

test("BUILD and THIN stay at measured density language and never name verse or chorus", () => {
  const building = collect(state({
    primitives: { form: { densityDelta: 0.28, layerEntry: 0.7, buildupSlope: 0.6 } },
    expressionFeatures: { deltaEnergy: 0.22 }
  }));
  const thinning = collect(state({
    primitives: { form: { densityDelta: -0.28, layerExit: 0.7 } },
    trackCharacter: { production: { subWeight: 0.28 }, texture: {} },
    expressionFeatures: { deltaBass: -0.14 }
  }));
  const built = Relations.evaluate(building).relations.find(item => item.relationType === "BUILD");
  const thinned = Relations.evaluate(thinning).relations.find(item => item.relationType === "THIN");
  assert.ok(built);
  assert.ok(thinned);
  const texts = [...Facts.compose(building), ...Facts.compose(thinning)].map(item => item.text).join(" ");
  assert.equal(/후렴|벌스|코러스|chorus|verse/i.test(texts), false);
  assert.match(Facts.compose(building).find(item => item.relationId === "arrangement.build").text, /밀도|레이어|전환|전개/);
  assert.match(Facts.compose(thinning).find(item => item.relationId === "arrangement.thinning").text, /저역|레이어|밀도|편성/);
});

test("vocal presence plus bright spectrum does not invent a bright-vocal relation", () => {
  const result = Relations.evaluate(collect(state({
    instrumentation: { observed: [{ id: "voice", label: "Voice", confidence: 0.82, dominance: 0.5 }] },
    moodDimensions: { brightness: 0.88 },
    trackCharacter: { timbre: { brightness: 0.88 }, production: {}, texture: {} }
  })));
  assert.equal(result.relations.some(item => /vocal/.test(item.relationId) && /bright|timbre/i.test(item.relationId)), false);
  assert.equal(result.relations.some(item => /밝은 보컬/.test(JSON.stringify(item))), false);
});

test("composed FACT tokens keep the relation schema and drop section-name leftovers", () => {
  const ready = collect(state({
    instrumentation: {
      observed: [
        { id: "voice", label: "Voice", confidence: 0.7, dominance: 0.4 },
        { id: "synth", label: "Synthesizer", confidence: 0.72, dominance: 0.3 }
      ]
    },
    primitives: { pulse: { kickPeriodicity: 0.86 }, bass: { bassPresence: 0.7, bassKickInteraction: 0.8 } },
    rhythmicGrammar: { fourOnFloor: 0.86, kickPeriodicity: 0.86 }
  }));
  ready.instrumentation.observed.push({ id: "bass", label: "Bass", confidence: 0.7, dominance: 0.2 });
  const tokens = Facts.compose(ready);
  assert.ok(tokens.some(item => item.relationId === "vocal.synth.layer"));
  assert.ok(tokens.some(item => item.relationId === "bass.kick.lock"));
  for (const item of tokens) {
    assert.ok(item.relationType);
    assert.ok(item.conceptId);
    assert.ok(Array.isArray(item.anchors));
    assert.ok(Array.isArray(item.evidenceAxes));
    assert.ok(item.temporalScope);
    assert.equal(/후렴|벌스/.test(item.text), false);
  }
});
