"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeLoopEvidence } = require("../lib/loopEvidence");
const Grounded = require("../lib/groundedAssociation");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");

const RATE = 16000;
const settle = () => new Promise(resolve => setImmediate(resolve));
function random(seed) {
  let state = seed;
  return () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

// A one-bar pattern (120 BPM) copied sample-exactly for 30 seconds, like a loop cut from a recording.
function loopedBar() {
  const rand = random(7);
  const bar = new Float32Array(RATE * 2);
  for (const [beat, pitch, length] of [[0, 60, 0.12], [0.5, 900, 0.05], [1, 60, 0.12], [1.5, 900, 0.05], [2.25, 300, 0.2], [3, 60, 0.12], [3.5, 1400, 0.08]]) {
    const start = Math.round(beat * RATE / 2);
    for (let i = 0; i < length * RATE; i++) {
      bar[start + i] += Math.sin(2 * Math.PI * pitch * i / RATE) * Math.exp(-i / (length * RATE / 4)) * 0.5 + (rand() - 0.5) * 0.05;
    }
  }
  const samples = new Float32Array(RATE * 30);
  for (let offset = 0; offset < samples.length; offset += bar.length) samples.set(bar.subarray(0, Math.min(bar.length, samples.length - offset)), offset);
  return samples;
}

// The same pulse, but every bar re-played with different notes, placement and dynamics.
function variedBars() {
  const rand = random(11);
  const samples = new Float32Array(RATE * 30);
  for (let beat = 0; beat < 60; beat++) {
    const start = Math.round((beat * 0.5 + (rand() - 0.5) * 0.06) * RATE);
    const pitch = 80 + rand() * 1500, length = 0.05 + rand() * 0.25, gain = 0.2 + rand() * 0.5;
    for (let i = 0; i < length * RATE && start + i < samples.length; i++) {
      if (start + i >= 0) samples[start + i] += Math.sin(2 * Math.PI * pitch * i / RATE) * Math.exp(-i / (length * RATE / 4)) * gain;
    }
  }
  return samples;
}

test("a sample-exact loop measures high bar repetition and a re-played groove measures low", () => {
  const loop = analyzeLoopEvidence(loopedBar(), RATE);
  const varied = analyzeLoopEvidence(variedBars(), RATE);
  assert.ok(loop.loopRepetition >= Grounded.LOOP_REPETITION, JSON.stringify(loop));
  assert.ok(Math.abs(loop.tempoBpm - 120) < 3 || Math.abs(loop.tempoBpm - 60) < 2, JSON.stringify(loop));
  assert.ok(varied.loopRepetition < Grounded.LOOP_REPETITION, JSON.stringify(varied));
  assert.ok(loop.loopRepetition - varied.loopRepetition > 0.4);
  assert.equal(analyzeLoopEvidence(new Float32Array(RATE / 4), RATE), null);
});

const answers = (sampled, loop) => [{ key: "sampled", answer: sampled, cue: `sampled ${sampled}` },
  { key: "loop", answer: loop, cue: `loop ${loop}` }];
const loopWindow = { loopRepetition: 0.85, sidechain: null, tempoBpm: 108 };
const variedWindow = { loopRepetition: 0.3, sidechain: null, tempoBpm: 108 };

test("production is corroborated only when forensic answers and measurements agree across captures", () => {
  const agreed = Grounded.productionConsensus({ forensics: [answers("yes", "yes"), answers("yes", "unsure")],
    measurements: [loopWindow, variedWindow, loopWindow] });
  assert.equal(agreed.answers.sampled.answer, "yes");
  assert.equal(agreed.answers.loop, undefined, "one yes and one unsure is not agreement");
  assert.equal(agreed.loop, "loop-like");
  assert.equal(agreed.corroborated, true);

  assert.equal(Grounded.productionConsensus({ forensics: [answers("yes", "yes")], measurements: [loopWindow, loopWindow] }).corroborated,
    false, "a single forensic listen is not a consensus");
  assert.equal(Grounded.productionConsensus({ forensics: [answers("yes", "yes"), answers("yes", "yes")], measurements: [loopWindow] }).corroborated,
    false, "a single measured window is not a consensus");
  const live = Grounded.productionConsensus({ forensics: [answers("no", "no"), answers("no", "no")], measurements: [variedWindow, variedWindow] });
  assert.equal(live.loop, "varied");
  assert.equal(live.corroborated, false);
});

test("corroborated production lifts a confident genre to the specific tier and appears as Q and M evidence", () => {
  const state = { genreReasoning: { hypotheses: [{ genre: "Genre A", semanticConfidence: 0.7, independentEvidenceCount: 1, temporalSupport: 1 }] } };
  const production = Grounded.productionConsensus({ forensics: [answers("yes", "yes"), answers("yes", "yes")],
    measurements: [loopWindow, loopWindow] });
  assert.equal(Grounded.resolutionTier(state).tier, "family");
  assert.equal(Grounded.resolutionTier(state, production).tier, "specific");
  const weak = { genreReasoning: { hypotheses: [{ genre: "Genre A", semanticConfidence: 0.45 }] } };
  assert.equal(Grounded.resolutionTier(weak, production).tier, "family", "production never substitutes for genre confidence");

  const evidence = Grounded.buildEvidence({ state, concepts: [], cues: [], production });
  const forensic = evidence.filter(item => item.kind === "forensic");
  assert.deepEqual(forensic.map(item => item.signature), ["forensic:sampled:yes", "forensic:loop:yes"]);
  assert.match(evidence.find(item => item.kind === "measurement").text, /loop repetition measured.*108 BPM/);
  const result = Grounded.validateAssociations({ items: [{ category: "era", ko: "원곡 시대", en: "source era",
    anchors: ["G1", forensic[0].id], specificity: "specific", confidence: 0.7 }] }, { evidence, tier: "specific" });
  assert.equal(result.accepted.length, 1, "forensic answers count as listening anchors");
});

function sessionWith({ forensics = () => [], associate }) {
  const calls = { analyze: [], associate: [] };
  const session = new RealtimeMusicSession({ streamId: "session-p", send: () => {}, forensicListening: true, englishBatchMs: 0,
    analyze: async capture => {
      calls.analyze.push(capture.listenDepth || "full");
      if (capture.listenDepth === "forensic") return { forensics: forensics(calls.analyze.length) };
      return { observationId: `o${calls.analyze.length}`, structuredPacket: {
        aestheticConcepts: [{ text: `concept ${calls.analyze.length}`, confidence: 0.8 }] } };
    },
    realize: async () => ({ realizationItems: [] }),
    associate: async request => { calls.associate.push(request); return associate ? associate(request) : { accepted: [], rejected: {}, proposed: 0 }; } });
  session.start({ tokenMode: "token" });
  return { session, calls };
}

test("each realized capture is followed by one forensic listen whose answers reach the association evidence", async t => {
  const { session, calls } = sessionWith({ forensics: () => answers("yes", "yes") });
  t.after(() => session.close());
  const tone = Float32Array.from({ length: RATE }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 440 / RATE));
  for (let i = 0; i < 13; i++) { session.push(tone); await settle(); }
  for (let i = 0; i < 8; i++) await settle();
  assert.deepEqual(calls.analyze, ["full", "forensic"]);
  assert.equal(session.association.forensicCalls, 1);
  assert.equal(session.association.measurements.length, 1);
  assert.equal(calls.associate.length, 1);
  const snapshot = session.associationSnapshot();
  assert.equal(snapshot.production.forensicCalls, 1);
  assert.ok(snapshot.production.lastMeasurement.tempoBpm > 0);
});

