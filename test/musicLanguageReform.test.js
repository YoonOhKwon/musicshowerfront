const test = require("node:test");
const assert = require("node:assert/strict");
const Facets = require("../js/semantic/semanticFacets");
const approvedCoreTerms = require("../data/approvedCoreTerms.json");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const Grammar = require("../js/semantic/rhythmicGrammar");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Reservoir = require("../js/semantic/candidateReservoir");
const Quality = require("../js/semantic/phraseQuality");
const Critic = require("../js/semantic/languageCritic");
const Selection = require("../js/visual/phraseSelection");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { createLanguageRequest } = require("../lib/languageService");
const { profile, RICH_KINDS } = require("./fixtures/languageProfiles");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");

const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
// The same sampling `scripts/knowledge-coverage.cjs` uses -- kept identical so `npm run check`
// (this file) and the standalone coverage script can never disagree about which primitives are
// DECLARED_ONLY (section 16's CI/coverage-report consistency bug).
const primitiveSamples = [...RICH_KINDS, "cold", "warm", "jazz"].map(kind => Primitives.analyze(profile(kind)));
const primitiveClassification = Validator.classifyPrimitives(Primitives.schema(), primitiveSamples);

test("Primitive V2 exposes the requested musical domains without fabricating unavailable detectors", () => {
  const schema = Primitives.schema();
  for (const group of ["pulse", "harmony", "melody", "bass", "texture", "role", "articulation", "production", "arrangement"])
    assert.ok(schema[group]?.length, group);
  const empty = Primitives.analyze({});
  for (const path of ["pulse.microTimingDeviation", "pulse.snarePeriodicity", "harmony.modalMixture",
    "melody.sequenceLikelihood", "articulation.vibratoLikelihood", "production.stereoWidth"])
    assert.equal(path.split(".").reduce((value, key) => value[key], empty), null, path);
  assert.equal(empty.meta["melody.sequenceLikelihood"].available, false);
  assert.ok(Object.values(schema).flat().length >= 150);
});

test("compiled idiom knowledge is a growing evidence graph, not a string bag", () => {
  assert.ok(engine.graph.stats.nodes >= 300 && engine.graph.stats.nodes <= 2000, engine.graph.stats.nodes);
  assert.ok(engine.graph.stats.nodeTypes.primitive >= 150);
  assert.ok(engine.graph.stats.nodeTypes.idiom >= 150, engine.graph.stats.nodeTypes.idiom);
  for (const edge of ["required-evidence", "supporting-evidence", "contradicting-evidence", "context-specializes", "realizes"])
    assert.ok(engine.graph.stats.edgeTypes[edge] > 0, edge);
});

test("the same shuffled primitive names the same FACT regardless of genre label", () => {
  const value = Primitives.empty();
  Object.assign(value.pulse, { shuffleStrength: .78, metricStability: .72, pulsePresence: .75 });
  const texts = genre => engine.evaluate(value, genre).map(item => item.text).sort();
  assert.deepEqual(texts({ primary: "UK Garage", confidence: .82 }), texts({ primary: "Jazz", confidence: .82 }));
  assert.ok(texts({ primary: "Jazz", confidence: .82 }).includes("셔플 그루브"));
  assert.ok(!engine.evaluate(Primitives.empty(), { primary: "UK Garage", confidence: .99 }).some(item => item.text === "2-Step 스윙"));
  assert.ok(!engine.evaluate(Primitives.empty(), { primary: "Jazz", confidence: .99 }).some(item => item.text === "스윙 그루브"));
});

test("IMPRESSION has no local vocabulary left to synthesize from", () => {
  // impressionSynthesizer.js held 53 hand-authored Korean impression phrases, fired by feature
  // thresholds. IMPRESSION belongs to Music Flamingo's direct listening, so the module is gone
  // and the pipeline no longer produces the layer locally at all.
  assert.throws(() => require("../js/semantic/impressionSynthesizer"), /Cannot find module/);
  const state = profile("futurefunk");
  Pipeline.populate(state, {});
  assert.deepEqual(state.impressionConcepts, []);
  assert.deepEqual(state.impressionFacetCandidates, []);
});

