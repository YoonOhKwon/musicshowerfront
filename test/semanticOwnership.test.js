const test = require('node:test');
const assert = require('node:assert/strict');

const Manager = require('../js/semantic/semanticFacetManager');
const Pipeline = require('../js/semantic/semanticCandidatePipeline');
const Primitives = require('../js/semantic/musicalPrimitiveEngine');

const token = (text, category, layer, source, extra = {}) => ({
  text, category, layer, source, confidence: 0.9, anchors: ['measurements.energy'], ...extra
});

test('AESTHETIC and IMPRESSION are accepted only from Music Flamingo direct listening', () => {
  for (const source of ['impression-synthesis', 'local-grammar', 'aesthetic-induction', 'aesthetic-axis', 'llm', 'remote-generative']) {
    assert.equal(Manager.ownershipAllowed(token('local subjective phrase', 'mood', 'IMPRESSION', source)), false, source);
    assert.equal(Manager.ownershipAllowed(token('local aesthetic phrase', 'association', 'AESTHETIC', source)), false, source);
  }
  assert.equal(Manager.ownershipAllowed(token('Flamingo impression', 'mood', 'IMPRESSION', 'directAudio', {
    sourceFamily: 'directAudio', sourceModel: 'music-flamingo'
  })), true);
  assert.equal(Manager.ownershipAllowed(token('Flamingo aesthetic', 'association', 'AESTHETIC', 'directAudio', {
    sourceFamily: 'directAudio', sourceModel: 'music-flamingo'
  })), true);
});

test('FACT and LIVE allow local analysis and Music Flamingo but not the generic language pool', () => {
  assert.equal(Manager.ownershipAllowed(token('measured pulse', 'rhythm', 'FACT', 'rhythm')), true);
  assert.equal(Manager.ownershipAllowed(token('energy increased', 'live', 'LIVE', 'live')), true);
  assert.equal(Manager.ownershipAllowed(token('heard brass', 'instrumentation', 'FACT', 'directAudio', {
    sourceFamily: 'directAudio', sourceModel: 'music-flamingo'
  })), true);
  assert.equal(Manager.ownershipAllowed(token('invented fact', 'production', 'FACT', 'remote-generative')), false);
  assert.equal(Manager.ownershipAllowed(token('invented change', 'live', 'LIVE', 'llm')), false);
});

test('legacy hardcoded semantic sources are rejected even if they carry a valid-looking facet', () => {
  for (const source of ['evidence-gated-prior', 'genre-relation', 'impression-synthesis', 'aesthetic-induction']) {
    assert.equal(Manager.ownershipAllowed(token('legacy output', 'lineage', 'CONTEXT', source)), false, source);
  }
});

test('the local candidate pipeline emits no AESTHETIC or IMPRESSION candidates', () => {
  const state = {
    instruments: [], instrumentation: { observed: [] }, instrumentEvents: [], performance: {}, arrangement: {},
    rhythmicGrammar: {}, productionEvidence: {}, trackCharacter: {}, genre: { primary: 'Unknown', confidence: 0, uncertain: true },
    verifiedClaims: { licensed: new Set(), byConcept: {} }, primitives: Primitives.empty()
  };
  Pipeline.populate(state);
  assert.deepEqual(state.impressionConcepts, []);
  assert.deepEqual(state.impressionFacetCandidates, []);
  assert.deepEqual(state.aestheticConceptCandidates, []);
});

