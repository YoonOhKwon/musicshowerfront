let sharedRing = null;
let sampleRate = 48000;
let bufferSize = 2048;
let mfccCoefficients = 20;
let loadError = null;

const FEATURE_EXTRACTORS = [
  "chroma", "mfcc", "rms", "energy", "zcr", "loudness",
  "spectralCentroid", "spectralFlatness", "spectralRolloff", "spectralSpread",
  "spectralSkewness", "spectralKurtosis", "spectralCrest",
  "perceptualSharpness", "perceptualSpread"
];

try {
  importScripts("https://cdn.jsdelivr.net/npm/meyda@5.6.3/dist/web/meyda.min.js");
} catch (error) {
  loadError = error.message || "meydaWorkerRuntimeUnavailable";
}

function attachSharedRing(descriptor) {
  sharedRing = descriptor?.headerBuffer && descriptor?.dataBuffer ? {
    header: new Int32Array(descriptor.headerBuffer),
    data: new Float32Array(descriptor.dataBuffer),
    capacity: Number(descriptor.capacity) || 0
  } : null;
}

function readSharedLatest(length) {
  if (!sharedRing?.capacity) return new Float32Array();
  const requested = Math.min(sharedRing.capacity, Math.max(1, length));
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

function analyze(samples) {
  if (loadError || !self.Meyda?.extract) throw new Error(loadError || "meydaWorkerRuntimeUnavailable");
  const source = samples?.length ? samples : readSharedLatest(bufferSize);
  if (source.length < bufferSize) return null;
  const frame = source.length === bufferSize ? source : source.subarray(source.length - bufferSize);
  self.Meyda.sampleRate = sampleRate;
  self.Meyda.bufferSize = bufferSize;
  self.Meyda.numberOfMFCCCoefficients = mfccCoefficients;
  return self.Meyda.extract(FEATURE_EXTRACTORS, frame);
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === "init") {
    sampleRate = Math.max(8000, Number(message.sampleRate) || 48000);
    bufferSize = Math.max(512, Number(message.bufferSize) || 2048);
    mfccCoefficients = Math.max(8, Number(message.mfccCoefficients) || 20);
    attachSharedRing(message.sharedRing);
    if (loadError) self.postMessage({ type: "failed", error: loadError });
    return;
  }
  if (message.type !== "analyze") return;
  try {
    const features = analyze(message.samples);
    self.postMessage({ type: "features", features, bufferSize });
  } catch (error) {
    self.postMessage({ type: "failed", error: error.message || "meydaWorkerAnalysisFailed" });
  }
};