test("knowledge validator catches the historic sampleBased mismatch and accepts the repaired pipeline", () => {
  const impossible = Validator.validateDetectorRules(
    [{ id: "old-sample-rule", path: "productionEvidence.sampleBased", min: .75 }],
    { "productionEvidence.sampleBased": { min: 0, max: .72 } });
  assert.ok(impossible.some(item => item.code === "unreachable-detector-rule"));
  const missing = Validator.validate({ lexicon: { entries: [{ id: "broken", facet: "rhythm", neutralText: "오류",
    required: [{ path: "pulse.doesNotExist", min: .5 }], anchors: ["pulse.doesNotExist"] }] },
    primitiveSchema: Primitives.schema() });
  assert.equal(missing.ok, false);
  const current = Validator.validate({ lexicon, primitiveSchema: Primitives.schema(), graph: engine.graph,
    detectorRules: Pipeline.productionRules, detectorCapabilities: Grammar.detectorCapabilities,
    primitiveClassification, impressionRules: [], directConsumerPaths: Pipeline.primitiveConsumerPaths });
  assert.equal(current.ok, true);
  assert.equal(Grammar.detectorCapabilities["productionEvidence.sampleBased"].max, .9);
  // The exact warning families `scripts/knowledge-coverage.cjs` reports must also be visible from
  // plain `npm run check` -- CI and the standalone coverage report must never disagree. Both now
  // read `warningsByCode`, which spans every non-error tier, so a family cannot hide from one
  // consumer by sitting in a severity the other happens not to look at.
  const byCode = current.warningsByCode;
  // `harmony.majorMinorLikelihood` has no language consumer and deliberately never gets one.
  // harmonicMotionEngine computes majorShare/minorShare once and exposes them two ways: as this
  // raw pair, and as the `harmony.modality` decision (`majorShare >= minorShare ? "major" :
  // "minor"`). It is the same quantity in two forms, and the decided form is what the language
  // reads -- harmony_major_tendency and harmony_minor_tendency both fire off `harmony.modality`.
  // So this is an intermediate that happens to be exposed, not an unspoken fact: an idiom here
  // would say what those two already say, from the same measurement, and compete with them in
  // selection. Pinned by name so any OTHER primitive losing its consumer still fails this test.
  const orphans = (current.warningsByCode["unused-primitive"] || 0);
  const orphanPaths = [...new Set((current.warnings || []).filter(item => item.code === "unused-primitive")
    .map(item => item.path))];
  assert.deepEqual(orphanPaths, ["harmony.majorMinorLikelihood"],
    `only the known exposed-intermediate may lack a consumer; got ${JSON.stringify(orphanPaths)}`);
  assert.ok(orphans > 0 === orphanPaths.length > 0);
  // The guarantee that makes the above safe: the DECIDED form really is consumed, so removing
  // the local impression vocabulary cost major/minor no expressiveness at all.
  const spokenByIdiom = new Set(engine.graph.edges
    .filter(edge => edge.from === "primitive:harmony.modality").map(edge => edge.to));
  assert.ok(spokenByIdiom.size >= 2,
    "major/minor must still be sayable locally through harmony.modality's own idioms");
  // A dead idiom is a HIGH warning, so a check that only read `warnings` would report zero while
  // the real problem was still there. Whatever the count is, the two views must agree.
  assert.equal(current.warnings.filter(item => item.code === "idiom-requires-declared-only").length, 0);
  assert.equal(current.highWarnings.filter(item => item.code === "idiom-requires-declared-only").length,
    byCode["idiom-requires-declared-only"] || 0);
  // Knowledge parked as dormant must remain visible rather than disappearing from the report.
  assert.ok(byCode["dormant-idiom"] > 0, "dormant knowledge must stay visible in the report");
  const { error, high, warning, info } = current.countsBySeverity;
  assert.equal(error, 0);
  assert.equal(error + high + warning + info, current.issues.length);
});

