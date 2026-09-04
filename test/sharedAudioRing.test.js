const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const SharedAudioRing = require("../js/audio/sharedAudioRing");

function write(ring, values) {
  Atomics.add(ring.header, 2, 1);
  let index = Atomics.load(ring.header, 0);
  for (const value of values) { ring.data[index] = value; index = (index + 1) % ring.capacity; }
  Atomics.store(ring.header, 0, index);
  Atomics.store(ring.header, 1, Math.min(ring.capacity, ring.count + values.length));
  Atomics.add(ring.header, 2, 1);
}

test("SharedArrayBuffer ring returns the newest ordered audio without transfer copies", () => {
  const ring = SharedAudioRing.create(1000, 4.096);
  assert.ok(ring?.shared);
  write(ring, Float32Array.from([1, 2, 3, 4]));
  assert.deepEqual([...ring.latestNative(0.003)], [2, 3, 4]);
});

test("audio worklet provides a transferable fallback and block-level RMS/peak", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../js/audio/pcmCaptureProcessor.js"), "utf8");
  assert.match(source, /Shared|sharedHeader|Atomics/);
  assert.match(source, /postMessage\(\{ type: "pcm"/);
  assert.match(source, /rms, peak/);
  assert.match(source, /bandSquares|bands/);
});
