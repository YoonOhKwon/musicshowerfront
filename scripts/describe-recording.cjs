// Read-only inspection: no paid API requests and no modification of the recording.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const Snapshot = require('../js/semantic/semanticSnapshot');
const { stateFromFrame } = require('./replay.cjs');
const { validateLanguageInput } = require('../lib/languageService');
const { describe } = require('../lib/musicDescription');
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/describe-recording.cjs <recording.json>');
const recording = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(recording.frames) || !recording.frames.length) throw new Error('Recording has no frames');
const samples = [], timings = [], sizes = [];
let lastSampleAt = -Infinity;
for (const frame of recording.frames) {
  const snapshot = validateLanguageInput({ snapshot: Snapshot.serialize(stateFromFrame(frame)) }).snapshot;
  const start = performance.now();
  const description = describe(snapshot);
  timings.push(performance.now() - start);
  sizes.push(JSON.stringify(description).length);
  if (frame.t - lastSampleAt >= 15000) {
    samples.push({ seconds: frame.t / 1000, ...description });
    lastSampleAt = frame.t;
  }
}
console.log(JSON.stringify({ track: recording.track, frames: recording.frames.length,
  basis: 'recorded descriptors, not original audio or actual displayed phrases',
  meanDescriptionMs: timings.reduce((a, b) => a + b, 0) / timings.length,
  maxDescriptionChars: Math.max(...sizes), samples }, null, 2));
