const test = require("node:test");
const assert = require("node:assert/strict");
const TemporalModelAggregation = require("../js/ml/temporalAggregator");

test("actual model frames form distinct fast, mid and long windows", () => {
  const aggregator = new TemporalModelAggregation.Aggregator({ fast: 5, mid: 12, long: 30 });
  const base = 100000;
  const packet = value => ({
    genre: [value, 1 - value],
    embedding: [value, value],
    instrument: [value],
    mood: [1 - value]
  });
  aggregator.add(packet(0.1), base - 20000);
  aggregator.add(packet(0.5), base - 8000);
  const state = aggregator.add(packet(0.9), base);
  assert.equal(state.scales.fast.count, 1);
  assert.equal(state.scales.mid.count, 2);
  assert.equal(state.scales.long.count, 3);
  assert.ok(state.scales.fast.genre[0] > state.scales.long.genre[0]);
  assert.equal(state.diagnostics.observations, 3);
  assert.equal(state.diagnostics.contextSeconds, 20);
  assert.ok(state.diagnostics.genreAgreement > 0);
});

test("rolling aggregation weights recent real patches more strongly", () => {
  const items = [
    { at: 0, genre: [1, 0] },
    { at: 9000, genre: [0, 1] }
  ];
  const weighted = TemporalModelAggregation.weightedMeanVectors(items, "genre", 10000, 3);
  assert.ok(weighted[1] > weighted[0] * 4);
});
