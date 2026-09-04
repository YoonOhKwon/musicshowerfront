const test = require("node:test");
const assert = require("node:assert/strict");
const RingBuffer = require("../js/core/ringBuffer");

test("ring buffer keeps bounded ordered values", () => {
  const buffer = new RingBuffer(3);
  buffer.push(1);
  buffer.push(2);
  buffer.push(3);
  buffer.push(4);
  assert.equal(buffer.length, 3);
  assert.deepEqual(buffer.values(), [2, 3, 4]);
  assert.equal(buffer.latest(), 4);
});

test("ring buffer reset removes previous session data", () => {
  const buffer = new RingBuffer(2);
  buffer.push("old");
  buffer.clear();
  assert.equal(buffer.length, 0);
  assert.deepEqual(buffer.values(), []);
});