test("creative reservoir expires stale phrases and rejects an old semantic epoch", () => {
  const reservoir = new Reservoir.Reservoir({ capacity: 20 });
  reservoir.replace([{ text: "들뜬 애상", confidence: .8, semanticFamily: "bittersweet", ttlMs: 2000 }], { epoch: 4, at: 1000 });
  assert.equal(reservoir.snapshot({ epoch: 3, at: 1100 }).length, 0);
  assert.equal(reservoir.snapshot({ epoch: 4, at: 1100 })[0].source, "remote-generative");
  assert.equal(reservoir.snapshot({ epoch: 4, at: 3001 }).length, 0);
  const base = { text: "들뜬 애상", category: "mood", layer: "IMPRESSION", source: "remote-generative",
    confidence: .8, groundingScore: .8, contextRelevance: .8, evidenceScore: .8 };
  assert.ok(Selection.weight({ ...base, freshness: 1 }, [], { observationSeconds: 30 }) >
    Selection.weight({ ...base, freshness: .05 }, [], { observationSeconds: 30 }));
});

test("semantic-family cooldown is stronger for repeated AI-aesthetic cliché families", () => {
  const candidate = { text: "잔향의 후광", category: "mood", layer: "IMPRESSION", confidence: .8,
    evidenceScore: .8, source: "llm", anchors: ["space.spaciousness", "production.reverb"] };
  const unrelated = { text: "워킹 베이스", category: "performance", layer: "FACT", confidence: .8,
    evidenceScore: .8, source: "idiom" };
  assert.match(Quality.semanticFamily(candidate), /^cluster:/,
    "cooldown identity is a lexical cluster, not a developer-named aesthetic family");
  const repeated = Selection.weight(candidate, [candidate], { observationSeconds: 30 });
  const fresh = Selection.weight(candidate, [unrelated], { observationSeconds: 30 });
  assert.ok(repeated < fresh * .5);
  const ambient = Snapshot.serialize(profile("ambient"));
  const cliché = Critic.assess({ text: "몽환적", category: "mood", layer: "IMPRESSION", source: "llm",
    confidence: .9, anchors: ["moodDimensions.spaciousness"],
    evidence: { acoustic: [], semantic: ["moodDimensions.spaciousness"], context: [] } }, [],
  { snapshot: ambient, eligibleTexts: ["몽환적"] });
  assert.equal(cliché.valid, false);
  assert.ok(cliché.diagnostics.reasons.includes("ai-cliche-ungrounded"));
});

test("delta prompting sends a smaller change payload after the baseline", () => {
  const before = Snapshot.serialize(profile("futurefunk"));
  const after = Snapshot.serialize(profile("jungle"));
  const semanticDelta = Snapshot.delta(before, after);
  assert.ok(semanticDelta.changes.length > 0);
  const baseline = createLanguageRequest({ snapshot: before });
  const delta = createLanguageRequest({ snapshot: after, requestMode: "delta",
    baselineFingerprint: before.fingerprint, semanticDelta });
  const baselinePayload = JSON.parse(baseline.input[1].content);
  const deltaPayload = JSON.parse(delta.input[1].content);
  assert.ok(baselinePayload.snapshot);
  assert.equal(deltaPayload.snapshot, undefined);
  assert.equal(deltaPayload.requestMode, "delta");
  assert.ok(delta.input[1].content.length < baseline.input[1].content.length);
});

test("same-genre fixtures with different evidence do not converge on the same language (section 33)", () => {
  const a = profile("futurefunk"), b = profile("futurefunkb");
  const idiomsA = new Set(a.detectedIdioms.map(item => item.text));
  const idiomsB = new Set(b.detectedIdioms.map(item => item.text));
  const overlap = [...idiomsA].filter(text => idiomsB.has(text));
  const overlapRatio = overlap.length / Math.max(1, Math.min(idiomsA.size, idiomsB.size));
  // A same-genre pair legitimately shares SOME language now that genre-loaded idioms require real
  // genre confirmation (both fixtures genuinely are Future Funk) -- the bar is "still clearly
  // differentiated", not "zero overlap", so each side must keep a majority of unique language.
  assert.ok(overlapRatio <= 0.55, `Future Funk A/B idiom overlap too high: ${overlapRatio} (${overlap.join(", ")})`);
  assert.ok(idiomsA.size - overlap.length >= 4, "A must keep several idioms B does not have");
  // The genre label alone must not be why they diverge -- each side needs its OWN real evidence.
  assert.ok(idiomsB.has("선율적 베이스") || idiomsB.has("노래하는 베이스"), "B's own evidence should surface");
  assert.ok(idiomsA.has("필터 루프") || idiomsA.has("정박 4박"), "A's own evidence should surface");
});

