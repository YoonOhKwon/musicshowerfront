const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Registry = require("../js/semantic/openWorldConceptRegistry");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const hierarchy = require("../data/genreHierarchy.json");

const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
const mainSource = fs.readFileSync(path.resolve(__dirname, "../js/main.js"), "utf8");
const engineSource = fs.readFileSync(path.resolve(__dirname, "../js/semantic/semanticEngine.js"), "utf8");
const composeEndpoint = serverSource.split('app.post("/api/compose-genre"')[1].split('app.post(')[0];

// CONTEXT's third stage reconciles two readings of the same audio: the fixed-label classifier's
// and Music Flamingo's. The danger it has to avoid is being mistaken for a third listener --
// it never hears anything, so counting it as independent corroboration would let one reading
// confirm itself through a paraphrase.

test("the reconciler declares both of its inputs as conditioning, so it cannot be a third witness", () => {
  assert.match(engineSource, /conditionedOnClassifier: true/);
  assert.match(engineSource, /conditioningSources: \["genre-classifier", "music-flamingo"\]/);
  assert.match(engineSource, /sourceFamily: "llmComposite"/);
  assert.match(engineSource, /independenceGroup: `llm-composite:\$\{observationId\}`/,
    "its own independence group: repeated reconciliations must not multiply support either");
});

test("a reconciled name does not inflate a concept's independent corroboration", () => {
  const Reg = Registry.Registry;
  const now = Date.now();

  const heardOnly = new Reg();
  heardOnly.propose({ label: "Uncatalogued Pulse", conceptType: "genre", source: "directAudio",
    sourceFamily: "directAudio", sourceModel: "music-flamingo", confidence: 0.66,
    observationId: "o1", independenceGroup: "flamingo", audioSegmentId: "seg1" }, now);

  const alsoReconciled = new Reg();
  alsoReconciled.propose({ label: "Uncatalogued Pulse", conceptType: "genre", source: "directAudio",
    sourceFamily: "directAudio", sourceModel: "music-flamingo", confidence: 0.66,
    observationId: "o1", independenceGroup: "flamingo", audioSegmentId: "seg1" }, now);
  alsoReconciled.propose({ label: "Uncatalogued Pulse", conceptType: "genre",
    source: "genre-composition-llm", sourceFamily: "llmComposite", sourceModel: "llm-composer",
    confidence: 0.7, observationId: "o1-composed", independenceGroup: "llm-composite:o1-composed",
    audioSegmentId: "seg1", conditionedOnClassifier: true,
    conditioningSources: ["genre-classifier", "music-flamingo"] }, now);

  const a = heardOnly.get("Uncatalogued Pulse", "genre");
  const b = alsoReconciled.get("Uncatalogued Pulse", "genre");
  assert.ok(a && b);
  assert.equal(b.hasIndependentDeepListen, a.hasIndependentDeepListen,
    "a reconciliation is not another independent listen");
  assert.ok((b.seenAudioSegments || []).length <= 1,
    "reconciling a reading does not add a second heard segment");
});

test("a conflict is recorded as unresolved, never as a confident new name", () => {
  assert.match(engineSource, /item\.relation === "conflict"/);
  assert.match(engineSource, /Math\.min\(0\.4, Number\(item\.confidence\)/,
    "if the two readings cannot both be true, the composite must not outrank either of them");
});

test("the reconciliation prompt shows no specimen genre names", () => {
  const classes = require("../models/music-shower/assets/discogs-effnet-bsdynamic-1.json").classes;
  const specimens = [...new Set(classes.map((name) => name.split("---").pop()))]
    .filter((name) => name.trim().includes(" "));
  const haystack = composeEndpoint.toLowerCase();
  assert.deepEqual(specimens.filter((name) => haystack.includes(name.toLowerCase())), [],
    "an example label narrows what an open-vocabulary model is willing to answer");
});

test("the reconciler is told it may name something outside both readings", () => {
  assert.match(composeEndpoint, /not restricted to the labels above/i);
  assert.match(composeEndpoint, /must not invent one to/i,
    "open vocabulary is not licence to fill the field");
  assert.match(composeEndpoint, /specialization/,
    "the useful case is Flamingo naming something narrower than the classifier's territory");
});

test("CONTEXT keeps working on the classifier's own reading while reconciliation is in flight", () => {
  assert.match(mainSource, /fire-and-forget/i);
  assert.ok(!/await fetch\("\/api\/compose-genre"/.test(mainSource),
    "a slow reconciliation must never delay the words already available");
  assert.match(mainSource, /composeController\.abort\(\)/,
    "and it must be abandoned when the capture it belongs to is superseded");
});

test("a reconciled name still has to survive the same evidence gate as any other hypothesis", () => {
  // Filed as an ordinary open-world concept: no privileged path into the genre engine.
  const result = new GenreHypotheses.Engine({}, hierarchy).evaluate({
    classifierGenre: { primary: "J-pop", uncertain: false, semanticConfidence: 0.74, confidence: 0.74,
      topK: [{ label: "J-pop", confidence: 0.09 }] },
    openWorldConcepts: [{ canonicalLabel: "Reconciled Name", conceptType: "genre", confidence: 0.7,
      status: "provisional", sources: ["genre-composition-llm"], temporalSupport: 1, relatedLabels: [] }]
  }, 0);
  const item = result.hypotheses.find((entry) => entry.genre === "Reconciled Name");
  assert.ok(item, "it is a hypothesis like any other");
  assert.equal(item.kind, "open-world",
    "with nothing in the classifier's top-K corroborating it, it is not a composite");
  assert.ok(item.semanticConfidence <= 0.72,
    "one family alone stays capped, whichever family it is");
});
