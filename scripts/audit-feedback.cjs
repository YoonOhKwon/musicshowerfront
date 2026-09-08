#!/usr/bin/env node
// Read-only audit for Language Inspector exports. Votes remain manual evaluation labels: this
// script never changes runtime thresholds, ranking, or model weights. It explains whether the
// CURRENT evidence engine can support a genre vote and highlights legacy temporal leakage.
const fs = require("node:fs");
const path = require("node:path");
const GenreHypotheses = require("../js/semantic/genreHypothesisEngine");
const hierarchy = require("../data/genreHierarchy.json");

const normalize = value => GenreHypotheses.normalize(value);
const read = (source, dottedPath) => String(dottedPath).split(".").reduce((value, key) =>
  value && Object.hasOwn(value, key) ? value[key] : undefined, source);

const TEMPORAL_FACT_PATHS = Object.freeze({
  "브레이크비트": "rhythmicGrammar.brokenBeat",
  "4/4 플로어": "rhythmicGrammar.fourOnFloor",
  "스윙 필": "rhythmicGrammar.swing",
  "싱코페이션": "rhythmicGrammar.syncopation",
  "샘플 기반": "productionEvidence.sampleBased",
  "사이드체인 펌핑": "productionEvidence.sidechain",
  "필터 스윕 가능성": "productionEvidence.filterSweep",
  "보컬 찹": "productionEvidence.vocalChop"
});

function stateFromFeedback(entry = {}) {
  const snapshot = entry.snapshot || {};
  const genreEvidence = Array.isArray(snapshot.genreEvidence) ? snapshot.genreEvidence : [];
  const primary = snapshot.primaryGenre || snapshot.genre?.primary || genreEvidence[0]?.label || null;
  const confidence = Number(snapshot.semanticConfidence ?? snapshot.confidence ?? genreEvidence[0]?.confidence) || 0;
  return {
    classifierGenre: {
      primary, uncertain: !primary, confidence, semanticConfidence: confidence,
      topK: genreEvidence.map(item => ({ label: item.label || item.text, confidence: Number(item.confidence) || 0 }))
    },
    rhythmicGrammar: snapshot.rhythmicGrammar || {},
    productionEvidence: snapshot.productionEvidence || {},
    instrumentationEvidence: snapshot.instrumentationEvidence || {},
    moodDimensions: snapshot.moodDimensions || {},
    trackCharacter: snapshot.trackCharacter || { space: snapshot.space || {} }
  };
}

function temporalLeaks(snapshot = {}) {
  const stable = snapshot.temporalState?.stable || snapshot.temporalState?.trackTraits || [];
  const leaks = [];
  for (const item of stable) {
    if (item.category === "live" || item.layer === "LIVE") {
      leaks.push({ text: item.text, reason: "live-event-in-stable-memory", confidence: item.confidence });
      continue;
    }
    const evidencePath = TEMPORAL_FACT_PATHS[item.text];
    if (evidencePath && !Number.isFinite(read(snapshot, evidencePath)))
      leaks.push({ text: item.text, reason: "stable-fact-without-current-detector-evidence",
        confidence: item.confidence, evidencePath });
  }
  return leaks;
}

function auditEntry(entry = {}) {
  const state = stateFromFeedback(entry);
  const engine = new GenreHypotheses.Engine({}, hierarchy);
  const result = engine.evaluate(state, Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : 0);
  const genreVote = entry.perspective === "genre";
  const hypothesis = genreVote ? result.hypotheses.find(item => normalize(item.genre) === normalize(entry.text)) : null;
  const rejected = genreVote ? result.rejectedHypotheses.find(item => normalize(item.genre) === normalize(entry.text)) : null;
  const legacyStable = (entry.snapshot?.temporalState?.stable || []).find(item => normalize(item.text) === normalize(entry.text));
  const semanticConfidence = hypothesis?.semanticConfidence ?? null;
  const persistenceInflation = Number.isFinite(legacyStable?.confidence) && Number.isFinite(semanticConfidence)
    ? Math.max(0, legacyStable.confidence - semanticConfidence) : 0;
  let evaluation = "manual-review";
  if (genreVote && entry.vote === "keep") evaluation = hypothesis ? "supported-keep" : "keep-without-current-support";
  if (genreVote && entry.vote === "remove") evaluation = hypothesis ? "supported-but-listener-rejected" : "unsupported-remove";
  return {
    text: entry.text, vote: entry.vote, perspective: entry.perspective,
    voteMeaning: "manual-evaluation-only", evaluation,
    currentHypothesis: hypothesis ? {
      kind: hypothesis.kind, semanticConfidence, temporalStability: hypothesis.temporalStability,
      evidenceCoverage: hypothesis.evidenceCoverage,
      independentEvidenceFamilies: hypothesis.independentEvidenceFamilies,
      supportingEvidence: hypothesis.supportingEvidence
    } : null,
    rejectedHypothesis: rejected || null,
    legacyPersistenceInflation: persistenceInflation,
    temporalLeaks: temporalLeaks(entry.snapshot),
    currentPrimary: result.primary?.genre || null,
    challengers: result.challengers.map(item => ({ genre: item.genre, semanticConfidence: item.semanticConfidence }))
  };
}

function auditFeedback(entries = []) {
  const items = entries.map(auditEntry);
  const counts = items.reduce((output, item) => {
    output[item.evaluation] = (output[item.evaluation] || 0) + 1;
    return output;
  }, {});
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), voteMeaning: "manual-evaluation-only",
    summary: { entries: items.length, evaluations: counts,
      temporalLeakCount: items.reduce((sum, item) => sum + item.temporalLeaks.length, 0),
      persistenceInflationCount: items.filter(item => item.legacyPersistenceInflation > 0.05).length },
    items
  };
}

function main(argv = process.argv.slice(2)) {
  const inputIndex = argv.indexOf("--input");
  const input = inputIndex >= 0 ? argv[inputIndex + 1] : argv[0];
  if (!input) {
    process.stderr.write("Usage: node scripts/audit-feedback.cjs --input <feedback.json>\n");
    process.exitCode = 1;
    return;
  }
  const resolved = path.resolve(process.cwd(), input);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : parsed.feedback || [];
  process.stdout.write(JSON.stringify(auditFeedback(entries), null, 2) + "\n");
}

if (require.main === module) main();
module.exports = { stateFromFeedback, temporalLeaks, auditEntry, auditFeedback, TEMPORAL_FACT_PATHS };