test("City Pop, Jazz and the DnB family each stay differentiated within themselves (section 20)", () => {
  // Each pair shares a genre label but not its material: a mid-tempo guitar arrangement against a
  // slow minor ballad, an up-tempo quartet against a verified trio ballad, a raw amen roller
  // against a wide liquid roller. Jazz sits at a higher ceiling because two jazz records really do
  // share swing/ensemble vocabulary; the requirement is that neither side becomes the other.
  const pairs = [
    { label: "City Pop", a: "citypop", b: "citypopb", ceiling: 0.55 },
    { label: "Jazz", a: "jazztrio", b: "jazzballad", ceiling: 0.7 },
    { label: "DnB family", a: "jungle", b: "liquiddnb", ceiling: 0.55 }
  ];
  for (const { label, a, b, ceiling } of pairs) {
    const left = new Set(profile(a).detectedIdioms.map(item => item.text));
    const right = new Set(profile(b).detectedIdioms.map(item => item.text));
    const shared = [...left].filter(text => right.has(text));
    const ratio = shared.length / Math.max(1, Math.min(left.size, right.size));
    assert.ok(ratio <= ceiling, `${label} overlap too high: ${ratio.toFixed(2)} (${shared.join(", ")})`);
    assert.ok(left.size - shared.length >= 4, `${label} A must keep its own language`);
    assert.ok(right.size - shared.length >= 4, `${label} B must keep its own language`);
  }
  // The divergence must come from the harmony/melody evidence, not only from mood numbers.
  const ballad = new Set(profile("citypopb").detectedIdioms.map(item => item.text));
  const upTempo = new Set(profile("citypop").detectedIdioms.map(item => item.text));
  assert.ok(ballad.has("하행 선율") && !upTempo.has("하행 선율"), "the ballad's falling vocal line should be what separates it");
  const trio = new Set(profile("jazzballad").detectedIdioms.map(item => item.text));
  assert.ok(trio.has("트리오 편성 짜임새"), "a verified three-piece should be named as one");
  assert.ok(!trio.has("콰르텟 편성 짜임새"), "and never as a four-piece");
});

test("a sustained multi-voice texture is never reported as a specific instrument (section 2-1)", () => {
  // A sustain ratio is not an instrument. Naming strings or a synth pad from texture alone is the
  // same error class as naming a genre from brightness, so those phrases must not exist ungated.
  for (const entry of lexicon.entries) {
    const claimsInstrument = /스트링|패드 레이어|어쿠스틱 기타|색소폰|트럼펫/.test(entry.neutralText || "");
    if (!claimsInstrument) continue;
    assert.ok(entry.requiredContext || (entry.required || entry.match || []).some(test => /instrument\.|role\.|instrumentation/.test(test.path)),
      `${entry.id} names an instrument in "${entry.neutralText}" without instrument evidence or a context gate`);
  }
  const ballad = new Set(profile("jazzballad").detectedIdioms.map(item => item.text));
  for (const text of ["스트링 레이어", "패드 레이어"])
    assert.ok(!ballad.has(text), `a piano trio must not surface "${text}"`);
});

