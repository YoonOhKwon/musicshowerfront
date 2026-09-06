const test = require("node:test");
const assert = require("node:assert/strict");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { profile, responseFixture } = require("./fixtures/languageProfiles");
const { validateLanguageInput, parseLanguageResponse, quantizeCacheInput, createLanguageService, languageInstructions } = require("../lib/languageService");
const Facets = require("../js/semantic/semanticFacets");

test("language input explicitly sanitizes primitives and neutral idioms", () => {
  const state = profile();
  state.primitives = {
    pulse: { pulsePresence: .8, pulseRegularity: .9, tempoClass: "moderate", injected: "no" },
    texture: { textureClass: "polyphonic", voiceCount: 4 }, role: { bassFunction: "walking" }
  };
  state.detectedIdioms = [{ text: "다성적 짜임새", category: "arrangement", confidence: .74, neutral: true,
    anchors: ["primitives.texture.textureClass", "primitives.texture.voiceCount"] }];
  const snapshot = validateLanguageInput({ snapshot: Snapshot.serialize(state) }).snapshot;
  assert.equal(snapshot.primitives.pulse.tempoClass, "moderate");
  assert.equal(snapshot.primitives.pulse.injected, undefined);
  assert.equal(snapshot.detectedIdioms[0].neutral, true);
  assert.match(languageInstructions, /neutral=true/);
});

test("anchor count is no longer a gate, and one thin candidate cannot discard the batch", () => {
  const value = Object.fromEntries(Facets.names.map(name => [name, []]));
  // Three strong anchors across three independent axes: previously thrown away for being < 4.
  value.scene = [{ text: "UK 클럽 씬", confidence: .8, kind: "style", role: "none",
    anchors: ["genreEvidence", "rhythmicGrammar", "productionEvidence"] }];
  value.rhythm = [{ text: "2-Step 계열", confidence: .82, kind: "descriptor", role: "none",
    anchors: ["rhythmicGrammar.swing", "measurements.bpm"] }];
  const parsed = parseLanguageResponse({ status: "completed", output_text: JSON.stringify(value) });
  assert.equal(parsed.scene.length, 1, "a 3-anchor context term now survives parsing");
  assert.equal(parsed.rhythm.length, 1, "and it never takes the rest of the batch down with it");
  // Malformed metadata (not anchor count) is still a hard rejection.
  const broken = Object.fromEntries(Facets.names.map(name => [name, []]));
  broken.scene = [{ text: "UK 클럽 씬", confidence: 9, kind: "style", role: "none", anchors: ["genreEvidence"] }];
  assert.throws(() => parseLanguageResponse({ status: "completed", output_text: JSON.stringify(broken) }), /metadata|validation/);
});

test("the model's layer and quality proposals survive parsing but stay marked as proposals", () => {
  const value = Object.fromEntries(Facets.names.map(name => [name, []]));
  value.association = [{ text: "마법소녀 미학", confidence: .68, kind: "aesthetic", role: "none",
    layer: "AESTHETIC", specificity: .95, contrastiveness: .9,
    evidence: { acoustic: ["timbre.brightness"], semantic: ["primaryGenre"], context: ["genreContextEvidence"] },
    anchors: ["timbre.brightness", "primaryGenre"] }];
  const [candidate] = parseLanguageResponse({ status: "completed", output_text: JSON.stringify(value) }).candidates;
  assert.equal(candidate.layer, "AESTHETIC");
  assert.equal(candidate.source, "llm");
  assert.deepEqual(candidate.evidence.acoustic, ["timbre.brightness"]);
  assert.equal(candidate.specificity, .95);
});

test("epistemic layers get their own poetic-language policy, not a blanket ban", () => {
  assert.match(languageInstructions, /IMPRESSION/);
  assert.match(languageInstructions, /AESTHETIC/);
  // The old prompt banned poetic compounds everywhere; IMPRESSION must now explicitly allow them.
  assert.match(languageInstructions, /IMPRESSION[\s\S]{0,400}(?:poetic|시적)[\s\S]{0,200}(?:allowed|encouraged)/i);
  // FACT must stay strict — direct terminology only, no figurative language.
  assert.match(languageInstructions, /FACT[\s\S]{0,200}(?:strict|direct musical terminology)/i);
});

test("the model treats new -core/코어 labels as evidence claims rather than whitelist violations", () => {
  assert.match(languageInstructions, /New \*core\/코어 and other scene labels are allowed when direct listening or converging musical\/context evidence supports them/i);
  assert.match(languageInstructions, /uncertainty must lower confidence or use a qualified CONTEXT phrasing/i);
});

test("candidateCount reaches the uncached model payload as a clamped target term count", () => {
  const base = { snapshot: Snapshot.serialize(profile()) };
  assert.equal(validateLanguageInput({ ...base }).candidateCount, 24, "defaults when absent");
  assert.equal(validateLanguageInput({ ...base, candidateCount: 32 }).candidateCount, 32);
  assert.equal(validateLanguageInput({ ...base, candidateCount: 5 }).candidateCount, 12, "clamped to the floor");
  assert.equal(validateLanguageInput({ ...base, candidateCount: 999 }).candidateCount, 40, "clamped to the ceiling");
  assert.equal(validateLanguageInput({ ...base, candidateCount: "not-a-number" }).candidateCount, 24);
});

test("request identity and generation reason survive validation for stale-response tracing", () => {
  const parsed = validateLanguageInput({ snapshot: Snapshot.serialize(profile()), sessionId: 17,
    semanticEpoch: 42, reason: "context-refresh" });
  assert.equal(parsed.sessionId, 17);
  assert.equal(parsed.semanticEpoch, 42);
  assert.equal(parsed.reason, "context-refresh");
});

test("cache quantization ignores harmless floating point jitter but preserves musical changes", async () => {
  const left = { snapshot: Snapshot.serialize(profile()) };
  const right = JSON.parse(JSON.stringify(left));
  left.snapshot.measurements.rms = .611;
  right.snapshot.measurements.rms = .619;
  assert.deepEqual(quantizeCacheInput(validateLanguageInput(left)), quantizeCacheInput(validateLanguageInput(right)));
  let calls = 0;
  const client = { responses: { create: async () => { calls++; return responseFixture(); } } };
  const service = createLanguageService({ client, minimumIntervalMs: 0 });
  await service.generate(left);
  const cached = await service.generate(right);
  assert.equal(calls, 1);
  assert.equal(cached.meta.cache, "server");
});
