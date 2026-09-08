"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimePcmAnalyzer } = require("../lib/realtimePcmAnalyzer");

function sineWave({ sampleRate = 16000, seconds = 1, frequency = 110, amplitude = 0.35 } = {}) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(index * frequency * Math.PI * 2 / sampleRate) * amplitude;
  }
  return samples;
}

test("silence does not create a word pool", () => {
  const analyzer = new RealtimePcmAnalyzer({ sampleRate: 16000, windowSeconds: 0.1 });
  const result = analyzer.push(new Float32Array(2048));
  assert.ok(result);
  assert.equal(result.live, false);
  assert.deepEqual(result.tokens, []);
});

test("audible PCM creates finite features and literal tokens", () => {
  const analyzer = new RealtimePcmAnalyzer({ sampleRate: 16000, windowSeconds: 0.1 });
  const result = analyzer.push(sineWave({ seconds: 0.2 }));
  assert.ok(result);
  assert.equal(result.live, true);
  assert.ok(result.tokens.length >= 2);
  assert.ok(result.tokens.every(token => token.text && token.layer && token.type));
  assert.ok(Object.values(result.features).every(Number.isFinite));
});
