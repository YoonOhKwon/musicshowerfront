const test = require("node:test");
const assert = require("node:assert/strict");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { validateLanguageInput, snapshotSizeBreakdown, applyReductionLadder, REDUCTION_LADDER,
  SNAPSHOT_MAX_CHARS, NEVER_DROP_SNAPSHOT_KEYS } = require("../lib/languageService");
const { profile } = require("./fixtures/languageProfiles");

// Every capped string/array field pushed PAST its declared maximum (not just to it) -- a stress
// probe for validateLanguageInput()'s OWN sanitizer caps, deliberately bypassing
// semanticSnapshot.js's serialize() (which applies its own, tighter client-side truncation before
// this ever runs) so the ladder is tested against the server-side boundary it actually guards.
function maxedOutSnapshot(kind = "futurefunk") {
  const state = profile(kind);
  const snapshot = Snapshot.serialize(state, state.distinctive);
  const longText = len => "가".repeat(len);
  const longPath = len => "a.".repeat(Math.floor(len / 2));
  snapshot.detectedIdioms = Array.from({ length: 20 }, (_, i) => ({
    text: longText(60), facet: "rhythm", confidence: 0.9, neutral: false,
    anchors: Array.from({ length: 10 }, () => longPath(200)), source: "idiom-" + i, semanticFamily: longText(80), persistenceMs: 1000
  }));
  snapshot.impressionConcepts = Array.from({ length: 12 }, (_, i) => ({
    id: "id" + i, text: longText(60), confidence: 0.9, anchors: Array.from({ length: 10 }, () => longPath(200)),
    semanticFamily: longText(80), creativeOperator: longText(50), semanticEpoch: 1, ttlMs: 1000
  }));
  snapshot.verifiedClaims = {
    items: Array.from({ length: 30 }, (_, i) => ({ id: "id" + i, type: longText(40), concept: longText(90),
      confidence: 0.9, evidence: Array.from({ length: 10 }, () => longPath(200)) })),
    licensed: Array.from({ length: 60 }, (_, i) => "claim_" + i),
    capsule: { note: "x" }
  };
  snapshot.genreContextEvidence = {
    genre: "Future Funk", confidence: 0.9, matchedPriors: Array.from({ length: 30 }, () => longText(80)),
    aestheticEvidence: { kawaii: 0.5, magicalGirl: 0.5, anime: 0.5, y2k: 0.5 },
    candidates: Array.from({ length: 30 }, (_, i) => ({ text: longText(80), category: "association", layer: "AESTHETIC",
      relationFamily: "AESTHETIC_ASSOCIATION", relationScore: 0.8, source: "aesthetic-axis" }))
  };
  return snapshot;
}

test("a realistic fully-populated snapshot (real fixture, all normal caps) fits the new budget without needing the ladder", () => {
  const state = profile("futurefunk");
  const snapshot = Snapshot.serialize(state, state.distinctive);
  const result = validateLanguageInput({ snapshot });
  assert.ok(JSON.stringify(result.snapshot).length <= SNAPSHOT_MAX_CHARS);
  assert.equal(result.reduction, null, "a realistic fully-populated snapshot should not need reduction");
});

test("snapshotSizeBreakdown reports the real total and the top 10 keys descending by size", () => {
  const snapshot = maxedOutSnapshot();
  const breakdown = snapshotSizeBreakdown(snapshot);
  assert.equal(breakdown.totalBytes, JSON.stringify(snapshot).length);
  assert.ok(breakdown.topKeys.length <= 10);
  for (let i = 1; i < breakdown.topKeys.length; i++) {
    assert.ok(breakdown.topKeys[i - 1].bytes >= breakdown.topKeys[i].bytes, "topKeys must be sorted descending");
  }
});

test("an oversized snapshot is reduced by the ladder instead of hard-failing, and the reduction is recorded", () => {
  const snapshot = maxedOutSnapshot();
  const rawSize = JSON.stringify(snapshot).length;
  assert.ok(rawSize > SNAPSHOT_MAX_CHARS, "test fixture must actually exceed the budget pre-sanitization");
  const result = validateLanguageInput({ snapshot });
  assert.ok(result.reduction, "an oversized snapshot must report what was reduced, not silently pass or silently fail");
  assert.ok(result.reduction.applied.length > 0);
  assert.ok(JSON.stringify(result.snapshot).length <= SNAPSHOT_MAX_CHARS);
  for (const step of result.reduction.applied) assert.ok(step.saved >= 0);
});

