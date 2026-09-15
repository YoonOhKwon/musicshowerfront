"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const settle = () => new Promise(resolve => setImmediate(resolve));
const tone = () => Float32Array.from({ length: 16000 * 13 }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));

function setup(t) {
  const calls = { realize: 0, translate: 0, associate: 0, analyze: 0 }, messages = [];
  const session = new RealtimeMusicSession({ streamId: "cost-test", send: m => messages.push(m),
    forensicListening: true, englishBatchMs: 0, associationsOnScreen: true,
    analyze: async () => { calls.analyze++; return { observationId: `a-${calls.analyze}`,
      structuredPacket: { aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }] } }; },
    realize: async () => { calls.realize++; return { realizationItems: [{ text: "porous midnight glass",
      category: "association", family: ["다공성 심야 유리"] }] }; },
    translate: async () => { calls.translate++; return { translations: {} }; },
    associate: async () => { calls.associate++; return { accepted: [], proposed: 0 }; } });
  t.after(() => session.close());
  return { session, calls, messages };
}

test("default free mode keeps Flamingo concepts but never invokes any OpenAI hook", async t => {
  const { session, calls, messages } = setup(t);
  session.start();
  session.setWordLanguage("en");
  session.push(tone());
  for (let i = 0; i < 5; i++) await settle();
  session.requestAssociation(); session.requestEnglish(session.tokens); session.flushEnglish();
  await settle();
  assert.deepEqual(calls, { analyze: 1, realize: 0, translate: 0, associate: 0 });
  assert.ok(session.tokens.some(item => item.canonicalText === "porous midnight glass" && item.layer === "AESTHETIC"));
  const pool = messages.filter(m => m.type === "word_pool").at(-1);
  assert.equal(pool.analysis.tokenMode, "free");
  assert.equal(pool.analysis.openAIEnabled, false);
  assert.ok(pool.tokens.some(item => item.textEn === "porous midnight glass"));
  session.playback({ type: "RESTART" });
  session.playback({ type: "TRACK_CHANGED" });
  assert.equal(session.tokenMode, "free");
});

test("explicit token mode preserves paid realization, English and association paths", async t => {
  const { session, calls } = setup(t);
  session.start({ tokenMode: "token" });
  session.setWordLanguage("en");
  session.push(tone());
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(calls.realize, 1);
  assert.ok(calls.translate > 0);
  assert.equal(calls.associate, 1);
  assert.equal(calls.analyze, 2);
});

test("invalid modes fail closed; mode cannot be changed inside an existing connection", t => {
  const { session, messages } = setup(t);
  session.start({ tokenMode: "typo" });
  assert.equal(session.started, false);
  session.start();
  session.start({ tokenMode: "token" });
  assert.equal(session.tokenMode, "free");
  assert.equal(messages.at(-1).code, "TOKEN_MODE_LOCKED");
});
