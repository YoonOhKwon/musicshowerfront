const test = require("node:test");
const assert = require("node:assert/strict");
const ArrangementEngine = require("../js/semantic/arrangementEngine");

const texts = candidates => candidates.map(item => item.text);

test("rhythm-section-centered arrangement fires when drums and bass both dominate", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "drums", confidence: 0.6 }, { id: "bass", confidence: 0.6 }] },
    { texture: { density: 0.5 } }
  );
  assert.ok(texts(result.candidates).includes("리듬 섹션 중심"));
});

test("vocal-centered arrangement fires when a dominant, confident voice is present", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "voice", confidence: 0.8, dominance: 0.3 }] },
    { texture: { density: 0.5 } }
  );
  assert.ok(texts(result.candidates).includes("보컬 중심"));
});

test("layered-synth arrangement fires only with a confident synth and dense texture", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "synthesizer", confidence: 0.7 }] },
    { texture: { density: 0.75 } }
  );
  assert.ok(texts(result.candidates).includes("레이어드 신스"));
});

test("small-ensemble texture fires on sparse, low-density instrumentation", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "piano", confidence: 0.6 }, { id: "bass", confidence: 0.55 }] },
    { texture: { density: 0.2 } }
  );
  assert.ok(texts(result.candidates).includes("소편성 질감"));
});

test("weak, unremarkable instrumentation produces no arrangement claims", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "drums", confidence: 0.4 }, { id: "bass", confidence: 0.3 }] },
    { texture: { density: 0.5 } }
  );
  assert.deepEqual(result.candidates, []);
});

test("a verified ensemble size of 3 surfaces as a trio, not a raw number", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "drums", confidence: 0.4 }, { id: "bass", confidence: 0.3 }], verifiedEnsembleSize: 3 },
    { texture: { density: 0.5 } }
  );
  assert.ok(texts(result.candidates).includes("트리오 구성"));
  assert.equal(result.verifiedEnsembleSize, 3);
});

test("no ensemble-size candidate is proposed when the size is not verified", () => {
  const engine = new ArrangementEngine.Engine();
  const result = engine.update(
    { observed: [{ id: "drums", confidence: 0.4 }, { id: "bass", confidence: 0.3 }], verifiedEnsembleSize: null },
    { texture: { density: 0.5 } }
  );
  assert.ok(!texts(result.candidates).some(text => /구성|앙상블/.test(text)));
  assert.equal(result.verifiedEnsembleSize, null);
});
