let sessions = null;
let extractor = null;
let modelManifest = null;
let activeBackend = "none";
let sharedRing = null;

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type === "init") return initialize(message);
  if (message.type === "set-shared-ring") {
    const descriptor = message.descriptor;
    sharedRing = descriptor?.headerBuffer && descriptor?.dataBuffer ? {
      header: new Int32Array(descriptor.headerBuffer),
      data: new Float32Array(descriptor.dataBuffer),
      capacity: Number(descriptor.capacity),
      sampleRate: Number(descriptor.sampleRate)
    } : null;
    return;
  }
  if (message.type === "infer") return runInference(message);
};

function readSharedLatest(seconds) {
  if (!sharedRing) return new Float32Array();
  const requested = Math.min(sharedRing.capacity,
    Math.max(1, Math.round(Number(seconds) * sharedRing.sampleRate)));
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = Atomics.load(sharedRing.header, 2);
    if (before & 1) continue;
    const count = Math.min(requested, Math.max(0,
      Math.min(sharedRing.capacity, Atomics.load(sharedRing.header, 1))));
    const writeIndex = Atomics.load(sharedRing.header, 0);
    const output = new Float32Array(count);
    const start = (writeIndex - count + sharedRing.capacity) % sharedRing.capacity;
    const first = Math.min(count, sharedRing.capacity - start);
    output.set(sharedRing.data.subarray(start, start + first));
    if (first < count) output.set(sharedRing.data.subarray(0, count - first), first);
    const after = Atomics.load(sharedRing.header, 2);
    if (before === after && !(after & 1)) return output;
  }
  return new Float32Array();
}

async function initialize({ manifest, backend }) {
  try {
    modelManifest = manifest;
    importScripts(manifest.runtime.onnxUrl);
    if (!self.ort?.InferenceSession) throw new Error("onnxRuntimeUnavailable");
    self.ort.env.logLevel = "error";
    self.ort.env.wasm.wasmPaths = manifest.runtime.onnxWasmBaseUrl;
    self.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(2, navigator.hardwareConcurrency || 1) : 1;

    // essentia.js 0.1.3's UMD artifact writes its module to `exports` without
    // guarding that identifier. A classic Worker has no CommonJS `exports`, so
    // provide a narrow shim only while the official bundle is evaluated.
    self.exports = {};
    importScripts(manifest.runtime.essentiaWasmUrl);
    const essentiaModule = self.exports.EssentiaWASM || self.Module;
    delete self.exports;
    importScripts(manifest.runtime.essentiaModelUrl);
    if (!essentiaModule?.EssentiaJS || !self.EssentiaModel?.EssentiaTFInputExtractor) {
      throw new Error("essentiaRuntimeUnavailable");
    }
    extractor = new self.EssentiaModel.EssentiaTFInputExtractor(essentiaModule, "musicnn", false);

    try {
      sessions = await createSessions(backend);
      activeBackend = backend;
    } catch (error) {
      if (backend !== "webgpu") throw error;
      sessions = await createSessions("wasm");
      activeBackend = "wasm";
    }
    validateSessions();
    self.postMessage({
      type: "ready",
      backend: activeBackend,
      manifest: { name: manifest.name, version: manifest.version }
    });
  } catch (error) {
    self.postMessage({ type: "failed", error: error.message || "modelInitializeFailed" });
  }
}

async function createSessions(backend) {
  const options = {
    executionProviders: [backend === "webgpu" ? "webgpu" : "wasm"],
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
    enableMemPattern: true
  };
  const [encoder, instrument, mood] = await Promise.all([
    self.ort.InferenceSession.create(modelManifest.models.encoder.url, options),
    self.ort.InferenceSession.create(modelManifest.models.instrument.url, options),
    self.ort.InferenceSession.create(modelManifest.models.mood.url, options)
  ]);
  return { encoder, instrument, mood };
}

function validateSessions() {
  const expected = modelManifest.models;
  for (const [name, session] of Object.entries(sessions)) {
    const model = expected[name];
    if (!session.inputNames.includes(model.input)) throw new Error(`${name}InputNameMismatch`);
    for (const output of Object.values(model.outputs)) {
      if (!session.outputNames.includes(output)) throw new Error(`${name}OutputNameMismatch:${output}`);
    }
  }
}

