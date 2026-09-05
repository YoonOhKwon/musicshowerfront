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

test("a routine pool-low top-up skips the remote call when local candidates already cover the current axis territory", async () => {
  const { generator, count } = counter();
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 999 });
  await establishRemotePool(engine);
  assert.equal(count(), 1);
  const coveredState = { ...profile(), genreContextEvidence: { axisSignature: "nostalgia:2|warmth:2",
    candidates: [{ text: "따뜻한 아날로그 온기", category: "association", layer: "AESTHETIC", confidence: 0.6, weight: 0.6, source: "aesthetic-axis" }] } };
  await engine.regenerate({ state: coveredState, sessionId: 1, epoch: 1 });
  assert.equal(engine.state.reason, "pool-low", "the second call must actually be the routine top-up case this gate targets");
  assert.equal(count(), 1, "local open-layer coverage for this axis territory means no fresh remote call is needed");
});

test("without local open-layer coverage for the current axis territory, a pool-low top-up still calls through as before", async () => {
  const { generator, count } = counter();
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 999 });
  await establishRemotePool(engine);
  assert.equal(count(), 1);
  const uncoveredState = { ...profile(), genreContextEvidence: { axisSignature: "nostalgia:2|warmth:2", candidates: [] } };
  await engine.regenerate({ state: uncoveredState, sessionId: 1, epoch: 1 });
  assert.equal(engine.state.reason, "pool-low");
  assert.equal(count(), 2, "no local open-layer coverage and no prior cache hit means the call still goes through");
});

test("without an axis signature at all (axis engine not wired), behavior is unaffected -- still calls through on pool-low", async () => {
  const { generator, count } = counter();
  const engine = new PhrasePool.Engine({ generator, poolSize: 40, minimumIntervalMs: 0, stableDelayMs: 0, lowWatermark: 999 });
  await establishRemotePool(engine);
  assert.equal(count(), 1);
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(engine.state.reason, "pool-low");
  assert.equal(count(), 2);
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
