const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Lifecycle = require("../js/visual/wordLifecycle");
const Motion = require("../js/visual/danmakuMotion");

test("a word stays fully opaque after the short entry fade until it exits", () => {
  assert.equal(Lifecycle.alpha(0), 0);
  assert.equal(Lifecycle.alpha(0.025), 255);
  for (const progress of [0.05, 0.25, 0.5, 0.9, 1]) assert.equal(Lifecycle.alpha(progress), 255);
});

test("full viewport traversal is the primary removal condition", () => {
  const width = 1000, halfWidth = 80, speed = 160;
  let x = width + halfWidth, steps = 0;
  while (!Lifecycle.exited(x, -1, width, halfWidth) && steps < 1000) {
    x = Motion.advance(x, -1, speed, 16.6667); steps++;
  }
  assert.ok(steps > 300);
  assert.ok(Lifecycle.exited(x, -1, width, halfWidth));
  assert.equal(Lifecycle.stalled(30000, 0, Lifecycle.expectedTravelMs(width, halfWidth, speed)), false);
});

test("capacity pressure postpones a spawn instead of evicting an active word", () => {
  assert.equal(Lifecycle.canSpawn(17, 18), true);
  assert.equal(Lifecycle.canSpawn(18, 18), false);
  assert.ok(Lifecycle.densityFactor(16, 18) > 1);
  const source = fs.readFileSync(path.resolve(__dirname, "../js/visual/visualEngine.js"), "utf8");
  assert.doesNotMatch(source, /floatingWords\.shift\s*\(/);
});

test("semantic pool and epoch changes have no stale-word removal path", () => {
  const files = ["../js/visual/floatingWord.js", "../js/visual/visualEngine.js", "../js/semantic/semanticEngine.js"];
  const source = files.map(file => fs.readFileSync(path.resolve(__dirname, file), "utf8")).join("\n");
  assert.doesNotMatch(source, /markStale|staleAt|staleFade|wordMaxLifetime/);
  assert.match(source, /resetFloatingSemanticVisuals/);
  assert.match(source, /floatingWords\.length\s*=\s*0/);
});
