"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const { measureFrame } = require("../lib/streamMeasurements");
const { pcmToWav } = require("../lib/streamDeepAnalysis");

const tone = (seconds = 1) => Float32Array.from({ length: 16000 * seconds }, (_, i) =>
  0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));
const settle = () => new Promise(resolve => setImmediate(resolve));
const packet = { aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }] };
const translation = { realizationItems: [{ text: "porous midnight glass", category: "association",
  family: ["다공성 심야 유리", "심야의 다공성 유리"] }] };

function create(options = {}) {
  const messages = [], captures = [];
  const session = new RealtimeMusicSession({ streamId: "session-a", send: message => messages.push(message),
    analyze: async capture => { captures.push(capture); return { structuredPacket: packet, observationId: "capture-a" }; },
    realize: async () => translation, ...options });
  session.start({ tokenMode: "token" });
  return { session, messages, captures };
}

test("PCM -> independent Flamingo -> Korean realization -> shared final PhrasePool", async t => {
  const { session, messages, captures } = create();
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].firstImpression, true);
  assert.ok(captures[0].samples.length <= 16000 * 13);
  assert.ok(messages.some(message => message.type === "word_pool" && message.tokens.some(item =>
    item.text === "다공성 심야 유리" && item.layer === "AESTHETIC" && item.sourceFamily === "directAudio")));
  const latest = messages.filter(m => m.type === "word_pool").at(-1);
  assert.deepEqual(latest.tokens.map(item => item.text), session.pool.snapshot().map(item => item.text));
  assert.equal(latest.poolSource, "music-shower-final");
  const first = session.tokens.find(item => item.canonicalText === "porous midnight glass");
  session.noteUsed({ text: first.text, trackEpoch: session.trackEpoch });
  await settle();
  assert.notEqual(session.tokens.find(item => item.canonicalText === first.canonicalText).text, first.text);
});

test("pause and silence preserve pool and clock; restart preserves concepts; new track clears them", async t => {
  const { session, captures } = create();
  t.after(() => session.close());
  session.playback({ type: "playback", event: { type: "TRACK", identity: "song-a" } });
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  const pool = session.tokens.map(item => item.text), elapsed = session.activeAudioMs;
  session.playback({ type: "playback", event: { type: "PAUSE" } });
  for (let i = 0; i < 15; i++) session.push(tone());
  assert.equal(session.activeAudioMs, elapsed);
  assert.deepEqual(session.tokens.map(item => item.text), pool);
  session.playback({ type: "playback", event: { type: "PLAY" } });
  for (let i = 0; i < 60; i++) session.push(new Float32Array(16000));
  assert.equal(session.trackEpoch, 1);
  assert.equal(captures.length, 1);
  session.playback({ type: "playback", event: { type: "RESTART" } });
  assert.equal(session.activeAudioMs, 0);
  assert.equal(session.buffer.seconds(), 0);
  assert.equal(session.reservoir.conceptRegistry.size, 1);
  session.playback({ type: "playback", event: { type: "TRACK", identity: "song-b" } });
  assert.equal(session.trackEpoch, 2);
  assert.equal(session.reservoir.conceptRegistry.size, 0);
  assert.deepEqual(session.tokens, []);
});

test("late Flamingo response cannot populate a different track, even if provider ignores abort", async t => {
  let finish;
  const { session, messages } = create({ analyze: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => session.close());
  session.push(tone(13)); await settle();
  session.playback({ type: "track_changed" });
  const boundary = messages.length;
  finish({ structuredPacket: packet, observationId: "old" }); await settle();
  assert.equal(session.reservoir.conceptRegistry.size, 0);
  assert.equal(messages.slice(boundary).some(m => m.tokens?.length), false);
});

test("late projection during a long pause preserves concepts and restart does not lose pause accounting", async t => {
  const { session } = create();
  t.after(() => session.close());
  session.push(tone(13)); await settle(); await settle();
  session.playback({ type: "playback", event: { type: "PAUSE" } });
  const elapsed = session.reservoir.effectiveConceptTtlMs + 60000;
  const entry = [...session.reservoir.conceptRegistry.values()][0];
  entry.addedAt -= elapsed; entry.lastSeenAt -= elapsed; session.silentAt -= elapsed;
  await session.project();
  assert.equal(session.reservoir.conceptRegistry.size, 1);
  assert.ok(session.tokens.some(item => item.layer === "AESTHETIC"));
  entry.addedAt -= elapsed; entry.lastSeenAt -= elapsed; session.silentAt -= elapsed;
  session.playback({ type: "playback", event: { type: "RESTART" } });
  await session.project();
  assert.equal(session.reservoir.conceptRegistry.size, 1);
});

test("slow inference queues only the latest 30-second window; failures leave local final pool usable", async t => {
  let reject;
  const { session } = create({ analyze: () => new Promise((_, fail) => { reject = fail; }) });
  t.after(() => session.close());
  for (let i = 0; i < 110; i++) { session.push(tone()); await settle(); }
  assert.equal(session.scheduler.pending.length, 1);
  assert.equal(session.scheduler.pending[0].samples.length, 30 * 16000);
  assert.equal(session.scheduler.pending[0].firstImpression, false);
  session.scheduler.pending = [];
  reject(new Error("test offline")); await settle();
  assert.equal(session.status, "degraded");
  assert.ok(session.tokens.length);
  assert.equal(session.tokens.some(item => ["AESTHETIC", "IMPRESSION"].includes(item.layer)), false);
});

test("realtime session loads the acoustic lexicon so local FACT idioms can fire without genre", () => {
  const { session } = create();
  const acoustic = session.idioms.lexicon.entries.filter(entry => entry.kind === "ACOUSTIC_MATERIAL");
  assert.ok(acoustic.length >= 20, "server session must not start with an empty idiom lexicon");
  const house = session.idioms.evaluate({
    pulse: { kickPeriodicity: 0.86 },
    production: { pumpingLikelihood: 0.8 }
  }, { primary: null, uncertain: true, confidence: 0.1 });
  assert.ok(house.some(item => item.text === "펌핑 그루브" && item.kind === "ACOUSTIC_MATERIAL"));
  assert.equal(house.some(item => /Chicago|UK Garage|House-style/i.test(item.text)), false);
  session.close();
});

test("raw samples are validated and FFT measures frequency without using visual effect values", () => {
  const measurement = measureFrame(tone(), 16000);
  assert.ok(Math.abs(measurement.centroid - 440) < 5);
  assert.ok(Math.abs(measurement.rms - Math.sqrt(0.02)) < 0.001);
  assert.ok(measurement.mid > 0.99);
  const wav = pcmToWav(new Float32Array([-1, 0, 1]), 16000);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readInt16LE(44), -32768);
  assert.equal(wav.readInt16LE(48), 32767);
  const { session } = create();
  session.push(new Float32Array([NaN, Infinity]));
  assert.equal(session.activeAudioMs, 0);
  session.close();
});
