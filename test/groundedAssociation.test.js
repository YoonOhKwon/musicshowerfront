"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Grounded = require("../lib/groundedAssociation");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");

const tone = (seconds = 1) => Float32Array.from({ length: 16000 * seconds }, (_, i) =>
  0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));
const settle = () => new Promise(resolve => setImmediate(resolve));

const stateWith = (confidence, extra = {}) => ({ genreReasoning: { hypotheses: [{ genre: "Genre A",
  semanticConfidence: confidence, independentEvidenceCount: 1, temporalSupport: 1, ...extra }] } });

test("resolution tier follows genre confidence and corroboration, never a genre name", () => {
  assert.equal(Grounded.resolutionTier({}).tier, "broad");
  assert.equal(Grounded.resolutionTier(stateWith(0.2)).tier, "broad");
  assert.equal(Grounded.resolutionTier(stateWith(0.5)).tier, "family");
  assert.equal(Grounded.resolutionTier(stateWith(0.8)).tier, "family", "one uncorroborated listener stays family");
  assert.equal(Grounded.resolutionTier(stateWith(0.8, { independentEvidenceCount: 2 })).tier, "specific");
  assert.equal(Grounded.resolutionTier(stateWith(0.6, { temporalSupport: 3 })).tier, "specific");
});

const evidence = [
  { id: "G1", kind: "genre", text: "Genre A", confidence: 0.7 },
  { id: "K1", kind: "classifier", text: "Genre B", confidence: 0.2 },
  { id: "F1", kind: "flamingo", text: "bright synth brass", confidence: 0.7 },
  { id: "C1", kind: "styleCue", text: "chopped vocal sample", confidence: 0.6 }
];
const item = (overrides = {}) => ({ category: "culture", ko: "문화 단어", en: "culture word",
  anchors: ["G1", "C1"], confidence: 0.7, specificity: "family", ...overrides });

test("associations without valid listening and genre anchors are rejected and counted", () => {
  const result = Grounded.validateAssociations({ items: [
    item(),
    item({ ko: "없는 근거", en: "missing anchor", anchors: ["G1", "F9"] }),
    item({ ko: "장르만", en: "genre only", anchors: ["G1"] }),
    item({ ko: "약한 장르", en: "weak genre", anchors: ["K1", "F1"] }),
    item({ category: "imagery", ko: "빛나는 밤", en: "glowing night", anchors: ["F1"] }),
    item({ category: "era", ko: "과한 구체", en: "too specific", specificity: "specific" }),
    item({ ko: "문화 단어", en: "culture word again" })
  ] }, { evidence, tier: "family" });
  assert.deepEqual(result.accepted.map(entry => entry.text), ["문화 단어", "빛나는 밤"]);
  assert.deepEqual(result.rejected, { "invalid-anchor": 1, "no-listening-anchor": 1, "no-genre-anchor": 1,
    "over-specific": 1, duplicate: 1 });
  assert.deepEqual(result.accepted[0].anchors.map(anchor => anchor.text), ["Genre A", "chopped vocal sample"]);
});

test("the broad tier admits no culture or era at all", () => {
  const result = Grounded.validateAssociations({ items: [item(), item({ category: "aesthetic", ko: "미학", en: "aesthetic",
    anchors: ["F1"], specificity: "broad" })] }, { evidence, tier: "broad" });
  assert.deepEqual(result.accepted.map(entry => entry.category), ["aesthetic"]);
  assert.equal(result.rejected["tier-category"], 1);
});

test("the association prompt describes structure only and carries evidence ids and already shown words", () => {
  const prompt = Grounded.buildAssociationPrompt({ evidence, tier: "specific", alreadyShown: ["이미 나온 말"] });
  assert.match(prompt, /Resolution tier: specific/);
  assert.match(prompt, /"id":"C1","kind":"styleCue"/);
  assert.match(prompt, /이미 나온 말/);
  assert.match(prompt, /Do not claim a place, date, work, artist, franchise, or sample source/);
});

