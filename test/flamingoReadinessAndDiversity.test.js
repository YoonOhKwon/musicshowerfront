"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const { analyzeStreamAudio } = require("../lib/streamDeepAnalysis");
const Flamingo = require("../js/semantic/flamingoWordReservoir");

const tone = (seconds = 1) => Float32Array.from({ length: 16000 * seconds }, (_, i) =>
  0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));
const settle = () => new Promise(resolve => setImmediate(resolve));
const packet = {
  aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }],
  packetDiagnostics: { acceptedConceptCount: 1, duplicateOrRejectedCount: 2, quarantinedCount: 0,
    fieldCounts: { aestheticConcepts: 1 } }
};
const translation = { realizationItems: [{ text: "porous midnight glass", category: "association",
  family: ["다공성 심야 유리", "심야의 다공성 유리"] }] };
const flamingoError = code => Object.assign(new Error(code), { code });

function create(analyze) {
  const messages = [], captures = [];
  const session = new RealtimeMusicSession({ streamId: "session-d", send: message => messages.push(message),
    analyze: async capture => { captures.push(capture); return analyze(captures.length); },
    realize: async () => translation });
  session.start();
  return { session, messages, captures };
}

const lastAnalysis = messages => messages.filter(message => message.type === "word_pool").at(-1).analysis;

test("word_pool analysis reports track variety, the last Flamingo packet, and display repetition", async t => {
  const { session, messages } = create(() => ({ structuredPacket: packet, observationId: "capture-d" }));
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  const token = session.tokens.find(item => item.canonicalText === "porous midnight glass");
  session.noteUsed({ text: token.text, trackEpoch: session.trackEpoch });
  session.noteUsed({ text: token.text, trackEpoch: session.trackEpoch });
  session.publish(true);
  const { diversity } = lastAnalysis(messages);
  assert.ok(diversity.conceptsSeen >= session.tokens.length);
  assert.ok(diversity.layers.AESTHETIC >= 1);
  assert.ok(diversity.flamingoTokens >= 1);
  assert.equal(diversity.flamingoCategories.association, 1);
  assert.deepEqual(diversity.lastPacket, { accepted: 1, rejected: 2, quarantined: 0, fields: { aestheticConcepts: 1 } });
  assert.equal(diversity.shownLastMinute, 2);
  assert.equal(diversity.repeatShareLastMinute, 0.5);
});

test("a loading Flamingo model is reported by code and the capture is retried shortly", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, messages, captures } = create(call => {
    if (call === 1) throw flamingoError("FLAMINGO_LOADING");
    return { structuredPacket: packet, observationId: "capture-retry" };
  });
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  assert.equal(captures.length, 1);
  assert.equal(lastAnalysis(messages).error.code, "FLAMINGO_LOADING");
  assert.equal(session.status, "degraded");

  t.mock.timers.tick(10000);
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(captures.length, 2);
  assert.equal(captures[1].firstImpression, true);
  assert.equal(session.lastError, null);
  assert.ok(session.tokens.some(item => item.sourceFamily === "directAudio"));
});

test("an ordinary inference failure waits for the normal cadence instead of retrying", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, captures } = create(() => { throw new Error("Flamingo HTTP 500"); });
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(captures.length, 1);
  assert.equal(session.retryTimer, null);
});

test("analyzeStreamAudio names a refused connection and a loading model instead of 'fetch failed'", async t => {
  const call = () => analyzeStreamAudio({ samples: tone(1), sampleRate: 16000, sessionId: "s", trackEpoch: 1,
    requestId: "r", segmentId: 1, activeAudioMs: 1000, firstImpression: false, signal: new AbortController().signal });
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(call(), { code: "FLAMINGO_OFFLINE" });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "loading" }), { status: 503 }));
  await assert.rejects(call(), { code: "FLAMINGO_LOADING" });
});

test("model-written audible categories are routed onto display facets instead of being dropped", () => {
  assert.equal(Flamingo.factFacetFor("harmony"), "arrangement");
  assert.equal(Flamingo.factFacetFor("bass motion"), "instrumentation");
  assert.equal(Flamingo.factFacetFor("drums"), "rhythm");
  assert.equal(Flamingo.factFacetFor("vocal performance"), "performance");
  assert.equal(Flamingo.factFacetFor("mood"), null);

  const reservoir = new Flamingo.Reservoir({ trackEpoch: 1 });
  reservoir.ingestPacket({ audibleObservations: [
    { text: "major key chord progression", category: "harmony", confidence: 0.8 },
    { text: "walking bass line", category: "bass motion", confidence: 0.8 },
    { text: "wistful mood", category: "mood", confidence: 0.8 }
  ] }, { trackEpoch: 1, observationId: "o1", audioSegmentId: "1", listeningMode: "blind" });
  const categories = [...reservoir.conceptRegistry.values()].map(entry => entry.category).sort();
  assert.deepEqual(categories, ["arrangement", "instrumentation"]);
});
