"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const Review = require("../lib/directAudioReview");
const Realizer = require("../js/semantic/directAudioRealizer");
const { Reservoir } = require("../js/semantic/flamingoWordReservoir");

const names = "dreamcore weirdcore liminalcore nostalgiacore webcore cybercore glitchcore arcadecore angelcore fairycore oceancore spacecore auroracore cottagecore forestcore witchcore gothcore vampirecore ravecore voidcore".split(" ");
const packet = texts => ({ aestheticConcepts: texts.map(text => ({ text, confidence: 0.7, supportRefs: ["f1", "f2"] })) });

test("model-proposed core aesthetics survive review and the Korean display gate without a vocabulary registry", () => {
  const structuredPacket = packet([...names, "uncataloguedcore", "드림코어", "warm empty room", "score"]);
  const observations = Review.toObservations({ observationId: "core-review", structuredPacket });
  const reservoir = new Reservoir({ realizer: new Realizer.Realizer() });
  reservoir.ingestPacket(structuredPacket, { trackEpoch: 1, observationId: "core-review" });
  for (const name of [...names, "uncataloguedcore", "드림코어"]) {
    const item = observations.find(item => item.sourceText === name);
    assert.ok(item, name);
    assert.equal(item.layer, "AESTHETIC");
    assert.equal(item.requiresKoreanRealization, false, name);
    const candidate = reservoir.getCandidates().find(item => item.canonicalText === name);
    assert.equal(candidate.requiresKoreanRealization, false, name);
    assert.deepEqual(candidate.supportRefs, ["f1", "f2"]);
  }
  for (const name of ["warm empty room", "score"]) {
    assert.equal(reservoir.getCandidates().find(item => item.canonicalText === name).requiresKoreanRealization, true);
  }
  assert.equal(Realizer.isCoreAestheticName("dreamcore", "fact"), false);
  assert.deepEqual(new Reservoir().getCandidates(), [], "no audio concepts means no invented aesthetic list");
});

for (const tokenMode of ["free", "token"]) {
  test(`${tokenMode}: named aesthetics reach the final stream pool and survive surface expansion`, async t => {
    const calls = { realize: 0, translate: 0, associate: 0 };
    const messages = [];
    const session = new RealtimeMusicSession({ streamId: `core-${tokenMode}`, send: m => messages.push(m),
      analyze: async () => ({ observationId: "core-stream", structuredPacket: packet(["dreamcore", "weirdcore"]) }),
      realize: async () => { calls.realize++; return { realizationItems: [
        { text: "dreamcore", category: "association", family: ["몽환적인 미학"] },
        { text: "weirdcore", category: "association", family: ["낯설게 뒤틀린 미학"] }
      ] }; },
      translate: async () => { calls.translate++; return { translations: {} }; },
      associate: async () => { calls.associate++; return { accepted: [], proposed: 0 }; }
    });
    t.after(() => session.close());
    session.start({ tokenMode });
    session.push(Float32Array.from({ length: 16000 * 13 }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000)));
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    for (const name of ["dreamcore", "weirdcore"]) {
      const item = session.tokens.find(item => item.text === name);
      assert.ok(item, `${name} must enter the shared final PhrasePool in ${tokenMode} mode`);
      assert.equal(item.layer, "AESTHETIC");
      assert.equal(item.sourceFamily, "directAudio");
      const delivered = messages.filter(m => m.type === "word_pool").at(-1).tokens.find(item => item.text === name);
      assert.equal(delivered.textEn, name, "the published front3 token carries the English surface");
    }
    assert.ok(messages.some(m => m.type === "word_pool" && m.tokens.some(item => item.text === "dreamcore")));
    if (tokenMode === "free") assert.deepEqual(calls, { realize: 0, translate: 0, associate: 0 });
    else assert.equal(calls.realize, 1);
    session.playback({ type: "TRACK_CHANGED" });
    assert.equal(session.reservoir.getCandidates().some(item => /core$/.test(item.text)), false);
  });
}