test("the same uneven-subdivision primitive is genre-free; extra detectors may still change FACT", () => {
  const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
  const evenValue = Primitives.empty();
  Object.assign(evenValue.pulse, { subdivisionRatio: 1.85, pulsePresence: .7, onsetDensity: .5, metricStability: .5 });
  const texts = (value, genre) => engine.evaluate(value, genre).map(item => item.text).sort();
  assert.deepEqual(texts(evenValue, { primary: "Jazz", confidence: .82 }),
    texts(evenValue, { primary: "Blues", confidence: .82 }));
  const garageValue = { ...evenValue, pulse: { ...evenValue.pulse, breakDensity: .55, kickPeriodicity: .2, shuffleStrength: .5 } };
  assert.deepEqual(texts(garageValue, { primary: "UK Garage", confidence: .82 }),
    texts(garageValue, { primary: "Jazz", confidence: .82 }),
    "adding detectors may change FACT; swapping only the genre label must not");
  assert.ok(texts(evenValue, { primary: "Blues", confidence: .82 }).length > 0,
    "neutral musical language still survives when no genre specialization is allowed");
});

test("genre-loaded idioms never leak into an unrelated genre's real fixture (section 18)", () => {
  const forbidden = {
    futurefunk: ["어쿠스틱 포크 질감", "빅밴드 스윙 펄스", "French House 계보 프로덕션"],
    citypop: ["보컬 개러지 텍스처", "어쿠스틱 포크 질감", "2-Step 스윙"],
    ukgarage: ["워킹 베이스", "어쿠스틱 포크 질감", "빅밴드 스윙 펄스"],
    jazztrio: ["French House 계보 프로덕션", "2-Step 스윙", "신스웨이브 아르페지오 레이어"],
    citypopb: ["어쿠스틱 포크 질감", "빅밴드 스윙 펄스", "2-Step 스윙", "디스코 지속 레이어"],
    jazzballad: ["신스웨이브 아르페지오 레이어", "French House 계보 프로덕션", "빅밴드 스윙 펄스", "보컬 개러지 텍스처"]
  };
  for (const [kind, texts] of Object.entries(forbidden)) {
    const state = profile(kind);
    const idiomTexts = new Set(state.detectedIdioms.map(item => item.text));
    for (const text of texts) assert.ok(!idiomTexts.has(text), `${kind} must not surface "${text}"`);
  }
});

