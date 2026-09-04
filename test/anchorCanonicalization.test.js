const test = require("node:test");
const assert = require("node:assert/strict");
const Layers = require("../js/semantic/languageLayerPolicy");
const Facets = require("../js/semantic/semanticFacets");
const Critic = require("../js/semantic/languageCritic");

const brightSnapshot = {
  confidence: 0.85, primaryGenre: "Future Funk",
  timbre: { brightness: "very high" }, moodDimensions: { brightness: 0.86 },
  rhythmicGrammar: { fourOnFloor: 0.9 }, productionEvidence: { sampleBased: 0.82 },
  genreEvidence: [{ label: "Future Funk", confidence: 0.9 }]
};

test("a snapshot.-prefixed path normalizes to its canonical form", () => {
  assert.equal(Layers.normalizePath("snapshot.timbre.brightness"), "timbre.brightness");
  assert.equal(Layers.normalizePath("Snapshot.timbre.brightness"), "timbre.brightness");
  assert.equal(Layers.normalizePath("snapshot"), "");
});

test("bracket notation normalizes to dot notation, including repeated indices", () => {
  assert.equal(Layers.normalizePath("genreEvidence[0].label"), "genreEvidence.0.label");
  assert.equal(Layers.normalizePath("snapshot.genreEvidence[0].confidence"), "genreEvidence.0.confidence");
  assert.equal(Layers.normalizePath("instrumentEvidence[2].confidence"), "instrumentEvidence.2.confidence");
  assert.equal(Layers.normalizePath("primitives.pulse[0][1]"), "primitives.pulse.0.1");
});

test("an already-canonical path passes through unchanged", () => {
  assert.equal(Layers.normalizePath("timbre.brightness"), "timbre.brightness");
  assert.equal(Layers.normalizePath("genreEvidence.0.label"), "genreEvidence.0.label");
});

test("Facets.read resolves a non-canonical path exactly like its canonical form", () => {
  const snapshot = { timbre: { brightness: 0.86 }, genreEvidence: [{ label: "Future Funk", confidence: 0.9 }] };
  assert.equal(Facets.read(snapshot, "snapshot.timbre.brightness"), 0.86);
  assert.equal(Facets.read(snapshot, "timbre.brightness"), 0.86);
  assert.equal(Facets.read(snapshot, "genreEvidence[0].confidence"), 0.9);
  assert.equal(Facets.read(snapshot, "genreEvidence.0.confidence"), 0.9);
});

test("a genuinely missing path still resolves to undefined after normalization", () => {
  assert.equal(Facets.read({ timbre: {} }, "snapshot.timbre.nonexistent"), undefined);
});

test("a candidate whose anchors only differ by snapshot-prefix/bracket notation scores identically to the canonical form", () => {
  const canonical = { text: "규칙적인 펄스", category: "rhythm", confidence: 0.8, kind: "descriptor", role: "none",
    anchors: ["rhythmicGrammar.fourOnFloor", "productionEvidence.sampleBased"] };
  const nonCanonical = { ...canonical, anchors: ["snapshot.rhythmicGrammar.fourOnFloor", "snapshot.productionEvidence.sampleBased"] };
  const a = Critic.assess(canonical, [], { snapshot: brightSnapshot });
  const b = Critic.assess(nonCanonical, [], { snapshot: brightSnapshot });
  assert.equal(a.valid, true);
  assert.ok(Math.abs(a.evidenceScore - b.evidenceScore) < 1e-9, `${a.evidenceScore} vs ${b.evidenceScore}`);
  assert.equal(b.valid, a.valid);
});

test("resolvedAnchorRatio scales the penalty smoothly instead of an all-or-nothing veto", () => {
  const base = { text: "규칙적인 펄스", category: "rhythm", confidence: 0.8, kind: "descriptor", role: "none" };
  const allResolved = Critic.assess({ ...base, anchors: ["rhythmicGrammar.fourOnFloor", "productionEvidence.sampleBased"] }, [], { snapshot: brightSnapshot });
  const halfResolved = Critic.assess({ ...base, anchors: ["rhythmicGrammar.fourOnFloor", "does.not.exist"] }, [], { snapshot: brightSnapshot });
  assert.equal(allResolved.diagnostics.resolvedAnchorRatio, 1);
  assert.ok(halfResolved.diagnostics.resolvedAnchorRatio < 1 && halfResolved.diagnostics.resolvedAnchorRatio > 0);
  assert.ok(halfResolved.evidenceScore < allResolved.evidenceScore, "partial resolution costs some score");
  assert.ok(halfResolved.evidenceScore > allResolved.evidenceScore - 0.2, "but not most of it");
});

test("a candidate whose anchors are entirely unresolved cannot pass as grounded", () => {
  const a = Critic.assess({ text: "규칙적인 펄스", category: "rhythm", confidence: 0.8, kind: "descriptor", role: "none",
    anchors: ["totally.fake.path", "another.fake.one"] }, [], { snapshot: brightSnapshot });
  assert.equal(a.valid, false);
  assert.equal(a.diagnostics.resolvedAnchorRatio, 0);
  assert.equal(a.diagnostics.evidenceReason, "no-anchor-resolved");
});

test("unresolved and contradicted are reported as distinct, never conflated", () => {
  const unresolved = Critic.assess({ text: "규칙적인 펄스", category: "rhythm", confidence: 0.8, kind: "descriptor", role: "none",
    anchors: ["rhythmicGrammar.fourOnFloor", "no.such.field"] }, [], { snapshot: brightSnapshot });
  const contradicted = Critic.assess({ text: "어두운 저역 중심", category: "production", confidence: 0.8, kind: "descriptor", role: "none",
    anchors: ["timbre.brightness", "productionEvidence.sampleBased"] }, [], { snapshot: brightSnapshot });
  assert.ok(unresolved.diagnostics.resolvedAnchorRatio < 1);
  assert.equal(unresolved.diagnostics.contradiction, 0, "an unresolved path is not a contradiction");
  assert.equal(contradicted.diagnostics.resolvedAnchorRatio, 1, "a contradicted claim can still fully resolve its anchors");
  assert.ok(contradicted.diagnostics.contradiction > 0.4, "a contradicted claim is not merely 'unresolved'");
});

test("a rejection surfaces its real cause instead of the generic not-relevant label", () => {
  const a = Critic.assess({ text: "어두운 저역 중심", category: "production", confidence: 0.8, kind: "descriptor", role: "none",
    anchors: ["timbre.brightness", "productionEvidence.sampleBased"] }, [], { snapshot: brightSnapshot });
  assert.equal(a.valid, false);
  assert.equal(a.diagnostics.rejectionReason, "contradicted-by-snapshot");
  assert.ok(!a.diagnostics.reasons.includes("not-relevant-to-current-state"),
    "evidence-derived rejection must not also claim the phrase is unrelated to the track");
});
