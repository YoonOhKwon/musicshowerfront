"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { StreamModelService } = require("../lib/streamModelService");
const { StreamModelEvidence } = require("../lib/streamModelEvidence");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const { StreamGenreFusion } = require("../lib/streamGenreFusion");
const Review = require("../lib/directAudioReview");

test("stream fusion retains independent open labels without treating its own output as classifier evidence", () => {
  const fusion = new StreamGenreFusion();
  fusion.ingest(Review.toObservations(Review.reviewCaption({ provider: "music-flamingo",
    observationId: "open-1", audioSegmentId: "segment-1",
    structuredPacket: { genreHypotheses: [{ label: "Aurora Breaks", confidence: 0.7 }] } })));
  const state = {};
  fusion.apply(state);
  const first = state.genre.confidence;
  for (let i = 0; i < 5; i++) fusion.apply(state);
  assert.equal(state.genre.primary, "Aurora Breaks");
  assert.equal(state.genre.confidence, first);
  const hypothesis = state.genreReasoning.hypotheses.find(item => item.genre === "Aurora Breaks");
  assert.ok(!hypothesis.independentEvidenceFamilies.includes("genreModel"));
  assert.equal(state.openWorldConcepts.length, 1);
});

test("bundled pretrained model runs on the server and preserves classifier provenance", { timeout: 60000 }, async t => {
  const service = new StreamModelService();
  t.after(() => service.close());
  const samples = Float32Array.from({ length: 33600 }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));
  const result = await service.infer({ samples, sampleRate: 16000 });
  assert.equal(result.genre.length, 400);
  assert.equal(result.instrument.length, 40);
  assert.equal(result.embedding.length, 1280);
  assert.ok(result.genre.every(Number.isFinite));
  const state = {};
  new StreamModelEvidence().apply(result, state, 3000);
  assert.equal(state.ml.model, "discogs-effnet-bsdynamic-1");
  assert.equal(state.ml.observations, 1);
  assert.ok(state.classifierGenre.confidence >= 0 && state.classifierGenre.confidence <= 1);
  assert.ok(state.instruments.every(item => item.source === "ml" && item.observationId === 1));
});

test("a delayed classifier result is discarded after a track change", async t => {
  let finish;
  const session = new RealtimeMusicSession({ streamId: "model-stale", send: () => {},
    inferModels: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => session.close());
  session.start();
  session.push(new Float32Array(3 * 16000).fill(0.2));
  session.playback({ type: "track_changed" });
  finish({ invalid: "should never be applied" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.state.ml, undefined);
  assert.equal(session.modelEvidence.observation, 0);
});
