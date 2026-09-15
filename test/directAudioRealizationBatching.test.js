const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizedRealizationConcepts,
  realizationBatches,
  buildRealizationPrompt,
  parseRealizationBatch,
  distinctRealizationFamily,
  chatCompletionBudget
} = require('../server');

test('reasoning-model chat requests use max_completion_tokens instead of legacy max_tokens', () => {
  const request = chatCompletionBudget(650);
  assert.equal(request.max_completion_tokens, 650);
  assert.equal(Object.hasOwn(request, 'max_tokens'), false);
});

test('surface family rejects near-duplicate Korean paraphrases while retaining distinct renderings', () => {
  const family = distinctRealizationFamily([
    '깊은 밤의 공기', '깊은 밤 공기', '심야의 넓은 여백', '차분한 야간 공기'
  ]);
  assert.equal(family[0], '깊은 밤의 공기');
  assert.equal(family.includes('깊은 밤 공기'), false);
  assert.ok(family.includes('심야의 넓은 여백'));
});

test('direct-audio chat paths do not pin an unsupported custom temperature', () => {
  const source = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  const directAudioSection = source.slice(source.indexOf('app.post("/api/realize-direct-audio"'),
    source.indexOf('app.post("/api/music-analysis"'));
  assert.doesNotMatch(directAudioSection, /temperature\s*:/);
});

test('Korean realization mixes layers in one request of at most twelve concepts, ordered by layer', () => {
  const concepts = normalizedRealizationConcepts([
    ...Array.from({ length: 3 }, (_, index) => ({ text: `aesthetic ${index}`, category: 'association', layer: 'AESTHETIC' })),
    ...Array.from({ length: 5 }, (_, index) => ({ text: `audible ${index}`, category: 'production', layer: 'FACT' })),
    ...Array.from({ length: 2 }, (_, index) => ({ text: `scene ${index}`, category: 'scene', layer: 'CONTEXT' }))
  ]);
  const batches = realizationBatches(concepts);
  assert.equal(batches.length, 1, 'a typical capture is one call, not one call per layer');
  assert.deepEqual(batches[0].map(item => item.layer), [...Array(5).fill('FACT'), 'CONTEXT', 'CONTEXT', ...Array(3).fill('AESTHETIC')]);
  const many = normalizedRealizationConcepts(Array.from({ length: 21 }, (_, index) => ({ text: `audible ${index}`, category: 'production', layer: 'FACT' })));
  assert.deepEqual(realizationBatches(many).map(batch => batch.length), [12, 9]);

  const prompt = buildRealizationPrompt(batches[0]);
  assert.match(prompt, /Apply that layer's policy to that item only/);
  assert.match(prompt, /- FACT: .*add no metaphor/);
  assert.match(prompt, /- AESTHETIC: .*without adding a new aesthetic label/);
  assert.doesNotMatch(prompt, /- IMPRESSION:/, 'only the policies of layers present in the batch');
  assert.match(prompt, /"layer":"CONTEXT","text":"scene 0"/);
});

test('FACT realization stays literal and subjective realization cannot add new meaning', () => {
  const fact = normalizedRealizationConcepts([{ text: 'syncopated breakbeat', category: 'rhythm', layer: 'FACT' }]);
  const aesthetic = normalizedRealizationConcepts([{ text: 'digital nostalgia', category: 'association', layer: 'AESTHETIC' }]);
  assert.match(buildRealizationPrompt(fact), /add no metaphor/i);
  assert.match(buildRealizationPrompt(fact), /Never collapse a multi-part observation/i);
  assert.match(buildRealizationPrompt(fact), /Preserve every semantic atom/i);
  assert.match(buildRealizationPrompt(aesthetic), /without adding a new aesthetic label/i);
  assert.match(buildRealizationPrompt(aesthetic), /preserving exactly the concept supplied by Music Flamingo/i);
});

test('a partial batch response keeps valid Korean families and drops malformed entries independently', () => {
  const batch = normalizedRealizationConcepts([
    { text: 'deep sub-bass', category: 'instrumentation', layer: 'FACT' },
    { text: 'spacious reverb tails', category: 'production', layer: 'FACT' }
  ]);
  const parsed = parseRealizationBatch(JSON.stringify({ items: [
    { id: 'c0', phrases: ['깊은 서브베이스', '저역의 중량감'] },
    { id: 'c1', phrases: ['english only', '{bad json-ish copy}'] }
  ] }), batch);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, 'deep sub-bass');
  assert.deepEqual(parsed[0].family, ['깊은 서브베이스', '저역의 중량감']);
});
