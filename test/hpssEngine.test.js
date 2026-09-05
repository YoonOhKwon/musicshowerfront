const test = require("node:test");
const assert = require("node:assert/strict");
const Hpss = require("../js/audio/hpssEngine");

function toneFrame(size, bin, peak = 1) {
  const data = new Float32Array(size);
  if (bin > 0) data[bin - 1] = peak * 0.35;
  data[bin] = peak;
  if (bin < size - 1) data[bin + 1] = peak * 0.35;
  return data;
}

test("a sustained tone concentrates energy in the harmonic residual", () => {
  const engine = new Hpss.Engine({ frames: 17, freqWidth: 9 });
  let snapshot;
  for (let index = 0; index < 18; index++) {
    snapshot = engine.observe(toneFrame(64, 20), { sampleRate: 48000, fftSize: 128 });
  }
  assert.equal(snapshot.ready, true);
  assert.ok(snapshot.harmonic[20] > snapshot.percussive[20],
    `harmonic ${snapshot.harmonic[20]} should beat percussive ${snapshot.percussive[20]} on a held tone`);
  assert.ok(snapshot.harmonicRatio > 0.55, `harmonicRatio=${snapshot.harmonicRatio}`);
  assert.match(snapshot.resolution, /not source-separated stems/);
});

test("a one-frame spectral spike is treated as percussive, not a pitch", () => {
  const engine = new Hpss.Engine({ frames: 17, freqWidth: 9 });
  for (let index = 0; index < 16; index++) engine.observe(toneFrame(64, 20), { sampleRate: 48000, fftSize: 128 });
  const burst = new Float32Array(64);
  burst[20] = 1;
  burst[19] = 0.35;
  burst[21] = 0.35;
  burst[48] = 1;
  const snapshot = engine.observe(burst, { sampleRate: 48000, fftSize: 128 });
  assert.ok(snapshot.percussive[48] > snapshot.harmonic[48],
    `percussive ${snapshot.percussive[48]} should beat harmonic ${snapshot.harmonic[48]} on a transient`);
});

test("chroma folding maps A4 energy onto pitch class 9", () => {
  const spectrum = new Float32Array(2048);
  const sampleRate = 44100, fftSize = 4096;
  const a4Bin = Math.round(440 / (sampleRate / fftSize));
  spectrum[a4Bin] = 1;
  const chroma = Hpss.chromaFromMagnitude(spectrum, sampleRate, fftSize);
  assert.equal(chroma.length, 12);
  const peak = chroma.indexOf(Math.max(...chroma));
  assert.equal(peak, 9);
});