function extractMelPatch(audio) {
  const { frameSize, hopSize, patchFrames, melBands } = modelManifest.preprocessing;
  const expectedSamples = patchFrames * hopSize;
  const startOffset = Math.max(0, audio.length - expectedSamples);
  const features = new Float32Array(patchFrames * melBands);
  const frame = new Float32Array(frameSize);
  for (let frameIndex = 0; frameIndex < patchFrames; frameIndex++) {
    const sourceStart = startOffset + frameIndex * hopSize - frameSize / 2;
    frame.fill(0);
    const copyStart = Math.max(0, sourceStart);
    const copyEnd = Math.min(audio.length, sourceStart + frameSize);
    if (copyEnd > copyStart) frame.set(audio.subarray(copyStart, copyEnd), copyStart - sourceStart);
    const result = extractor.compute(frame);
    if (!result?.melSpectrum || result.melSpectrum.length !== melBands) {
      throw new Error("melExtractionShapeMismatch");
    }
    features.set(result.melSpectrum, frameIndex * melBands);
  }
  return features;
}

function resampleWindowedSinc(source, sourceRate, targetRate, halfTaps = 16) {
  if (!source?.length || !sourceRate || !targetRate) return new Float32Array();
  if (sourceRate === targetRate) return new Float32Array(source);
  const outputLength = Math.max(1, Math.round(source.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  const cutoff = Math.min(1, targetRate / sourceRate) * 0.94;
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio;
    const center = Math.floor(position);
    let weighted = 0;
    let weightSum = 0;
    for (let tap = -halfTaps + 1; tap <= halfTaps; tap++) {
      const sourceIndex = center + tap;
      if (sourceIndex < 0 || sourceIndex >= source.length) continue;
      const distance = position - sourceIndex;
      const x = Math.PI * distance * cutoff;
      const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x;
      const windowPosition = Math.abs(distance) / halfTaps;
      if (windowPosition >= 1) continue;
      const window = 0.5 + 0.5 * Math.cos(Math.PI * windowPosition);
      const weight = sinc * window * cutoff;
      weighted += source[sourceIndex] * weight;
      weightSum += weight;
    }
    output[index] = weightSum ? weighted / weightSum : 0;
  }
  return output;
}

async function runInference({ id, sessionId, analysisWindowId, audio, shared, seconds, sourceSampleRate, dispatchedAt }) {
  if (!sessions || !modelManifest || !extractor) return;
  const startedAt = performance.now();
  try {
    if (shared) audio = readSharedLatest(seconds);
    if (!audio?.length) throw new Error("audioWindowUnavailable");
    const resampleStartedAt = performance.now();
    const modelAudio = resampleWindowedSinc(audio, sourceSampleRate || modelManifest.sampleRate, modelManifest.sampleRate);
    const resampleMs = performance.now() - resampleStartedAt;
    const melStartedAt = performance.now();
    const mel = extractMelPatch(modelAudio);
    const melMs = performance.now() - melStartedAt;
    const preprocessing = modelManifest.preprocessing;
    const melTensor = new self.ort.Tensor("float32", mel, [1, preprocessing.patchFrames, preprocessing.melBands]);
    const encoderModel = modelManifest.models.encoder;
    const encoderStartedAt = performance.now();
    const encoderRaw = await sessions.encoder.run({ [encoderModel.input]: melTensor });
    const encoderMs = performance.now() - encoderStartedAt;
    const genreTensor = encoderRaw[encoderModel.outputs.genre];
    const embeddingTensor = encoderRaw[encoderModel.outputs.embedding];
    if (!genreTensor || !embeddingTensor) throw new Error("encoderOutputsMissing");

    const headInput = new self.ort.Tensor("float32", embeddingTensor.data, [1, embeddingTensor.data.length]);
    // ORT WebGPU serializes command recording internally and can report
    // "Session already started" when two sessions run concurrently. These
    // heads are small, so serialize them while reusing the same embedding.
    const instrumentStartedAt = performance.now();
    const instrumentRaw = await sessions.instrument.run({ [modelManifest.models.instrument.input]: headInput });
    const instrumentMs = performance.now() - instrumentStartedAt;
    const moodStartedAt = performance.now();
    const moodRaw = await sessions.mood.run({ [modelManifest.models.mood.input]: headInput });
    const moodMs = performance.now() - moodStartedAt;
    const outputs = {
      genre: Array.from(genreTensor.data),
      embedding: Array.from(embeddingTensor.data),
      instrument: Array.from(instrumentRaw[modelManifest.models.instrument.outputs.activations].data),
      mood: Array.from(moodRaw[modelManifest.models.mood.outputs.activations].data)
    };
    self.postMessage({
      type: "result",
      id,
      sessionId,
      analysisWindowId,
      outputs,
      latencyMs: performance.now() - startedAt,
      timings: {
        workerQueueMs: Number.isFinite(dispatchedAt) ? Math.max(0, startedAt - dispatchedAt) : 0,
        resampleMs,
        melMs,
        encoderMs,
        instrumentMs,
        moodMs,
        totalMs: performance.now() - startedAt
      }
    });
  } catch (error) {
    self.postMessage({
      type: "result",
      id,
      sessionId,
      analysisWindowId,
      outputs: null,
      error: error.message,
      latencyMs: performance.now() - startedAt
    });
  }
}
