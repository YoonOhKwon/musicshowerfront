const test = require("node:test");
const assert = require("node:assert/strict");
const GenreAdvisory = require("../js/semantic/genreAdvisory");

test("uncertain classifier output is never sent as a Flamingo advisory", () => {
  const advisory = GenreAdvisory.build({
    classifierGenre: {
      classifierRawTopK: [
        { label: "City Pop", confidence: 0.31 },
        { label: "Nu Disco", confidence: 0.24 }
      ],
      margin: 0.07, entropy: 0.81, uncertain: true
    },
    // This fused value may have come from a previous Flamingo packet and must never be echoed.
    genre: { topK: [{ label: "Future Funk", confidence: 0.93 }] }
  });
  assert.equal(advisory, null);
});

test("reliable genre advisory contains only the pre-Flamingo classifier view", () => {
  const advisory = GenreAdvisory.build({
    classifierGenre: {
      classifierRawTopK: [
        { label: "City Pop", confidence: 0.31 },
        { label: "Nu Disco", confidence: 0.24 }
      ],
      semanticConfidence: 0.58,
      margin: 0.07, entropy: 0.81, uncertain: false
    },
    genre: { topK: [{ label: "Future Funk", confidence: 0.93 }] }
  });
  assert.deepEqual(advisory.candidates.map(item => item.label), ["City Pop", "Nu Disco"]);
  assert.equal(advisory.candidates.some(item => item.label === "Future Funk"), false);
  assert.deepEqual(advisory.uncertainty, {
    margin: 0.07, entropy: 0.81, uncertain: false, semanticConfidence: 0.58
  });
});

test("weak or high-entropy low-margin classifier rankings cannot anchor Flamingo", () => {
  const base = { classifierRawTopK: [{ label: "House", confidence: 0.08 }], uncertain: false };
  assert.equal(GenreAdvisory.build({ classifierGenre: {
    ...base, semanticConfidence: 0.42, margin: 0.03, entropy: 0.7
  } }), null);
  assert.equal(GenreAdvisory.build({ classifierGenre: {
    ...base, semanticConfidence: 0.7, margin: 0.005, entropy: 0.95
  } }), null);
});

test("genre advisory is bounded, deduplicated, and round-trips multilingual labels", () => {
  const advisory = GenreAdvisory.sanitize({
    candidates: [
      { label: "시부야케이", score: 1.4 },
      { label: "시부야케이", score: 0.4 },
      { label: "Drum & Bass", score: 0.7 },
      { label: "Ambient", score: 0.6 },
      { label: "House", score: 0.5 },
      { label: "Jazz", score: 0.4 },
      { label: "Rock", score: 0.3 }
    ],
    uncertainty: { margin: -1, entropy: 2, uncertain: false }
  });
  assert.equal(advisory.candidates.length, 5);
  assert.equal(advisory.candidates[0].score, 1);
  assert.deepEqual(GenreAdvisory.decode(GenreAdvisory.encode(advisory)), advisory);
});

test("server-side reliability validation rejects capsules that bypass build()", () => {
  assert.equal(GenreAdvisory.isReliable(GenreAdvisory.sanitize({
    candidates: [{ label: "House", score: 0.1 }],
    uncertainty: { uncertain: true, semanticConfidence: 0.8, margin: 0.1, entropy: 0.4 }
  })), false);
  assert.equal(GenreAdvisory.isReliable(GenreAdvisory.sanitize({
    candidates: [{ label: "Jazz", score: 0.1 }],
    uncertainty: { uncertain: false, semanticConfidence: 0.6, margin: 0.04, entropy: 0.7 }
  })), true);
});

test("genre advisory rejects malformed or oversized transport data", () => {
  assert.equal(GenreAdvisory.decode("not+base64"), null);
  assert.equal(GenreAdvisory.decode("a".repeat(4097)), null);
  assert.equal(GenreAdvisory.build({ genre: { topK: [{ label: "Echoed Flamingo", confidence: 1 }] } }), null);
});

test("word-pool generation never requests an assisted Flamingo listen", () => {
  for (const capture of [1, 2, 3, 4, 6, 12]) {
    assert.equal(GenreAdvisory.shouldAssist(capture), false, `capture ${capture} must stay blind`);
  }
});
