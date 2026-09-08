const test = require('node:test');
const assert = require('node:assert/strict');
const OpenWorldConceptRegistry = require('../js/semantic/openWorldConceptRegistry');

test('proposeExpansion creates low-confidence related concepts and relation edges', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  registry.propose({ label: 'Gqom', conceptType: 'genre', source: 'directAudio', observationId: 'obs-1', confidence: 0.7 });

  const result = registry.proposeExpansion('Gqom', {
    scene: ['South African club scene'],
    lineage: ['Kwaito', 'Sgubhu'],
    productionTraits: ['Sparse percussive loops'],
    aestheticAssociations: ['Durban night drives']
  });

  assert.ok(result, 'constellation result should be returned');
  assert.equal(registry.get('South African club scene', 'scene')?.canonicalLabel, 'South African club scene');
  // A single observation already grants temporalSupport>=1, same as every other source in this
  // codebase -- the safeguard here is confidence, not status: it must stay low until corroborated.
  assert.ok(registry.get('Kwaito', 'lineage').confidence <= 0.45, 'expanded concepts enter at low, unconfirmed confidence');

  const constellation = registry.constellation('Gqom');
  assert.equal(constellation.relations.length, 5, 'one relation edge per expanded concept (1 scene + 2 lineage + 1 production + 1 aesthetic)');
  assert.ok(constellation.relations.every(r => r.concept), 'every relation must resolve to its actual (non-genre-typed) target node');
  const sceneRelation = constellation.relations.find(r => r.concept.conceptType === 'scene');
  assert.equal(sceneRelation.relationType, 'lineage');
});

test('proposeExpansion fires only once per concept even if called again', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  registry.propose({ label: 'Singeli', conceptType: 'genre', source: 'directAudio', observationId: 'obs-1', confidence: 0.7 });

  registry.proposeExpansion('Singeli', { scene: ['Tanzanian street scene'] });
  const firstCount = registry.constellation('Singeli').relations.length;

  // A second, different expansion call must be ignored -- no duplicate/expanded flood.
  registry.proposeExpansion('Singeli', { scene: ['Tanzanian street scene'], lineage: ['Taarab'] });
  const secondCount = registry.constellation('Singeli').relations.length;

  assert.equal(secondCount, firstCount, 'expansion must not re-fire once already requested');
});

test('proposeExpansion on an unknown concept key is a safe no-op', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  const result = registry.proposeExpansion('Never Registered', { scene: ['x'] });
  assert.equal(result, null);
});

test('an empty expansions object registers nothing but still marks the concept as expanded', () => {
  const registry = new OpenWorldConceptRegistry.Registry();
  registry.propose({ label: 'Zamrock', conceptType: 'genre', source: 'directAudio', observationId: 'obs-1', confidence: 0.7 });
  registry.proposeExpansion('Zamrock', {});
  const node = registry.get('Zamrock', 'genre');
  assert.equal(node.expansionRequested, true);
  assert.equal(registry.constellation('Zamrock').relations.length, 0);
});