test("a realized capture triggers one validated association call whose words reach the inspector only", async t => {
  const calls = [];
  const session = new RealtimeMusicSession({ streamId: "session-g", send: () => {},
    analyze: async () => ({ observationId: "capture-g", structuredPacket: {
      aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }],
      styleCues: [{ id: "c1", text: "tape hiss on drums", confidence: 0.7 }] } }),
    realize: async () => ({ realizationItems: [{ text: "porous midnight glass", category: "association",
      family: ["다공성 심야 유리"] }] }),
    associate: async request => {
      calls.push(request);
      const listening = request.evidence.find(entry => entry.kind === "styleCue");
      return Grounded.validateAssociations({ items: [{ category: "imagery", ko: "테이프 먼지", en: "tape dust",
        anchors: [listening.id], specificity: "broad", confidence: 0.6 }] }, request);
    } });
  const messages = [];
  session.send = message => messages.push(message);
  session.start();
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  for (let i = 0; i < 6; i++) await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, "broad");
  assert.ok(calls[0].evidence.some(entry => entry.text === "tape hiss on drums"));
  const association = messages.filter(message => message.type === "word_pool").at(-1).analysis.association;
  assert.deepEqual(association.items.map(entry => [entry.category, entry.text, entry.textEn]), [["imagery", "테이프 먼지", "tape dust"]]);
  assert.deepEqual(association.styleCues, ["tape hiss on drums"]);
  assert.equal(session.tokens.some(token => token.text === "테이프 먼지"), false, "stage 2 stays out of the screen pool");

  session.publish(true);
  await settle();
  assert.equal(calls.length, 1, "unchanged evidence does not call again");
});

const Facets = require("../js/semantic/semanticFacets");
const Manager = require("../js/semantic/semanticFacetManager");

test("the ownership gate admits grounded association only on CONTEXT/AESTHETIC with cited evidence", () => {
  const grounded = Grounded.toCandidate({ category: "imagery", text: "이미지 단어", textEn: "image word",
    anchors: [{ id: "F1", kind: "flamingo", text: "heard concept" }], genreConfidence: 0.7, confidence: 0.7, specificity: "family" });
  assert.equal(grounded.layer, "AESTHETIC");
  assert.equal(Manager.ownershipAllowed(grounded), true);
  assert.equal(Manager.ownershipAllowed({ ...grounded, associationAnchors: [] }), false, "no evidence, no display");
  assert.equal(Manager.ownershipAllowed({ ...grounded, layer: "FACT" }), false, "never a measured fact");
  assert.equal(Manager.ownershipAllowed({ ...grounded, sourceFamily: "llm", source: "llm" }), false,
    "the ungrounded general pool still cannot write imagery or aesthetics");
  assert.ok(Facets.names.includes("imagery"));
});

test("with associations on screen, grounded words join the pool with category and English, and stock imagery needs a confident genre", async t => {
  const session = new RealtimeMusicSession({ streamId: "session-screen", send: () => {}, associationsOnScreen: true,
    analyze: async () => ({ observationId: "o", structuredPacket: { aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }] } }),
    realize: async () => ({ realizationItems: [{ text: "porous midnight glass", category: "association", family: ["다공성 심야 유리"] }] }) });
  session.start();
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  for (let i = 0; i < 5; i++) await settle();
  const listening = [{ id: "F1", kind: "flamingo", text: "porous midnight glass" }];
  const genre = [{ id: "G1", kind: "genre", text: "Genre A" }];
  session.state.genreReasoning = { hypotheses: [{ genre: "Genre A", semanticConfidence: 0.7 }] };
  session.association.items = [
    { category: "culture", text: "문화 단어", textEn: "culture word", anchors: [...genre, ...listening], genreConfidence: 0.7, confidence: 0.7, specificity: "family" },
    { category: "imagery", text: "네온 불빛", textEn: "neon glow", anchors: listening, genreConfidence: 0.8, confidence: 0.7, specificity: "specific" },
    { category: "imagery", text: "네온 간판", textEn: "neon signs", anchors: listening, genreConfidence: 0.3, confidence: 0.7, specificity: "family" },
    { category: "aesthetic", text: "넓은 단어", textEn: "broad word", anchors: listening, genreConfidence: 0, confidence: 0.7, specificity: "broad" },
    { category: "era", text: "지난 장르 시대", textEn: "old genre era", anchors: [{ id: "G2", kind: "genre", text: "Genre Old" }, ...listening],
      genreConfidence: 0.7, confidence: 0.7, specificity: "family" }
  ];
  await session.project();
  session.publish(true);
  const grounded = session.tokens.filter(token => token.sourceFamily === "groundedAssociation");
  assert.deepEqual(grounded.map(token => token.text).sort(), ["네온 불빛", "문화 단어"]);
  const imagery = grounded.find(token => token.text === "네온 불빛");
  assert.equal(imagery.layer, "AESTHETIC");
  assert.equal(imagery.textEn, "neon glow");
});
