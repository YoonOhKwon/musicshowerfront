const test = require("node:test");
const assert = require("node:assert/strict");
const InstrumentationEvents = require("../js/semantic/instrumentationEventEngine");

function frame(items) {
  return { observed: items.map(([id, confidence, dominance]) => ({ id, confidence, dominance })) };
}

test("three instruments sustained together across recent frames read as a trio", () => {
  const frames = Array.from({ length: 10 }, () => frame([
    ["piano", 0.7, 0.35], ["bass", 0.6, 0.3], ["drums", 0.55, 0.25]
  ]));
  assert.equal(InstrumentationEvents.stableEnsembleSize(frames), 3);
});

test("an instrument that only appears briefly does not count toward the stable core", () => {
  const frames = [
    ...Array.from({ length: 9 }, () => frame([["piano", 0.7, 0.4], ["bass", 0.6, 0.3]])),
    frame([["piano", 0.7, 0.4], ["bass", 0.6, 0.3], ["saxophone", 0.55, 0.2]])
  ];
  assert.equal(InstrumentationEvents.stableEnsembleSize(frames), 2);
});

test("weak confidence or dominance excludes an instrument from the count", () => {
  const frames = Array.from({ length: 10 }, () => frame([
    ["piano", 0.7, 0.4], ["bass", 0.6, 0.3], ["synthesizer", 0.4, 0.05]
  ]));
  assert.equal(InstrumentationEvents.stableEnsembleSize(frames), 2);
});

test("fewer than the minimum frame count refuses to estimate a size", () => {
  const frames = Array.from({ length: 3 }, () => frame([["piano", 0.7, 0.4], ["bass", 0.6, 0.3]]));
  assert.equal(InstrumentationEvents.stableEnsembleSize(frames), null);
});

test("a single sustained instrument alone is not called an ensemble", () => {
  const frames = Array.from({ length: 10 }, () => frame([["piano", 0.8, 0.9]]));
  assert.equal(InstrumentationEvents.stableEnsembleSize(frames), null);
});
