const test = require("node:test");
const assert = require("node:assert/strict");
const Analyze = require("../scripts/analyze-vocabulary-batch.cjs");

function entry(overrides = {}) {
  return { text: "테스트", conceptKey: "test.key", region: [{ axis: "nostalgia", min: 0.5 }], minAxes: 1, ...overrides };
}

test("conceptKeyRatio is 1 when every entry has a distinct conceptKey, lower when they repeat", () => {
  assert.equal(Analyze.conceptKeyRatio([entry({ conceptKey: "a" }), entry({ conceptKey: "b" })]), 1);
  assert.equal(Analyze.conceptKeyRatio([entry({ conceptKey: "a" }), entry({ conceptKey: "a" })]), 0.5);
  assert.equal(Analyze.conceptKeyRatio([]), 0, "empty batch must not divide by zero");
});

test("axisShareOf reports each axis's share of all region conditions, and flags one over 30%", () => {
  const entries = [
    entry({ region: [{ axis: "nostalgia", min: 0.5 }] }),
    entry({ region: [{ axis: "nostalgia", min: 0.5 }] }),
    entry({ region: [{ axis: "nostalgia", min: 0.5 }] }),
    entry({ region: [{ axis: "warmth", min: 0.5 }] }),
    entry({ region: [{ axis: "tension", min: 0.5 }] })
  ];
  const { share, overrepresented } = Analyze.axisShareOf(entries, ["nostalgia", "warmth", "tension"]);
  assert.ok(Math.abs(share.nostalgia - 3 / 5) < 1e-9);
  assert.ok(Math.abs(share.warmth - 1 / 5) < 1e-9);
  assert.ok(Math.abs(share.tension - 1 / 5) < 1e-9);
  assert.deepEqual(overrepresented, ["nostalgia"]);
});

test("gateWidthOf counts entries by region size and flags a high single-axis ratio", () => {
  const entries = [
    entry({ region: [{ axis: "nostalgia", min: 0.5 }] }),
    entry({ region: [{ axis: "nostalgia", min: 0.5 }, { axis: "warmth", min: 0.5 }] }),
    entry({ region: [{ axis: "nostalgia", min: 0.5 }, { axis: "warmth", min: 0.5 }] })
  ];
  const { counts, singleAxisRatio } = Analyze.gateWidthOf(entries);
  assert.equal(counts[1], 1);
  assert.equal(counts[2], 2);
  assert.ok(Math.abs(singleAxisRatio - 1 / 3) < 1e-9);
});

test("satisfiesEntry checks min/max and minAxes, exactly like the runtime engine's own gate", () => {
  const twoAxisEntry = entry({ region: [{ axis: "nostalgia", min: 0.5 }, { axis: "decay", min: 0.4, max: 0.7 }], minAxes: 2 });
  assert.equal(Analyze.satisfiesEntry(twoAxisEntry, { nostalgia: 0.6, decay: 0.5 }), true);
  assert.equal(Analyze.satisfiesEntry(twoAxisEntry, { nostalgia: 0.6, decay: 0.9 }), false, "decay above max must fail");
  assert.equal(Analyze.satisfiesEntry(twoAxisEntry, { nostalgia: 0.6 }), false, "missing decay must fail minAxes:2");
});

test("universalFireCheck flags an entry that fires on every track (the 'sticks to any music' problem), never a single-track case", () => {
  const permissive = entry({ text: "무엇에나 붙는 말", conceptKey: "permissive", region: [{ axis: "nostalgia", min: 0.1 }], minAxes: 1 });
  const specific = entry({ text: "특정한 말", conceptKey: "specific", region: [{ axis: "nostalgia", min: 0.9 }], minAxes: 1 });
  const tracks = [
    { track: "a", median: { nostalgia: 0.3 } }, { track: "b", median: { nostalgia: 0.5 } }, { track: "c", median: { nostalgia: 0.2 } }
  ];
  const { perEntry, universallyFiring } = Analyze.universalFireCheck([permissive, specific], tracks);
  assert.equal(perEntry.find(item => item.conceptKey === "permissive").firesOnCount, 3);
  assert.equal(perEntry.find(item => item.conceptKey === "specific").firesOnCount, 0);
  assert.equal(universallyFiring.length, 1);
  assert.equal(universallyFiring[0].conceptKey, "permissive");
});

test("universalFireCheck does not flag anything when only one track is given (nothing to compare against)", () => {
  const { universallyFiring } = Analyze.universalFireCheck([entry()], [{ track: "solo", median: { nostalgia: 0.9 } }]);
  assert.equal(universallyFiring.length, 0);
});

test("buildReport's gate4Summary reflects PASS/FAIL for each Gate 4 criterion, and SKIPS the fire test with no track data", () => {
  const goodBatch = Array.from({ length: 10 }, (_, index) => entry({
    conceptKey: `concept.${index}`, region: [{ axis: "nostalgia", min: 0.5 }, { axis: "warmth", min: 0.5 }], minAxes: 2
  }));
  const report = Analyze.buildReport(goodBatch, ["nostalgia", "warmth", "tension"], null);
  assert.equal(report.gate4Summary.conceptKeyRatio, "PASS");
  assert.equal(report.gate4Summary.gateWidth, "PASS");
  assert.equal(report.gate4Summary.universalFireTest, "SKIPPED (no --replay dir given)");
  const badBatch = [entry({ conceptKey: "dup" }), entry({ conceptKey: "dup" })];
  const badReport = Analyze.buildReport(badBatch, ["nostalgia"], null);
  assert.equal(badReport.gate4Summary.conceptKeyRatio, "FAIL");
});
