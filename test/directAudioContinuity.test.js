const test = require("node:test");
const assert = require("node:assert/strict");
const Continuity = require("../js/semantic/directAudioContinuity");

test("a new capture replaces momentary facts but retains decaying track-level interpretation", () => {
  const previous = [
    { text: "old kick pattern", category: "rhythm", layer: "FACT", confidence: 0.72, observedAt: 1000 },
    { text: "Mallsoft", category: "genre", layer: "CONTEXT", confidence: 0.70, observationId: "obs-1", observedAt: 1000 },
    { text: "degraded retail memory", category: "association", layer: "AESTHETIC", confidence: 0.64, observationId: "obs-1", observedAt: 1000 }
  ];
  const incoming = [
    { text: "softened transients", category: "production", layer: "FACT", confidence: 0.75, observationId: "obs-2" }
  ];
  const merged = Continuity.merge(previous, incoming, { now: 2000 });
  assert.ok(merged.some(item => item.text === "softened transients"));
  assert.ok(!merged.some(item => item.text === "old kick pattern"), "segment-local facts must not leak forward");
  assert.equal(merged.find(item => item.text === "Mallsoft").confidence, 0.63);
  assert.equal(merged.find(item => item.text === "Mallsoft").retainedAcrossCaptures, true);
  assert.ok(merged.some(item => item.text === "degraded retail memory"));
});

test("a re-heard concept is one fresh observation, not a retained duplicate", () => {
  const previous = [{ text: "Mallsoft", category: "genre", layer: "CONTEXT", confidence: 0.61,
    observationId: "obs-1", observedAt: 1000 }];
  const incoming = [{ text: "Mallsoft", category: "genre", layer: "CONTEXT", confidence: 0.78,
    observationId: "obs-2" }];
  const merged = Continuity.merge(previous, incoming, { now: 5000 });
  assert.equal(merged.filter(item => item.text === "Mallsoft").length, 1);
  assert.equal(merged[0].observationId, "obs-2");
  assert.equal(merged[0].retainedAcrossCaptures, false);
});

test("unreconfirmed interpretations expire and continuity stays bounded", () => {
  const previous = Array.from({ length: 50 }, (_, index) => ({
    text: `scene ${index}`, category: "scene", layer: "CONTEXT", confidence: 0.8,
    observedAt: index === 0 ? 1000 : 190000
  }));
  const merged = Continuity.merge(previous, [], { now: 200000, maxAgeMs: 180000, maxCandidates: 12 });
  assert.equal(merged.length, 12);
  assert.ok(!merged.some(item => item.text === "scene 0"));
  assert.deepEqual(Continuity.active([{ text: "old", observedAt: 1 }, { text: "new", observedAt: 190000 }],
    { now: 200000, maxAgeMs: 180000 }).map(item => item.text), ["new"]);
});
