const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../js/semantic/musicExpressionEngine");
const Pool = require("../js/semantic/phrasePoolEngine");

test("three real MP3 fixtures produce finite measured dynamics and words without an AI provider", async () => {
  const { default: decode } = await import("audio-decode");
  for (const name of ["outfoxing", "horns", "drums"]) {
    const decoded = await decode(fs.readFileSync(path.join(__dirname, "fixtures/audio", name + ".mp3")));
    const samples = decoded.channelData[0], history = new E.FeatureHistory(), engine = new Pool.Engine();
    const emitted = new Set();
    let observations = 0;
    for (let offset = 0; offset + 4096 < samples.length; offset += Math.floor(decoded.sampleRate / 2)) {
      const measured = E.measure(samples.subarray(offset, offset + 4096));
      assert.ok(Number.isFinite(measured.rmsDb) && Number.isFinite(measured.crestFactorDb));
      const features = history.update({ ...measured, energy: Math.min(1, measured.rms * 2) }, observations++ * 500);
      await engine.regenerate({ state: { expressionFeatures: features }, sessionId: 1, epoch: 1 });
      for (const item of engine.snapshot()) emitted.add(item.text);
    }
    assert.ok(observations > 2, name);
    assert.ok(emitted.size > 0, name);
    assert.ok([...emitted].every(text => !/과열|저중력|대기|준비/.test(text)), name);
    assert.equal(engine.activeRequest, null);
    assert.ok(history.frames.length <= 90);
  }
});
