const test = require("node:test");
const assert = require("node:assert/strict");
const Audit = require("../scripts/audit-feedback.cjs");

test("feedback audit is read-only and exposes classifier-only coverage separately from persistence", () => {
  const report = Audit.auditFeedback([{
    text: "J-pop", vote: "keep", perspective: "genre", at: "2026-01-01T00:00:00Z",
    snapshot: {
      primaryGenre: "J-pop", confidence: .91,
      genreEvidence: [{ label: "J-pop", confidence: .12 }],
      rhythmicGrammar: {}, productionEvidence: {}, instrumentationEvidence: {}, moodDimensions: {},
      temporalState: { stable: [{ text: "J-pop", category: "genre", confidence: .94 }] }
    }
  }]);
  const item = report.items[0];
  assert.equal(item.voteMeaning, "manual-evaluation-only");
  assert.equal(item.evaluation, "supported-keep");
  assert.equal(item.currentHypothesis.evidenceCoverage, 1 / 3);
  assert.deepEqual(item.currentHypothesis.independentEvidenceFamilies, ["genreModel"]);
  assert.ok(item.legacyPersistenceInflation > .2);
});

test("feedback audit flags LIVE memory and detector-less current FACT leakage", () => {
  const leaks = Audit.temporalLeaks({
    rhythmicGrammar: { brokenBeat: null }, productionEvidence: { sampleBased: null },
    temporalState: { stable: [
      { text: "드롭 진입", category: "live", confidence: 1 },
      { text: "브레이크비트", category: "rhythm", confidence: .8 },
      { text: "샘플 기반", category: "production", confidence: .75 }
    ] }
  });
  assert.deepEqual(leaks.map(item => item.reason), [
    "live-event-in-stable-memory",
    "stable-fact-without-current-detector-evidence",
    "stable-fact-without-current-detector-evidence"
  ]);
});
