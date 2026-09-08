const test = require("node:test");
const assert = require("node:assert/strict");
const PhrasePool = require("../js/semantic/phrasePoolEngine");
const { parseLanguageResponse } = require("../lib/languageService");
const { profile, responseFixture } = require("./fixtures/languageProfiles");

function counter() {
  let calls = 0;
  const generator = { state: { status: "ready" }, generate: () => { calls++; return Promise.resolve(parseLanguageResponse(responseFixture())); } };
  return { generator, count: () => calls };
}

async function establishRemotePool(engine) {
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1, force: true });
  assert.equal(engine.hasRemotePool, true, "test setup: the forced first call must establish a real remote pool");
}

test("an unconsumed context-only remote pool is complete even when below the old generic low-watermark", async () => {
  const { generator, count } = counter();
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 999 });
  const state = profile();
  await engine.regenerate({ state, sessionId: 1, epoch: 1, force: true });
  assert.equal(count(), 1);
  assert.ok(engine.pool.every(item => item.layer === "CONTEXT"));
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(count(), 1, "a complete permitted CONTEXT pool must not trigger requests for forbidden filler layers");
});

test("a semantic-change reason still calls through even when local candidates cover the axis territory", async () => {
  const { generator, count } = counter();
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 999 });
  await establishRemotePool(engine);
  assert.equal(count(), 1);
  // A different fixture kind (not just a re-tagged copy of the same acoustic snapshot) so the
  // exact-fingerprint cache -- an existing, unrelated mechanism -- does not itself explain a
  // skipped call; this isolates the axis-coverage gate as the only thing under test here.
  const coveredState = { ...profile("warm"), genreContextEvidence: { axisSignature: "nostalgia:2|warmth:2",
    candidates: [{ text: "따뜻한 아날로그 온기", category: "association", layer: "AESTHETIC", confidence: 0.6, weight: 0.6, source: "aesthetic-axis" }] } };
  // A genuine epoch change is a genre-specialization/variation opportunity, not just an
  // open-layer gap -- the axis-coverage gate must not suppress it.
  await engine.regenerate({ state: coveredState, sessionId: 1, epoch: 2 });
  assert.equal(engine.state.reason, "semantic-change");
  assert.equal(count(), 2);
});
