const test = require("node:test");
const assert = require("node:assert/strict");
const AudioWindowBuffer = require("../js/ml/audioPreprocessing");

test("windowed-sinc resampling has the requested length and preserves finite audio", () => {
  const source = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(2 * Math.PI * 440 * index / 48000));
  const output = AudioWindowBuffer.resampleWindowedSinc(source, 48000, 16000);
  assert.equal(output.length, 16000);
  assert.ok(output.every(Number.isFinite));
  const rms = Math.sqrt(output.reduce((sum, value) => sum + value * value, 0) / output.length);
  assert.ok(rms > 0.65 && rms < 0.75);
});
