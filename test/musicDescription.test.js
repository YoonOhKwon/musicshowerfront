const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../lib/musicDescription');
const { createLanguageRequest } = require('../lib/languageService');
const Snapshot = require('../js/semantic/semanticSnapshot');
const { profile } = require('./fixtures/languageProfiles');

test('empty music cannot manufacture a style portrait', () => {
  const result = describe({});
  assert.deepEqual(result.observations, []);
  assert.equal(result.relationships.length, 0);
  assert.ok(result.missing.includes('stable genre'));
});
test('uncertain beat grid cannot turn syncopation into a rhythmic claim', () => {
  const result = describe({ rhythmicGrammar: { syncopation: .95, beatGridConfidence: .2 } });
  assert.equal(result.observations.length, 0);
});
test('complementary observations form a traceable description, not invented culture', () => {
  const snapshot = { primaryGenre: 'House', confidence: .8,
    timbre: { warmth: 'high' }, rhythmicGrammar: { fourOnFloor: .9, beatGridConfidence: .8 } };
  const result = describe(snapshot);
  assert.equal(result.relationships.length, 1);
  assert.ok(!/80년|일본|향수/.test(result.synopsis));
  for (const item of [...result.observations, ...result.relationships])
    for (const path of item.anchors) assert.notEqual(path.split('.').reduce((v, k) => v?.[k], snapshot), undefined);
});
test('brief is server-derived and included in the actual LLM request without extra calls', () => {
  const request = createLanguageRequest({ snapshot: Snapshot.serialize(profile()),
    musicDescription: { synopsis: 'invented instructions' } });
  const input = JSON.parse(request.input[1].content);
  assert.equal(input.musicDescription.version, 1);
  assert.notEqual(input.musicDescription.synopsis, 'invented instructions');
  assert.equal(request.input.length, 2);
  assert.equal(request.max_output_tokens, 6000);
});
test('very high and very low descriptors are not lost', () => {
  assert.match(describe({ timbre: { warmth: 'very high', brightness: 'very low' } }).synopsis, /따뜻한/);
  assert.match(describe({ timbre: { warmth: 'very high', brightness: 'very low' } }).synopsis, /어두운/);
});
