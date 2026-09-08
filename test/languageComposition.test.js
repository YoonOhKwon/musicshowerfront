const test = require("node:test");
const assert = require("node:assert/strict");
const Claims = require("../js/semantic/verifiedClaimStore");
const Firewall = require("../js/semantic/factFirewall");
const ContextFirewall = require("../js/semantic/contextFirewall");
const Live = require("../js/semantic/liveEventGrammar");
const Genome = require("../js/semantic/phraseGenome");
const Composition = require("../js/semantic/languageComposition");
const Critic = require("../js/semantic/languageCritic");
const Manager = require("../js/semantic/semanticFacetManager");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Knowledge = require("../js/semantic/knowledgeConsistencyValidator");
const Proposed = require("../js/semantic/proposedContextKnowledge");
const Coverage = require("../js/semantic/vocabularyCoverage");
const { profile } = require("./fixtures/languageProfiles");

test("Fact Firewall rejects an ontology FACT term that has no verified claim", () => {
  const store = Claims.collect({ rhythmicGrammar: {}, productionEvidence: {}, performance: {} });
  const hit = Firewall.inspect("워킹 베이스", store);
  assert.equal(hit.licensed, false);
  assert.equal(hit.reason, "UNLICENSED_FACT_TERM");
  const licensed = Claims.collect({
    performance: { walkingBassLikelihood: 0.86, soloInstrument: null }
  });
  assert.equal(Firewall.inspect("워킹 베이스", licensed).licensed, true);
});

test("critic rejects an unlicensed LLM FACT term when claims are attached", () => {
  const state = profile("futurefunk");
  const snapshot = Snapshot.serialize(state);
  const result = Critic.assess({
    text: "워킹 베이스", category: "performance", layer: "FACT", source: "llm",
    confidence: 0.9, anchors: ["performance.walkingBassLikelihood", "instrumentation.observed"]
  }, [], { snapshot });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.reasons.includes("UNLICENSED_FACT_TERM"));
});

test("high genre entropy and a thin margin suppress distant context", () => {
  const candidate = {
    text: "Chicago House 문화", category: "culture", relationFamily: "CULTURE",
    confidence: 0.8, anchors: ["rhythmicGrammar.fourOnFloor", "moodDimensions.arousal"]
  };
  const scattered = ContextFirewall.score(candidate, {
    genre: { primary: "House", confidence: 0.34, entropy: 0.88, margin: 0.06, uncertain: false },
    expressionFeatures: { observationSeconds: 40 }
  });
  assert.equal(scattered.pass, false);
  assert.ok(["genre-entropy-high", "genre-margin-low", "context-score-low"].includes(scattered.reason));

  const stable = ContextFirewall.score({
    text: "French House 계열", category: "lineage", relationFamily: "PARENT",
    confidence: 0.82, relationCompleteness: 0.8,
    anchors: ["primaryGenre", "productionEvidence.sampleBased", "rhythmicGrammar.fourOnFloor"]
  }, {
    genre: { primary: "Future Funk", confidence: 0.88, entropy: 0.32, margin: 0.4, stability: 0.7, uncertain: false },
    expressionFeatures: { observationSeconds: 30 }
  });
  assert.equal(stable.pass, true);
});

test("relational FACT remains local while local AESTHETIC/IMPRESSION stay empty", () => {
  const state = profile("futurefunk");
  const generated = Manager.base(state);
  assert.ok(state.composedFactCandidates.some(item => item.relationId === "vocal.synth.layer"
    || item.text === "보컬 중심의 신스층"));
  assert.equal(state.composedFactCandidates.some(item => /후렴|벌스|chorus|verse/i.test(item.text)), false);
  assert.equal(generated.some(item => ["AESTHETIC", "IMPRESSION"].includes(item.layer)), false);
  const accepted = Critic.rank(generated, {
    context: { snapshot: Snapshot.serialize(state), eligibleTexts: generated.map(item => item.text) },
    limit: 100
  }).selected;
  assert.ok(accepted.some(item => item.layer === "FACT" && item.source === "fact-composition"));
  assert.equal(accepted.some(item => ["AESTHETIC", "IMPRESSION"].includes(item.layer)), false);
});

