const test = require("node:test");
const assert = require("node:assert/strict");
const MIR = require("../js/mir/mirEngine");

test("MIR layer exposes stable tempo, chroma and a confidence-gated key estimate", () => {
  const engine = new MIR.Engine();
  const chroma = [1, 0.1, 0.2, 0.1, 0.82, 0.35, 0.1, 0.88, 0.1, 0.2, 0.1, 0.22];
  engine.update({ bpm: 120, beatConfidence: 0.9, chroma, tonalFocus: 0.9, rhythmicGrammar: { fourOnFloor: 0.88, confidence: 0.9 } }, 1000);
  const result = engine.update({ bpm: 121, beatConfidence: 0.88, chroma, tonalFocus: 0.9, rhythmicGrammar: { fourOnFloor: 0.9, confidence: 0.9 } }, 2000);
  assert.ok(result.tempo.bpm >= 120 && result.tempo.bpm <= 121);
  assert.equal(result.chroma.vector.length, 12);
  assert.equal(result.tonal.method, "chroma-template");
  assert.ok(result.tonal.key);
  assert.equal(result.rhythm.fourOnFloor, 0.9);
});

test("MIR layer refuses a key when tonal evidence is weak", () => {
  assert.equal(MIR.estimateKey(Array(12).fill(1 / 12), 0.1).key, null);
});
