const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../js/main.js'), 'utf8');

test('track reset keeps segment numbering independent from request invalidation', () => {
  assert.match(source, /requestGeneration:\s*0/);
  assert.match(source, /deepListenState\.requestSequence\s*=\s*0/);
  assert.match(source, /deepListenState\.requestGeneration\s*\+=\s*1/);
  assert.match(source, /requestGeneration:\s*deepListenState\.requestGeneration/);
  assert.match(source, /const requestGeneration = capture\.requestGeneration/);
  assert.match(source, /deepListenState\.requestGeneration !== requestGeneration/);
});

test('a Deep Listen response carries the worker listening mode into semantic ingestion', () => {
  assert.match(source, /continuity:\s*data\.continuity\s*\|\|\s*null/);
});

test('the upload response chain owns a lifecycle binding for stale-response validation', () => {
  const uploadStart = source.indexOf('function triggerDeepAnalysisUpload');
  const responseStart = source.indexOf('.then(data =>', uploadStart);
  assert.ok(uploadStart >= 0 && responseStart > uploadStart);
  const uploadPrefix = source.slice(uploadStart, responseStart);
  assert.match(uploadPrefix,
    /const lifecycle = typeof getTrackLifecycleEngine === "function" \? getTrackLifecycleEngine\(\) : null/);
});
