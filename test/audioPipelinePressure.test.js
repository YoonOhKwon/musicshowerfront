const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const AudioWindowBuffer = require("../js/ml/audioPreprocessing");

test("PCM capture batches audio quanta to roughly 10-25 messages per second", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../js/audio/pcmCaptureProcessor.js"), "utf8");
  assert.match(source, /new Float32Array\(this\.blockSize\)/);
  assert.match(source, /postMessage\([^;]+\[completed\.buffer\]/s);
  const messagesPerSecond = 48000 / 4096;
  assert.ok(messagesPerSecond >= 10 && messagesPerSecond <= 25);
});

test("Meyda descriptors run from AudioWorklet batches without deprecated ScriptProcessorNode", () => {
  const engine = fs.readFileSync(path.resolve(__dirname, "../js/audio/audioEngine.js"), "utf8");
  const worker = fs.readFileSync(path.resolve(__dirname, "../js/audio/meydaFeatureWorker.js"), "utf8");
  assert.doesNotMatch(engine, /createMeydaAnalyzer|ScriptProcessorNode/);
  assert.match(engine, /new Worker\("\.\/js\/audio\/meydaFeatureWorker\.js"\)/);
  assert.match(worker, /Meyda\.extract/);
  assert.match(worker, /readSharedLatest/);
});

test("native PCM window is copied without main-thread resampling", () => {
  const buffer = new AudioWindowBuffer(48000, 3);
  buffer.push(new Float32Array(48000).fill(0.25));
  const native = buffer.latestNative(0.5);
  assert.equal(native.length, 24000);
  assert.equal(native[0], 0.25);
  const semanticSource = fs.readFileSync(path.resolve(__dirname, "../js/semantic/semanticEngine.js"), "utf8");
  assert.match(semanticSource, /getMLAudioWindow\(seconds\)/);
  assert.doesNotMatch(semanticSource, /getMLAudioWindow\(seconds,\s*manifest\.sampleRate\)/);
});
