import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import decode from "audio-decode";
import * as ort from "onnxruntime-node";

const require = createRequire(import.meta.url);
const { EssentiaWASM, EssentiaModel } = require("essentia.js");
const AudioWindowBuffer = require("../js/ml/audioPreprocessing.js");
const projectRoot = path.resolve(import.meta.dirname, "..");
const assetRoot = path.join(projectRoot, "models", "music-shower", "assets");
const fixtureRoot = path.join(projectRoot, "test", "fixtures", "audio");
const preprocessing = { frameSize: 512, hopSize: 256, patchFrames: 128, melBands: 96 };

const metadata = {
  genre: JSON.parse(await fs.readFile(path.join(assetRoot, "discogs-effnet-bsdynamic-1.json"), "utf8")),
  instrument: JSON.parse(await fs.readFile(path.join(assetRoot, "mtg_jamendo_instrument-discogs-effnet-1.json"), "utf8")),
  mood: JSON.parse(await fs.readFile(path.join(assetRoot, "mtg_jamendo_moodtheme-discogs-effnet-1.json"), "utf8"))
};

const modelLoadStartedAt = performance.now();
const [encoder, instrument, mood] = await Promise.all([
  ort.InferenceSession.create(path.join(assetRoot, "discogs-effnet-bsdynamic-1.onnx")),
  ort.InferenceSession.create(path.join(assetRoot, "mtg_jamendo_instrument-discogs-effnet-1.onnx")),
  ort.InferenceSession.create(path.join(assetRoot, "mtg_jamendo_moodtheme-discogs-effnet-1.onnx"))
]);
const modelLoadMs = performance.now() - modelLoadStartedAt;
const extractor = new EssentiaModel.EssentiaTFInputExtractor(EssentiaWASM, "musicnn", false);

function mixToMono(audioBuffer) {
  const channels = audioBuffer.channelData || [];
  assert.ok(channels.length, "decoded audio must contain channels");
  const mono = new Float32Array(channels[0].length);
  for (const data of channels) {
    for (let index = 0; index < mono.length; index++) mono[index] += data[index] / channels.length;
  }
  return mono;
}

function extractMelPatch(audio) {
  const features = new Float32Array(preprocessing.patchFrames * preprocessing.melBands);
  const frame = new Float32Array(preprocessing.frameSize);
  for (let frameIndex = 0; frameIndex < preprocessing.patchFrames; frameIndex++) {
    const sourceStart = frameIndex * preprocessing.hopSize - preprocessing.frameSize / 2;
    frame.fill(0);
    const copyStart = Math.max(0, sourceStart);
    const copyEnd = Math.min(audio.length, sourceStart + preprocessing.frameSize);
    if (copyEnd > copyStart) frame.set(audio.subarray(copyStart, copyEnd), copyStart - sourceStart);
    const mel = extractor.compute(frame).melSpectrum;
    assert.equal(mel.length, preprocessing.melBands, "Essentia mel band count");
    features.set(mel, frameIndex * preprocessing.melBands);
  }
  return features;
}

function average(vectors) {
  const output = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    for (let index = 0; index < output.length; index++) output[index] += vector[index] / vectors.length;
  }
  return output;
}

function topK(values, labels, count = 5) {
  return Array.from(values, (confidence, index) => ({ label: labels[index], confidence }))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, count);
}

async function analyzeFixture(filename) {
  const encoded = await fs.readFile(path.join(fixtureRoot, filename));
  const decoded = await decode(encoded);
  const mono = mixToMono(decoded);
  const audio = AudioWindowBuffer.resampleWindowedSinc(mono, decoded.sampleRate, 16000);
  const patchSamples = preprocessing.patchFrames * preprocessing.hopSize;
  const starts = [0, Math.max(0, Math.floor((audio.length - patchSamples) / 2)), Math.max(0, audio.length - patchSamples)];
  const genreVectors = [];
  const embeddingVectors = [];
  const instrumentVectors = [];
  const moodVectors = [];
  const timings = { melMs: 0, encoderMs: 0, headsMs: 0 };

  for (const start of starts) {
    const patch = audio.subarray(start, Math.min(audio.length, start + patchSamples));
    let startedAt = performance.now();
    const mel = extractMelPatch(patch);
    timings.melMs += performance.now() - startedAt;
    startedAt = performance.now();
    const encoderResult = await encoder.run({ melspectrogram: new ort.Tensor("float32", mel, [1, 128, 96]) });
    timings.encoderMs += performance.now() - startedAt;
    const embedding = encoderResult.embeddings.data;
    const headTensor = new ort.Tensor("float32", embedding, [1, 1280]);
    startedAt = performance.now();
    const [instrumentResult, moodResult] = await Promise.all([
      instrument.run({ embeddings: headTensor }),
      mood.run({ embeddings: headTensor })
    ]);
    timings.headsMs += performance.now() - startedAt;
    genreVectors.push(encoderResult.activations.data);
    embeddingVectors.push(embedding);
    instrumentVectors.push(instrumentResult.activations.data);
    moodVectors.push(moodResult.activations.data);
  }

  const result = {
    filename,
    genre: average(genreVectors),
    embedding: average(embeddingVectors),
    instrument: average(instrumentVectors),
    mood: average(moodVectors),
    timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, value / starts.length]))
  };
  assert.equal(result.genre.length, 400);
  assert.equal(result.embedding.length, 1280);
  assert.equal(result.instrument.length, 40);
  assert.equal(result.mood.length, 56);
  assert.ok(Object.values(result).filter(value => value instanceof Float32Array).every(vector => vector.every(Number.isFinite)));
  return result;
}

const results = [];
for (const filename of ["outfoxing.mp3", "horns.mp3", "drums.mp3"]) {
  const result = await analyzeFixture(filename);
  results.push(result);
  console.log(`\n${filename}`);
  console.log("genre", topK(result.genre, metadata.genre.classes));
  console.log("instrument", topK(result.instrument, metadata.instrument.classes));
  console.log("mood", topK(result.mood, metadata.mood.classes));
  console.log("mean patch timings ms", Object.fromEntries(Object.entries(result.timings).map(([key, value]) => [key, Number(value.toFixed(2))])));
}

const signatures = results.map(result => topK(result.genre, metadata.genre.classes).map(item => item.label).join("|"));
assert.ok(new Set(signatures).size > 1, "different real audio must change genre Top-K");
const instrumentSignatures = results.map(result => topK(result.instrument, metadata.instrument.classes).map(item => item.label).join("|"));
assert.ok(new Set(instrumentSignatures).size > 1, "different stems must change instrument Top-K");
extractor.delete();
console.log(`\nModel load ${modelLoadMs.toFixed(2)}ms; bundled ONNX ${(23473532 / 1024 / 1024).toFixed(1)}MiB.`);
console.log("PASS: real audio produced finite, shape-correct, input-dependent model outputs.");
