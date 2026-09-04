const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("audio analysis remains local while artistic language has a separate provider", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const values = vm.runInNewContext(`${source}\n;({ semantic: CONFIG.semantic, ai: CONFIG.ai, ml: CONFIG.ml, language: CONFIG.language })`);
  assert.equal(values.semantic.useLLM, false);
  assert.equal(values.ai.autoEnrich, false);
  assert.equal(values.ml.enabled, true);
  assert.deepEqual(Array.from(values.ml.backendPreference), ["webgpu", "wasm"]);
  assert.equal(values.ml.quality, "balanced");
  assert.equal(values.language.remote.enabled, true);
  assert.equal(values.language.minimumIntervalMs, 45000);
});

test("quality modes change real inference cadence and temporal context", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const load = quality => vm.runInNewContext(`${source}\n;CONFIG.ml`, {
    location: { search: `?quality=${quality}` },
    URLSearchParams
  });
  const performance = load("performance");
  const balanced = load("balanced");
  const quality = load("quality");
  assert.ok(performance.inferenceInterval > balanced.inferenceInterval);
  assert.ok(balanced.inferenceInterval > quality.inferenceInterval);
  assert.ok(performance.windows.long < balanced.windows.long);
  assert.ok(balanced.windows.long < quality.windows.long);
});

test("WASM backend can be forced for fallback verification", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const ml = vm.runInNewContext(`${source}\n;CONFIG.ml`, {
    location: { search: "?backend=wasm" },
    URLSearchParams
  });
  assert.deepEqual(Array.from(ml.backendPreference), ["wasm"]);
});

test("real pretrained model assets and verified tensor pipeline are installed", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "models", "music-shower", "manifest.json"),
    "utf8"
  ));
  assert.equal(manifest.available, true);
  assert.equal(manifest.preprocessing.patchFrames, 128);
  assert.equal(manifest.preprocessing.melBands, 96);
  for (const model of Object.values(manifest.models)) {
    assert.match(model.url, /^\//, "worker model URLs must resolve from the server root");
    const modelPath = path.join(__dirname, "..", model.url.replace(/^\//, ""));
    assert.ok(fs.statSync(modelPath).size > 500000);
    assert.match(model.sha256, /^[A-F0-9]{64}$/);
  }
  for (const runtimeUrl of [manifest.runtime.onnxUrl, manifest.runtime.onnxWasmBaseUrl,
    manifest.runtime.essentiaWasmUrl, manifest.runtime.essentiaModelUrl]) {
    assert.match(runtimeUrl, /^\//, "worker runtime URLs must resolve from the server root");
  }
});

test("browser worker binds the Essentia UMD runtime export", () => {
  const worker = fs.readFileSync(path.join(__dirname, "..", "js", "ml", "mlWorker.js"), "utf8");
  assert.match(worker, /self\.exports = \{\}/);
  assert.match(worker, /self\.exports\.EssentiaWASM \|\| self\.Module/);
  assert.match(worker, /delete self\.exports/);
});
