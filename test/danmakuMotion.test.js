const test = require("node:test");
const assert = require("node:assert/strict");
const DanmakuMotion = require("../js/visual/danmakuMotion");

test("danmaku words move at the configured constant speed in both directions", () => {
  assert.equal(DanmakuMotion.advance(100, 1, 160, 50), 108);
  assert.equal(DanmakuMotion.advance(100, -1, 160, 50), 92);
  assert.equal(DanmakuMotion.advance(100, 1, 160, 25), 104);
});

test("danmaku progress starts at one edge and completes past the opposite edge", () => {
  const width = 1000;
  const halfWidth = 100;
  assert.equal(DanmakuMotion.progress(width + halfWidth, -1, width, halfWidth), 0);
  assert.equal(DanmakuMotion.progress(-halfWidth, -1, width, halfWidth), 1);
  assert.equal(DanmakuMotion.progress(-halfWidth, 1, width, halfWidth), 0);
  assert.equal(DanmakuMotion.progress(width + halfWidth, 1, width, halfWidth), 1);
});
