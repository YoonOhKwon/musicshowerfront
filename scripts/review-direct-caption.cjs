// Usage: node scripts/review-direct-caption.cjs caption.json [recording.json]
const fs = require('node:fs');
const Snapshot = require('../js/semantic/semanticSnapshot');
const { stateFromFrame } = require('./replay.cjs');
const { describe } = require('../lib/musicDescription');
const { reviewCaption } = require('../lib/directAudioReview');
const captionFile = process.argv[2];
if (!captionFile) throw new Error('Usage: node scripts/review-direct-caption.cjs caption.json [recording.json]');
const caption = JSON.parse(fs.readFileSync(captionFile, 'utf8'));
let brief = {};
if (process.argv[3]) {
  const recording = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const frame = recording.frames?.at(-1);
  if (frame) brief = describe(Snapshot.serialize(stateFromFrame(frame)));
}
console.log(JSON.stringify(reviewCaption(caption, brief), null, 2));
