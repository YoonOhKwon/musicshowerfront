const test = require('node:test');
const assert = require('node:assert/strict');
const { AudibleAudioBuffer } = require('../js/audio/audibleAudioBuffer');

test('push accumulates chunks up to capacity without silence ever being pushed', () => {
  const buf = new AudibleAudioBuffer(10, 3); // 10 samples/sec, 3s capacity = 30 samples
  buf.push(new Float32Array(5).fill(1));
  buf.push(new Float32Array(5).fill(2));
  assert.equal(buf.filled, 10);
  assert.equal(buf.seconds(), 1);
  const snap = buf.snapshot();
  assert.equal(snap.length, 10);
  assert.equal(snap[0], 1);
  assert.equal(snap[9], 2);
});

test('a wall-clock gap with no push (silence) never appears in the buffer', () => {
  const buf = new AudibleAudioBuffer(10, 3);
  buf.push(new Float32Array(10).fill(1)); // 1s of "audio"
  // Simulate 5 real seconds of silence: caller simply never calls push() during that time.
  buf.push(new Float32Array(10).fill(9)); // 1s more of "audio" right after the silent gap
  assert.equal(buf.seconds(), 2, 'only the two audible seconds occupy the buffer, not the silent gap');
  const snap = buf.snapshot();
  assert.ok(snap.slice(0, 10).every(v => v === 1));
  assert.ok(snap.slice(10, 20).every(v => v === 9));
});

test('oldest samples are dropped once capacity is exceeded', () => {
  const buf = new AudibleAudioBuffer(10, 2); // 20-sample capacity
  buf.push(new Float32Array(15).fill(1));
  buf.push(new Float32Array(15).fill(2));
  assert.equal(buf.filled, 20);
  const snap = buf.snapshot();
  // First 10 of chunk 2 overflow... last 15 samples are all "2", first 5 remaining are tail of "1"
  assert.equal(snap[0], 1);
  assert.equal(snap[snap.length - 1], 2);
});

test('a single chunk larger than capacity keeps only its most recent tail', () => {
  const buf = new AudibleAudioBuffer(10, 1); // 10-sample capacity
  const big = new Float32Array(25);
  for (let i = 0; i < big.length; i++) big[i] = i;
  buf.push(big);
  assert.equal(buf.filled, 10);
  const snap = buf.snapshot();
  assert.equal(snap[0], 15);
  assert.equal(snap[9], 24);
});

test('reset clears accumulated audible content (required on a genuine new track)', () => {
  const buf = new AudibleAudioBuffer(10, 3);
  buf.push(new Float32Array(10).fill(1));
  assert.equal(buf.seconds(), 1);
  buf.reset();
  assert.equal(buf.seconds(), 0);
  assert.equal(buf.snapshot().length, 0);
});

test('an empty or missing chunk is a safe no-op', () => {
  const buf = new AudibleAudioBuffer(10, 3);
  buf.push(null);
  buf.push(new Float32Array(0));
  assert.equal(buf.filled, 0);
});

test('a larger cap lets the buffer grow ACROSS multiple 30s-equivalent chunks before it starts sliding (cumulative captures within one song)', () => {
  const buf = new AudibleAudioBuffer(10, 90); // 10 samples/sec, 90s cap -> 900-sample capacity
  // Chunk 1: 30s of "1"s (first capture's worth)
  buf.push(new Float32Array(300).fill(1));
  assert.equal(buf.seconds(), 30, 'first chunk alone is 30s, matching the first capture');

  // Chunk 2: another 30s of "2"s, recorded while the first capture was in flight being analyzed.
  // A capture reading the cache NOW must see BOTH chunks merged (60s), not just the newest 30s.
  buf.push(new Float32Array(300).fill(2));
  assert.equal(buf.seconds(), 60, 'second chunk merges with the first instead of replacing it');
  const afterTwo = buf.snapshot();
  assert.ok(afterTwo.slice(0, 300).every(v => v === 1), 'the first 30s chunk is preserved, not overwritten');
  assert.ok(afterTwo.slice(300, 600).every(v => v === 2));

  // Chunk 3: a third 30s chunk -- now at exactly the 90s cap.
  buf.push(new Float32Array(300).fill(3));
  assert.equal(buf.seconds(), 90, 'three chunks reach exactly the cap, still all three merged');

  // A fourth chunk would exceed the cap -- the oldest chunk (chunk 1) is the one that must give way,
  // never a mid-song truncation of the newer content.
  buf.push(new Float32Array(300).fill(4));
  assert.equal(buf.seconds(), 90, 'stays at the cap once reached (memory management)');
  const afterFour = buf.snapshot();
  assert.ok(afterFour.slice(0, 300).every(v => v === 2), 'oldest chunk (1) was evicted first');
  assert.ok(afterFour.slice(300, 600).every(v => v === 3));
  assert.ok(afterFour.slice(600, 900).every(v => v === 4));
});
