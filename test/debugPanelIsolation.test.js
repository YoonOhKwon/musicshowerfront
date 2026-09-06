const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "js/main.js"), "utf8");
const visuals = fs.readFileSync(path.join(root, "js/visual/visualEngine.js"), "utf8");

test("D inspection mode preserves the floating-word stream", () => {
  const spawner = main.slice(main.indexOf("function updateWordSpawner"), main.indexOf("function pcmToWav"));
  assert.doesNotMatch(spawner, /if \(CONFIG\.semantic\.debug\) return;/);
  const keyHandler = main.slice(main.indexOf("function keyPressed"), main.indexOf("function windowResized"));
  assert.doesNotMatch(keyHandler, /floatingWords\.length = 0/);
  assert.doesNotMatch(keyHandler, /spawnBatchFacets\.clear\(\)/);
  assert.doesNotMatch(keyHandler, /endSemanticSession|resetAudioAnalysis|resetFloatingSemanticVisuals/);
});

test("the D panel is opaque and bounds long Flamingo genre diagnostics to its width", () => {
  const panel = visuals.slice(visuals.indexOf("function drawSemanticDebugPanel"),
    visuals.indexOf("function resetFloatingSemanticVisuals"));
  assert.match(panel, /fill\(5, 7, 18, 255\)/);
  assert.match(panel, /maxLineCharacters/);
  assert.match(panel, /compact\(item\.text\)/);
});
