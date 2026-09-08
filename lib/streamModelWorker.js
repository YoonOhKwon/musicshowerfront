"use strict";

const { parentPort } = require("node:worker_threads");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const ort = require("onnxruntime-node");
const { EssentiaWASM, EssentiaModel } = require("essentia.js");
const { resampleWindowedSinc } = require("../js/ml/audioPreprocessing");
const root = path.resolve(__dirname, "..");
const manifest = require("../models/music-shower/manifest.json");
let runtime;

async function load() {
  const sessions = {}, labels = {};
  for (const name of ["encoder", "instrument"]) {
    const model = manifest.models[name];
    const file = path.join(root, model.url);
    const bytes = await fs.readFile(file);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash.toLowerCase() !== model.sha256.toLowerCase()) throw new Error(`Model checksum mismatch: ${name}`);
    sessions[name] = await ort.InferenceSession.create(bytes, { intraOpNumThreads: 2, interOpNumThreads: 1 });
  }
  for (const name of ["genre", "instrument"]) {
    labels[name] = JSON.parse(await fs.readFile(path.join(root, manifest.metadataUrls[name]), "utf8")).classes;
  }
  return { sessions, labels, extractor: new EssentiaModel.EssentiaTFInputExtractor(EssentiaWASM, "musicnn", false) };
}

async function infer({ samples, sampleRate }) {
  runtime ||= load();
  const { sessions, labels, extractor } = await runtime;
  const { frameSize, hopSize, patchFrames, melBands } = manifest.preprocessing;
  const pcm = sampleRate === manifest.sampleRate ? samples : resampleWindowedSinc(samples, sampleRate, manifest.sampleRate);
  const audio = pcm.subarray(-patchFrames * hopSize);
  if (audio.length < patchFrames * hopSize) throw new Error("Insufficient model audio window");
  const features = new Float32Array(patchFrames * melBands), frame = new Float32Array(frameSize);
  for (let i = 0; i < patchFrames; i++) {
    const start = i * hopSize - frameSize / 2;
    frame.fill(0);
    const from = Math.max(0, start), to = Math.min(audio.length, start + frameSize);
    if (to > from) frame.set(audio.subarray(from, to), from - start);
    const mel = extractor.compute(frame).melSpectrum;
    if (mel.length !== melBands) throw new Error("Unexpected mel dimensions");
    features.set(mel, i * melBands);
  }
  const result = await sessions.encoder.run({ [manifest.models.encoder.input]:
    new ort.Tensor("float32", features, [1, patchFrames, melBands]) });
  const embedding = result[manifest.models.encoder.outputs.embedding].data;
  const instrument = await sessions.instrument.run({ [manifest.models.instrument.input]:
    new ort.Tensor("float32", embedding, [1, embedding.length]) });
  const output = { genre: Array.from(result[manifest.models.encoder.outputs.genre].data),
    embedding: Array.from(embedding), instrument: Array.from(instrument[manifest.models.instrument.outputs.activations].data),
    labels, activations: manifest.activations, model: manifest.version };
  if (output.genre.length !== labels.genre.length || output.instrument.length !== labels.instrument.length ||
      ![...output.genre, ...output.instrument, ...output.embedding].every(Number.isFinite)) throw new Error("Invalid model output");
  return output;
}

// One worker owns the shared native models. Inference and mel extraction never block
// the WebSocket server, and concurrent listeners do not multiply model allocations.
let queue = Promise.resolve();
parentPort.on("message", task => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: task.id, result: await infer(task) }); }
    catch (error) { parentPort.postMessage({ id: task.id, error: String(error.message || error) }); }
  });
});