test("a requiredContext genre gate stays dormant because FACT evaluation ignores genre", () => {
  const gated = { id: "gate-test", facet: "production", neutralText: "가짜 신스웨이브 표현",
    required: [{ path: "production.brightness", min: 0.5 }],
    requiredContext: { genreFamilies: ["Synthwave"], minConfidence: 0.6 }, minConfidence: 0.3 };
  const engine = new Idioms.Engine({ version: 1, entries: [gated] },
    { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
  const value = Primitives.empty();
  Object.assign(value.production, { brightness: 0.9 });
  assert.equal(engine.evaluate(value, { primary: "Future Funk", confidence: 0.9 }).length, 0);
  assert.equal(engine.evaluate(value, { primary: "Synthwave", confidence: 0.3 }).length, 0);
  assert.equal(engine.evaluate(value, { primary: "Synthwave", confidence: 0.75 }).length, 0,
    "genre-conditioned FACT must not fire even when the matching genre label is supplied");
});

test("false positives: weak evidence must not earn a confident idiom just because the genre matches (section 35)", () => {
  const engine = new Idioms.Engine(lexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy: taxonomy });
  const weakBass = Primitives.empty();
  Object.assign(weakBass.bass, { bassPresence: .2, bassMotion: .1, walkingLikelihood: null });
  Object.assign(weakBass.role, { bassFunction: null });
  const jazzWeak = engine.evaluate(weakBass, { primary: "Jazz", confidence: .9 }).map(item => item.text);
  assert.ok(!jazzWeak.some(text => /워킹 베이스/.test(text)), "no bass evidence must not produce walking bass");

  const noVocal = Primitives.empty();
  Object.assign(noVocal.production, { sampleBasedLikelihood: .8 });
  const funkWeak = engine.evaluate(noVocal, { primary: "Future Funk", confidence: .9 }).map(item => item.text);
  assert.ok(!funkWeak.some(text => /보컬 찹/.test(text)), "no vocal evidence must not produce vocal chop");

  const lowReverbConfidence = Primitives.empty();
  Object.assign(lowReverbConfidence.production, { reverbTail: .3 });
  const ambientWeak = engine.evaluate(lowReverbConfidence, { primary: "Ambient", confidence: .9 }).map(item => item.text);
  assert.ok(!ambientWeak.some(text => /긴 잔향/.test(text)), "reverb confidence below threshold must not claim long reverb as fact");
});

test("nine acoustic fixtures surface grounded genre-neutral idioms without unsupported solo claims", () => {
  const expected = {
    futurefunk: ["샘플 루프", "밝고 매끈한 프로덕션"], citypop: ["싱코페이션 그루브"],
    ukgarage: ["셔플 그루브"], jungle: ["롤링 브레이크"], liquiddnb: ["롤링 브레이크", "긴 잔향 공간"],
    funk: ["싱코페이트 베이스 그루브"], jazztrio: ["순차 진행 베이스", "빠른 화성 이동"],
    shoegaze: ["겹겹의 사운드 월"], ambient: ["자유 리듬", "깊은 공간감"]
  };
  for (const [name, terms] of Object.entries(expected)) {
    const state = profile(name);
    const texts = [...state.detectedIdioms, ...state.impressionFacetCandidates].map(item => item.text);
    for (const term of terms) assert.ok(texts.includes(term), `${name}: ${term}; got ${texts.join(", ")}`);
    if (name !== "jazztrio") assert.ok(!texts.some(text => /솔로/.test(text)), `${name} invented a solo`);
    for (const item of state.impressionFacetCandidates) assert.ok(item.anchors.length >= 2);
  }
});

test("the historical '-코어' catalog remains a useful compatibility index, not an admission boundary", () => {
  assert.ok(approvedCoreTerms.entries.length >= 11, "data/approvedCoreTerms.json should carry the expanded scene list");
  for (const entry of approvedCoreTerms.entries) {
    assert.ok(Array.isArray(entry.aliases) && entry.aliases.length, `${entry.term} needs an English alias for grounding`);
    assert.ok(entry.genreFamily, `${entry.term} needs a genreFamily for grounding`);
    assert.ok(Facets.safeText(entry.term, "genre"), `${entry.term} should remain accepted`);
  }
});

test("safeText treats unfamiliar '-코어' spellings as open-world vocabulary and leaves truth to evidence gates", () => {
  for (const unfamiliar of ["유리코어", "네온코어", "헬로키티코어", "달빛코어"])
    assert.equal(Facets.safeText(unfamiliar, "genre"), true, `${unfamiliar} must not fail only because it is unregistered`);
  assert.ok(Facets.safeText("글리치코어 계열", "genre"));
  assert.ok(Facets.safeText("글리치코어 유리코어 계열", "genre"));
});

test("an unfamiliar genre still needs evidence even though its spelling is allowed", () => {
  const unsupported = Facets.token("아직등록되지않은코어", "genre", 0.9, []);
  assert.equal(Facets.support(unsupported, {
    snapshot: { primaryGenre: "House", confidence: 0.82 }
  }).supported, false);

  const directlyHeard = Facets.token("아직등록되지않은코어", "genre", 0.68,
    ["directAudioEvidence.genre"], { source: "directAudio", sourceFamily: "directAudio" });
  assert.equal(Facets.support(directlyHeard, {
    snapshot: { directAudioEvidence: { genre: ["아직등록되지않은코어"] } }
  }).supported, true);
});

test("safeText's actual safety filters remain intact after opening the vocabulary", () => {
  // "mood" moved into the open layer in a later round (test/clicheScore.test.js) -- the
  // AI-poetry blocklist there is now a graded cliche penalty, not an instant veto, so this
  // check moved to a strict-layer facet ("rhythm") to keep testing what it originally meant.
  assert.equal(Facets.safeText("과열된 긴장", "rhythm"), false);
  assert.equal(Facets.safeText("이 곡은 재즈입니다", "genre"), false);
  assert.equal(Facets.safeText("1987", "era"), false);
  assert.ok(Facets.safeText("1980년대", "era"));
  assert.ok(Facets.safeText("하드코어", "genre"));
});
