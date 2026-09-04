const test = require("node:test");
const assert = require("node:assert/strict");
const PhrasePool = require("../js/semantic/phrasePoolEngine");

function state(character = {}) {
  return {
    genre: { family: "Electronic / Club", primary: "House", secondary: [], fineCandidates: [{ label: "Deep House" }] },
    instruments: [{ label: "drums", confidence: 0.7 }],
    mood: { fused: { arousal: 0.65, warmth: 0.5, spaciousness: 0.4 } },
    novelty: { score: 0.1 },
    ml: { lastUpdated: 1 },
    trackCharacter: {
      confidence: 0.9,
      fingerprint: [0.8, 0.2, 0.3, 0.1],
      rhythm: { bpm: 126, pulseRegularity: 0.86, rhythmicComplexity: 0.24, breakbeatLikelihood: 0.12 },
      harmony: { tonalness: 0.64 },
      timbre: { brightness: 0.42, warmth: 0.58, roughness: 0.22 },
      texture: { density: 0.58, granularness: 0.24 },
      dynamics: { compressionDensity: 0.7 },
      space: { spaciousness: 0.36 },
      production: { subWeight: 0.62 },
      structure: { repetition: 0.84 },
      ...character
    }
  };
}

test("phrase pool rejects generic defaults and uses a bounded literal pool without quotas", async () => {
  const engine = new PhrasePool.Engine({ poolSize: 40 });
  await engine.regenerate({
    state: state(), sessionId: 1, epoch: 2,
    semanticTokens: [{ text: "빛", category: "neutral" }, { text: "굴절", category: "texture" }, { text: "드럼", category: "instrument" }]
  });
  const pool = engine.snapshot();
  assert.ok(pool.length > 0 && pool.length <= 40);
  assert.ok(pool.every(item => !PhrasePool.GENERIC.has(item.text)));
  assert.ok(!pool.some(item => item.text === "드럼" || item.text === "House"));
  for (let index = 0; index < pool.length; index++) {
    for (let other = index + 1; other < pool.length; other++) assert.ok(PhrasePool.similarity(pool[index].text, pool[other].text) <= 0.74);
  }
});

test("same genre with different Track Character produces different language", () => {
  const steady = PhrasePool.structuredCandidates(PhrasePool.buildSeed(state()), [], 60, 1).map(item => item.text);
  const fracturedState = state({
    fingerprint: [0.2, 0.9, 0.9, 0.9],
    rhythm: { bpm: 174, pulseRegularity: 0.2, rhythmicComplexity: 0.9, breakbeatLikelihood: 0.92 },
    timbre: { brightness: 0.86, warmth: 0.2, roughness: 0.84 },
    texture: { density: 0.84, granularness: 0.88 },
    space: { spaciousness: 0.72 }
  });
  const fractured = PhrasePool.structuredCandidates(PhrasePool.buildSeed(fracturedState), [], 60, 1).map(item => item.text);
  const overlap = steady.filter(text => fractured.includes(text)).length / steady.length;
  assert.ok(overlap < 0.35);
});

test("a fully rejected LLM batch still leaves its rejected candidates visible for diagnostics", async () => {
  const rejectedBatch = [{ text: "완전히 근거없는 표현", category: "genre", confidence: 0.9, kind: "descriptor",
    role: "none", layer: "CONTEXT", anchors: ["totally.fake.path", "another.fake.one"] }];
  const generator = { state: { status: "ready" }, generate: () => Promise.resolve(rejectedBatch) };
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 1 });
  await engine.regenerate({ state: state(), sessionId: 1, epoch: 1 });
  assert.equal(engine.state.status, "fallback");
  assert.ok(engine.state.error && engine.state.error.includes("0 candidates"),
    "the whole batch must be rejected for this scenario to be meaningful");
  const rejected = engine.inspection().candidates.find(item => item.text === "완전히 근거없는 표현");
  assert.ok(rejected, "a fully-rejected LLM candidate must still surface in inspection() for prompt tuning");
  assert.equal(rejected.valid, false);
  assert.equal(rejected.diagnostics.evidenceReason, "no-anchor-resolved");
});

test("old local generation result cannot enter a new audio session", async () => {
  let release;
  const generator = {
    state: { status: "ready" },
    generate: () => new Promise(resolve => { release = resolve; })
  };
  const engine = new PhrasePool.Engine({ generator, poolSize: 40 });
  const oldGeneration = engine.regenerate({ state: state(), sessionId: 1, epoch: 0, force: true });
  engine.reset(2);
  release(Array.from({ length: 20 }, (_, index) => `이전 세션 문장 ${index}`));
  await oldGeneration;
  assert.deepEqual(engine.snapshot(), []);
});
