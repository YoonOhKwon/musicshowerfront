const test = require("node:test");
const assert = require("node:assert/strict");
const TemporalEvidence = require("../js/semantic/temporalEvidenceEngine");

const candidate = (text, category, confidence) => ({ text, category, confidence });
const findStable = (result, category) => result.stable.find(item => item.category === category);

test("a higher-confidence challenger does not immediately replace the stable musical-tier facet", () => {
  const engine = new TemporalEvidence.Engine();
  engine.update([candidate("4/4 킥", "rhythm", 0.7)], 0);
  let result = engine.update([candidate("4/4 킥", "rhythm", 0.7)], 100);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥");

  // Challenger clears the switch margin and becomes individually eligible, but must still persist.
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 300);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥");
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 400);
  assert.equal(findStable(result, "rhythm")?.text, "4/4 킥", "not enough time has passed for the switch to commit");

  // Once the challenger has stayed the top pick for the required persistence window, it takes over.
  result = engine.update([candidate("2-Step", "rhythm", 0.9)], 1200);
  assert.equal(findStable(result, "rhythm")?.text, "2-Step");
});

test("fast-tier facets update without a persistence delay", () => {
  const engine = new TemporalEvidence.Engine();
  const result = engine.update([candidate("드럼 유입", "live", 0.85)], 0);
  assert.equal(findStable(result, "live")?.text, "드럼 유입");
});

test("context-tier facets need sustained observations across the context window", () => {
  const engine = new TemporalEvidence.Engine();
  let result;
  for (const at of [0, 2000, 4000]) {
    result = engine.update([candidate("UK 클럽 씬", "scene", 0.8)], at);
  }
  // Enough observations, but under the 5.5s context-tier minimum duration: not eligible yet.
  assert.equal(findStable(result, "scene"), undefined);
  result = engine.update([candidate("UK 클럽 씬", "scene", 0.8)], 6000);
  assert.equal(findStable(result, "scene")?.text, "UK 클럽 씬");
});

test("track memory retains a confirmed fact and expires it if never reconfirmed", () => {
  const engine = new TemporalEvidence.Engine();
  for (const at of [0, 2000, 4000, 6000]) {
    engine.update([candidate("UK 클럽 씬", "scene", 0.8)], at);
  }
  let memoryTexts = engine.update([], 6100).trackMemory.map(item => item.text);
  assert.ok(memoryTexts.includes("UK 클럽 씬"));

  // No reconfirmation for longer than the context window: the memory entry expires.
  memoryTexts = engine.update([], 6100 + 30001).trackMemory.map(item => item.text);
  assert.ok(!memoryTexts.includes("UK 클럽 씬"));
});
