const test = require("node:test");
const assert = require("node:assert/strict");
const DirectAudioReview = require("../lib/directAudioReview");
const OpenWorld = require("../js/semantic/openWorldConceptRegistry");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const hierarchy = require("../data/genreHierarchy.json");

function classifierState(openWorldConcepts) {
  return {
    classifierGenre: {
      primary: "Drum & Bass", uncertain: false, confidence: 0.76, semanticConfidence: 0.76,
      topK: [
        { label: "Drum & Bass", confidence: 0.12 },
        { label: "Ambient", confidence: 0.08 },
        { label: "Jungle", confidence: 0.05 }
      ]
    },
    openWorldConcepts
  };
}

function packetObservation({ observationId, segmentId, conditioned = false }) {
  const review = DirectAudioReview.reviewCaption({
    provider: "music-flamingo",
    observationId,
    audioSegmentId: segmentId,
    continuity: conditioned ? {
      genreAdvisoryUsed: true,
      genreAdvisoryCandidates: ["Drum & Bass", "Ambient", "Jungle"]
    } : { genreAdvisoryUsed: false, genreAdvisoryCandidates: [] },
    structuredPacket: {
      genreHypotheses: [{
        label: "Aurora Breaks", confidence: 0.7,
        reasoningHints: "breakbeats airy pads"
      }]
    }
  });
  return DirectAudioReview.toObservations(review).find(item => item.category === "genre");
}

function ingest(registry, observation) {
  return registry.propose({
    label: observation.text,
    conceptType: "genre",
    source: observation.source,
    sourceFamily: observation.sourceFamily,
    sourceModel: observation.sourceModel,
    observationId: observation.observationId,
    independenceGroup: observation.independenceGroup,
    audioSegmentId: observation.audioSegmentId,
    confidence: observation.confidence,
    supportingEvidence: observation.anchors,
    reasoningHints: observation.reasoningHints,
    conditionedOnClassifier: observation.conditionedOnClassifier,
    conditioningSources: observation.conditioningSources,
    conditioningCandidateLabels: observation.conditioningCandidateLabels
  });
}

test("blind Flamingo packet reaches the registry and becomes a runtime-derived composite", () => {
  const registry = new OpenWorld.Registry();
  const observation = packetObservation({ observationId: "blind-1", segmentId: "segment-1" });
  assert.ok(observation, "the real packet bridge must produce a genre observation");
  assert.equal(observation.conditionedOnClassifier, false);
  ingest(registry, observation);
  registry.proposeExpansion("Aurora Breaks", {
    lineage: [
      { text: "Drum & Bass", confidence: 0.44 },
      { text: "Ambient", confidence: 0.4 }
    ]
  });

  const compact = registry.all({ compact: true });
  const result = new GenreHypotheses.Engine({}, hierarchy).evaluate(classifierState(compact), 0);
  const composite = result.hypotheses.find(item => item.genre === "Aurora Breaks");
  assert.ok(composite, "a name supplied only at runtime must survive the full path");
  assert.equal(composite.kind, "composite");
  assert.deepEqual([...composite.independentEvidenceFamilies].sort(), ["deepListen", "genreModel"]);
  assert.ok(composite.compositeOf.includes("Drum & Bass"));
});

test("classifier-assisted Flamingo is discounted until a different audio segment repeats it", () => {
  const registry = new OpenWorld.Registry();
  const first = packetObservation({ observationId: "assisted-1", segmentId: "segment-1", conditioned: true });
  assert.equal(first.conditionedOnClassifier, true);
  assert.deepEqual(first.conditioningCandidateLabels, ["Drum & Bass", "Ambient", "Jungle"]);
  ingest(registry, first);
  registry.proposeExpansion("Aurora Breaks", {
    lineage: [{ text: "Drum & Bass", confidence: 0.44 }, { text: "Ambient", confidence: 0.4 }]
  });

  let result = new GenreHypotheses.Engine({}, hierarchy)
    .evaluate(classifierState(registry.all({ compact: true })), 0);
  let composite = result.hypotheses.find(item => item.genre === "Aurora Breaks");
  assert.equal(composite.kind, "assisted-composite");
  assert.deepEqual(composite.independentEvidenceFamilies, ["assistedFusion"]);
  assert.equal(composite.independentEvidenceCount, 1,
    "showing Flamingo the classifier shortlist must not manufacture a second vote");

  ingest(registry, packetObservation({
    observationId: "assisted-2", segmentId: "segment-2", conditioned: true
  }));
  result = new GenreHypotheses.Engine({}, hierarchy)
    .evaluate(classifierState(registry.all({ compact: true })), 30000);
  composite = result.hypotheses.find(item => item.genre === "Aurora Breaks");
  assert.deepEqual([...composite.independentEvidenceFamilies].sort(), ["assistedFusion", "crossSegment"]);
  assert.equal(composite.independentEvidenceCount, 2);
});

test("scene and lineage context can never become the primary genre", () => {
  const concepts = [
    { canonicalLabel: "Tokyo Night Scene", conceptType: "scene", confidence: 0.92, sources: ["directAudio"] },
    { canonicalLabel: "UK Bass Lineage", conceptType: "lineage", confidence: 0.91, sources: ["directAudio"] }
  ];
  const result = new GenreHypotheses.Engine({}, hierarchy).evaluate(classifierState(concepts), 0);
  assert.equal(result.hypotheses.some(item => item.genre === "Tokyo Night Scene"), false);
  assert.equal(result.hypotheses.some(item => item.genre === "UK Bass Lineage"), false);
  assert.equal(result.primary.genre, "Drum & Bass");
});