test("an association call is repeated only for new tiers, new consensus, or enough new listening evidence", () => {
  const { session } = sessionWith({});
  const association = session.association;
  const tier = "family", primary = { label: "Genre A" };
  const base = new Set(["flamingo:a", "flamingo:b", "styleCue:c"]);
  assert.equal(session.associationWanted({ tier, primary, signatures: base }), true, "first call");
  Object.assign(association, { lastSignatures: base, lastTier: tier, lastPrimary: "Genre A" });
  assert.equal(session.associationWanted({ tier, primary, signatures: new Set([...base, "flamingo:d", "flamingo:e"]) }), false);
  assert.equal(session.associationWanted({ tier, primary, signatures: new Set([...base, "flamingo:d", "flamingo:e", "flamingo:f"]) }), true);
  assert.equal(session.associationWanted({ tier, primary, signatures: new Set([...base, "forensic:sampled:yes"]) }), true);
  assert.equal(session.associationWanted({ tier: "specific", primary, signatures: base }), true);
  assert.equal(session.associationWanted({ tier, primary: { label: "Genre B" }, signatures: base }), true);
  session.close();
});

test("open processing and source-period answers are passed on as reported text, never as agreement", () => {
  const listen = period => [{ key: "sampled", answer: "yes", cue: "looped vocal sample" },
    { key: "sourcePeriod", answer: "unsure", cue: period }];
  const production = Grounded.productionConsensus({ forensics: [listen("sounds like the 1980s"), listen("an older lo-fi recording")],
    measurements: [] });
  assert.deepEqual(production.answers.sourcePeriod, { answer: "reported", captures: 2,
    cues: ["sounds like the 1980s", "an older lo-fi recording"] });
  assert.equal(production.corroborated, false, "no measurement agreement yet");
  const evidence = Grounded.buildEvidence({ production });
  assert.ok(evidence.some(item => item.signature === "forensic:sourcePeriod:reported" && /older lo-fi recording/.test(item.text)),
    "the latest description is carried into the prompt");
});

test("descriptive answers contradicted by the local measurement are dropped, explicit answers are kept", () => {
  const described = answer => [{ key: "sampled", answer, cue: "a sampled drum break", inferred: true },
    { key: "processing", answer: "unsure", cue: "filtered sampled loop" }];
  const explicit = answer => [{ key: "sampled", answer, cue: "no parts are taken from a recording" }];
  const performed = [variedWindow, variedWindow];
  const brass = Grounded.productionConsensus({ forensics: [explicit("no"), described("yes"), described("yes")], measurements: performed });
  assert.equal(brass.answers.sampled, undefined, "two inferred yes answers against a varied measurement are not agreement");
  assert.equal(brass.answers.processing, undefined, "open answers about source material need agreed sampling first");

  const loopTrack = Grounded.productionConsensus({ forensics: [described("yes"), described("yes")], measurements: [loopWindow, loopWindow] });
  assert.equal(loopTrack.answers.sampled.answer, "yes");
  assert.equal(loopTrack.corroborated, true);
  assert.equal(Grounded.productionConsensus({ forensics: [explicit("yes"), explicit("yes")], measurements: performed }).answers.sampled.answer,
    "yes", "an explicit answer is never overruled by the measurement");
});