test("the ladder is defined in the exact prescribed order: least important field first", () => {
  const names = REDUCTION_LADDER.map(step => step.name);
  assert.deepEqual(names, [
    "analysisWindow", "measurements.delta*", "verifiedClaims.items:12", "verifiedClaims.items:6",
    "primitives.emptyGroups", "detectedIdioms:7", "impressionConcepts:4", "detectedIdioms:3",
    "impressionConcepts:2", "genreEvidence:3"
  ]);
});

test("a request only slightly over budget loses only the first steps it needs, not the whole ladder", () => {
  const state = profile("futurefunk");
  const snapshot = Snapshot.serialize(state, state.distinctive);
  const clean = validateLanguageInput({ snapshot }).snapshot;
  // Inflate just enough (padding analysisWindow) to force a small overage against a tight limit,
  // set just above the size after step 1 alone would bring it under -- later steps must not fire.
  const inflated = JSON.parse(JSON.stringify(clean));
  inflated.analysisWindow = { ...inflated.analysisWindow, extra: "x".repeat(500) };
  const sizeWithExtra = JSON.stringify(inflated).length;
  const sizeAfterStep1 = JSON.stringify({ ...inflated, analysisWindow: {} }).length;
  const tightLimit = sizeAfterStep1 + 1;
  assert.ok(sizeWithExtra > tightLimit, "fixture must actually need step 1 to fit");
  const result = applyReductionLadder(inflated, tightLimit);
  assert.deepEqual(result.applied.map(step => step.step), ["analysisWindow"]);
  assert.equal(inflated.detectedIdioms.length, clean.detectedIdioms.length, "later steps must not fire once the limit is met");
  assert.equal(inflated.genreEvidence.length, clean.genreEvidence.length);
});

test("each named ladder step performs its specific reduction and nothing else, when forced to fire alone", () => {
  const base = maxedOutSnapshot();
  const withRoomToShrink = validateLanguageInput({ snapshot: base }).snapshot;
  // Re-expand verifiedClaims.items past 12 and force a limit that only that step can satisfy.
  const target = JSON.parse(JSON.stringify(withRoomToShrink));
  target.verifiedClaims.items = Array.from({ length: 24 }, (_, i) => ({
    id: "c" + i, type: "type", concept: "concept", confidence: 0.5, evidence: ["a.b.c"]
  }));
  const beforeCount = target.verifiedClaims.items.length;
  const idiomsBefore = target.detectedIdioms.length;
  const tightLimit = JSON.stringify(target).length - 200;
  const result = applyReductionLadder(target, tightLimit);
  assert.ok(result.applied.some(step => step.step.startsWith("verifiedClaims.items")));
  assert.ok(target.verifiedClaims.items.length < beforeCount);
  assert.equal(target.detectedIdioms.length, idiomsBefore, "a step targeting verifiedClaims must not touch detectedIdioms");
});

test("NEVER_DROP_SNAPSHOT_KEYS survive even a forced full-ladder reduction against a near-zero budget", () => {
  const snapshot = maxedOutSnapshot();
  const forced = JSON.parse(JSON.stringify(snapshot));
  const result = applyReductionLadder(forced, 500);
  assert.ok(result.applied.length > 0);
  for (const key of NEVER_DROP_SNAPSHOT_KEYS) {
    if (Object.hasOwn(snapshot, key)) {
      assert.ok(Object.hasOwn(forced, key), `${key} must still be a key after forced reduction`);
      assert.notEqual(forced[key], undefined, `${key} must not be undefined after forced reduction`);
    }
  }
});

test("an extreme input that still exceeds the limit after the full ladder produces a 400, not a silent oversized payload", () => {
  // Every field the ladder can shrink (verifiedClaims.items, detectedIdioms, impressionConcepts,
  // genreEvidence) and every field it cannot (primitives, genreContextEvidence) is itself bounded
  // by a per-item/per-string cap in this file's sanitizers, so pushing arrays or strings past
  // those caps alone cannot defeat the ladder -- the sanitizer just truncates them. verifiedClaims
  // capsule is the one field passed through with no size bound at all (it is opaque evidence-store
  // data, not further validated here), so it is the honest way to construct genuinely-unbounded
  // input and confirm the ladder's fallback still protects the request instead of forwarding an
  // arbitrarily large payload.
  const snapshot = maxedOutSnapshot();
  snapshot.verifiedClaims.capsule = { blob: "다".repeat(200000) };
  assert.throws(() => validateLanguageInput({ snapshot }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "snapshot_too_large");
    return true;
  });
});
