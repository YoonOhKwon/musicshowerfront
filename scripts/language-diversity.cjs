// Deterministic regression benchmark over the same rich semantic fixtures used by production
// tests. It evaluates the final selected stream, not merely whether the genre classifier changed.
const Manager = require("../js/semantic/semanticFacetManager");
const Critic = require("../js/semantic/languageCritic");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Selection = require("../js/visual/phraseSelection");
const Evidence = require("../js/semantic/evidenceReservoir");
const SongProfile = require("../js/semantic/songLanguageProfile");
const Metrics = require("../js/semantic/languageDiversityMetrics");
const { profile, RICH_KINDS } = require("../test/fixtures/languageProfiles");

function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => ((value = (value * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function simulate(kind, seed) {
  const state = profile(kind);
  state.expressionFeatures.observationSeconds = Math.max(35, state.expressionFeatures.observationSeconds || 0);
  const context = { snapshot: Snapshot.serialize(state), eligibleTexts: Manager.base(state).map(item => item.text) };
  const grounded = Critic.rank(Manager.base(state), { context, limit: 120 }).selected;
  const evidence = new Evidence.Reservoir({ capacity: 180 });
  const song = new SongProfile.Profile();
  evidence.clear(seed);
  song.reset(seed);
  let candidates = evidence.observe(grounded, { sessionId: seed, epoch: 1, at: 1000, observationSeconds: 35 });
  song.observe(state, candidates, { sessionId: seed, at: 1000 });
  const recent = [], random = seeded(seed);
  for (let index = 0; index < 30; index++) {
    candidates = song.annotate(evidence.snapshot({ at: 1000 + index * 2000 }), 1000 + index * 2000);
    const chosen = Selection.choose(candidates, recent.slice(-12), random, {
      observationSeconds: 35, now: 1000 + index * 2000, explorationRate: .3
    });
    if (!chosen) break;
    recent.push(chosen);
    evidence.noteDisplayed(chosen, 1000 + index * 2000);
    song.noteUsed(chosen, 1000 + index * 2000);
  }
  return { kind, selected: recent, metrics: Metrics.evaluate(recent) };
}

const runs = [...RICH_KINDS].map((kind, index) => simulate(kind, index + 1));
const pairs = [];
for (let left = 0; left < runs.length; left++) for (let right = left + 1; right < runs.length; right++)
  pairs.push({ pair: [runs[left].kind, runs[right].kind], jaccard: Metrics.jaccard(runs[left].selected, runs[right].selected) });
const output = { generatedAt: new Date().toISOString(), songs: runs.map(run => ({ kind: run.kind,
  metrics: run.metrics, examples: run.selected.slice(0, 12).map(item => item.text) })),
  separation: { averageJaccard: pairs.reduce((sum, item) => sum + item.jaccard, 0) / Math.max(1, pairs.length),
    maximumJaccard: Math.max(0, ...pairs.map(item => item.jaccard)), pairs } };
console.log(JSON.stringify(output, null, 2));
