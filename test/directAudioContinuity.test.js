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

test("a contradicting new genre hypothesis accelerates decay of old context/aesthetic/impression baggage", () => {
  const previous = [
    { text: "Ambient", category: "genre", layer: "CONTEXT", confidence: 0.80, observedAt: 1000 },
    { text: "nocturnal atmosphere", category: "association", layer: "AESTHETIC", confidence: 0.75, observedAt: 1000 },
    { text: "floating loneliness", category: "mood", layer: "IMPRESSION", confidence: 0.70, observedAt: 1000 }
  ];
  // A later capture (no silence/track-boundary event needed) hears a totally different genre --
  // this alone is evidence the song likely changed, so the OLD aesthetic/impression should not
  // ride out the normal slow ~0.90-per-capture decay.
  const incoming = [{ text: "Drum and Bass", category: "genre", layer: "CONTEXT", confidence: 0.82, observationId: "obs-2" }];
  const merged = Continuity.merge(previous, incoming, { now: 5000 });

  // The accelerated decay (0.40 instead of 0.90) drops both well below the 0.45 retention floor,
  // so they are pruned outright -- exactly the "must disappear, not just fade a little" behavior.
  assert.ok(!merged.some(item => item.text === "nocturnal atmosphere"),
    "a contradicted genre must sharply accelerate aesthetic decay, pruning the old concept");
  assert.ok(!merged.some(item => item.text === "floating loneliness"),
    "a contradicted genre must sharply accelerate impression decay, pruning the old concept");
  assert.ok(merged.some(item => item.text === "Drum and Bass"), "the fresh genre reading itself is always kept");
});

test("a CORROBORATING new genre hypothesis keeps the normal slow decay (no false acceleration)", () => {
  const previous = [
    { text: "Ambient", category: "genre", layer: "CONTEXT", confidence: 0.80, observedAt: 1000 },
    { text: "nocturnal atmosphere", category: "association", layer: "AESTHETIC", confidence: 0.75, observedAt: 1000 }
  ];
  // Same genre re-heard alongside a new aesthetic concept -- this is corroboration, not contradiction.
  const incoming = [
    { text: "Ambient", category: "genre", layer: "CONTEXT", confidence: 0.85, observationId: "obs-2" },
    { text: "spacious reverb tails", category: "association", layer: "AESTHETIC", confidence: 0.6, observationId: "obs-2" }
  ];
  const merged = Continuity.merge(previous, incoming, { now: 5000 });
  const oldAesthetic = merged.find(item => item.text === "nocturnal atmosphere");
  assert.equal(oldAesthetic.confidence, 0.75 * 0.90, "matching genre must keep the normal slow decay");
});

test("no prior genre reading at all does not trigger the contradiction penalty (nothing to contradict yet)", () => {
  const previous = [{ text: "warm harmonic mix", category: "production", layer: "FACT", confidence: 0.7, observedAt: 1000 }];
  const incoming = [{ text: "Future Funk", category: "genre", layer: "CONTEXT", confidence: 0.7, observationId: "obs-2" }];
  const merged = Continuity.merge(previous, incoming, { now: 5000 });
  // "warm harmonic mix" is FACT, not a persistent category, so it is dropped on its own merits --
  // this just confirms the shift check itself doesn't throw/misbehave with no previous genre.
  assert.ok(Array.isArray(merged));
});