test("LIVE requires a real delta and keeps realizations under one genome", () => {
  const silent = Live.realize({ expressionFeatures: { deltaEnergy: 0.01 } });
  assert.equal(silent.length, 0);
  const rising = Live.realize({ expressionFeatures: { deltaEnergy: 0.2 } });
  assert.ok(rising.some(item => item.concept === "ENERGY_RISE"));
  assert.equal(new Set(rising.filter(item => item.concept === "ENERGY_RISE").map(item => item.genome)).size, 1);
  const recent = rising.map(item => Genome.decorate(item));
  assert.ok(Genome.informationGain(rising[0], recent) < Genome.informationGain(rising[0], []));
});

test("same-genre fixtures still produce different FACT/AESTHETIC language", () => {
  const a = Manager.base(profile("futurefunk"));
  const b = Manager.base(profile("futurefunkb"));
  const texts = list => new Set(list.filter(item => ["FACT", "AESTHETIC"].includes(item.layer)).map(item => item.text));
  const left = texts(a), right = texts(b);
  const overlap = [...left].filter(text => right.has(text)).length;
  assert.ok(overlap / Math.max(1, Math.min(left.size, right.size)) <= 0.7,
    `same-genre FACT/AESTHETIC overlap too high: ${overlap}/${Math.min(left.size, right.size)}`);
  assert.ok([...left].some(text => !right.has(text)));
});

test("evidence capsule lists verified, distinctive, context and unsupported", () => {
  const capsule = profile("futurefunk").verifiedClaims.capsule;
  assert.ok(Array.isArray(capsule.verified) && capsule.verified.length > 0);
  assert.ok(capsule.unsupported.includes("walking_bass"));
  assert.ok(capsule.genre.primary === "Future Funk");
});

test("proposed context knowledge cannot become production context until approved", () => {
  const store = new Proposed.Store();
  store.propose({ source: "UK Garage", relation: "SCENE", target: "Imaginary Club Nation", reason: "llm idea" });
  assert.equal(store.approved().length, 0);
  assert.equal(store.proposed().length, 1);
  store.approve(item => item.target === "Imaginary Club Nation");
  assert.equal(store.approved().length, 1);
});

test("vocabulary coverage marks a sparse genome as a research target", () => {
  const coverage = Coverage.measure([
    { text: "디지털 노스탤지어 미학", genome: "AESTHETIC:FUSION:digital_nostalgia", layer: "AESTHETIC" },
    { text: "거친 암부 감성", genome: "AESTHETIC:SPATIALIZATION:industrial_void", layer: "AESTHETIC" }
  ]);
  assert.ok(coverage.sparse.some(item => item.genome.includes("digital_nostalgia")));
  assert.match(Coverage.researchPrompt(coverage), /Sparse semantic regions/);
});

test("knowledge validator flags a phrase that names a missing claim", () => {
  const issues = Knowledge.validateClaimArchitecture({
    factTerms: Firewall.TERMS,
    claims: [{ id: "C01", concept: "bright_timbre" }],
    phrases: [{ text: "사이드체인 향수", claimsUsed: ["C99"] }]
  });
  assert.ok(issues.some(item => item.code === "phrase-unknown-claim"));
  assert.equal(Knowledge.validateClaimArchitecture({ factTerms: Firewall.TERMS }).filter(item => item.severity === "error").length, 0);
});

test("composition planner only references collected claim ids", () => {
  const state = Composition.apply(profile("ambient"));
  const known = new Set(state.verifiedClaims.items.map(item => item.id));
  for (const item of state.languagePlan.compositions)
    assert.ok(item.claims.every(id => known.has(id)));
});
