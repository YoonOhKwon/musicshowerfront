#!/usr/bin/env node
// STEP 4-3: automated review report for a scripts/author-vocabulary.mjs batch
// (data/aestheticVocabulary.generated.json by default), checked against Gate 4's numeric
// thresholds. Never auto-drops anything -- prints the numbers and the flagged entries so a human
// makes the actual keep/discard/reprompt call, per docs/VOCABULARY_AUTHORING.md.
//
// Usage: node scripts/analyze-vocabulary-batch.cjs [path-to-generated.json] [--replay <dir>]
const fs = require("fs");
const path = require("path");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");

// -- synonym inflation: unique conceptKey ratio (Gate 4: >= 70%) --------------------------------
function conceptKeyRatio(entries) {
  const conceptKeys = entries.map(entry => entry.conceptKey).filter(Boolean);
  const unique = new Set(conceptKeys);
  return conceptKeys.length ? unique.size / conceptKeys.length : 0;
}

// -- axis bias: share of region conditions naming each axis (Gate 4: no axis > 30%) -------------
function axisShareOf(entries, axisNames) {
  const counts = Object.fromEntries(axisNames.map(name => [name, 0]));
  let total = 0;
  for (const entry of entries) for (const condition of entry.region || []) {
    if (counts[condition.axis] !== undefined) { counts[condition.axis]++; total++; }
  }
  const share = Object.fromEntries(Object.entries(counts).map(([axis, count]) => [axis, total ? count / total : 0]));
  return { share, overrepresented: Object.entries(share).filter(([, s]) => s > 0.3).map(([axis]) => axis) };
}

// -- gate width: how many entries are 1-axis-only (Gate 4: <= 30%) ------------------------------
function gateWidthOf(entries) {
  const counts = {};
  for (const entry of entries) {
    const size = Array.isArray(entry.region) ? entry.region.length : 0;
    counts[size] = (counts[size] || 0) + 1;
  }
  const singleAxisRatio = entries.length ? (counts[1] || 0) / entries.length : 0;
  return { counts, singleAxisRatio };
}

// -- "fires on every genre" test: does an entry's region gate pass for EVERY track's median axis
// vector? If so it is not discriminating anything -- it would speak for any music at all.
function satisfiesEntry(entry, axes) {
  const satisfied = (entry.region || []).filter(condition => {
    const value = axes[condition.axis];
    return typeof value === "number" && value >= (condition.min ?? 0) && value <= (condition.max ?? 1);
  });
  return satisfied.length >= (entry.minAxes ?? (entry.region || []).length);
}
function universalFireCheck(entries, trackAxisMedians) {
  const perEntry = entries.map(entry => {
    const firesOn = trackAxisMedians.filter(({ median }) => satisfiesEntry(entry, median)).map(({ track }) => track);
    return { text: entry.text, conceptKey: entry.conceptKey, firesOnCount: firesOn.length, firesOnTracks: firesOn,
      totalTracks: trackAxisMedians.length };
  });
  const universallyFiring = perEntry.filter(item => item.totalTracks > 1 && item.firesOnCount === item.totalTracks);
  return { perEntry, universallyFiring };
}

function trackAxisMediansFromReplayDir(replayDir, axisNames, projectRoot) {
  const Replay = require("./replay.cjs");
  const resolved = path.resolve(projectRoot, replayDir);
  const files = fs.readdirSync(resolved).filter(name => name.endsWith(".json"));
  return files.map(file => {
    const recording = JSON.parse(fs.readFileSync(path.join(resolved, file), "utf8"));
    const result = Replay.replayTrack(recording);
    const median = {};
    for (const axis of axisNames) {
      const values = result.axisSamples.map(sample => sample[axis]).filter(Number.isFinite).sort((a, b) => a - b);
      median[axis] = values.length ? values[Math.floor(values.length / 2)] : null;
    }
    return { track: recording.track, median };
  });
}

function buildReport(entries, axisNames, trackAxisMedians = null) {
  const concept = conceptKeyRatio(entries);
  const { share: axisShare, overrepresented: overrepresentedAxes } = axisShareOf(entries, axisNames);
  const { counts: gateWidthCounts, singleAxisRatio } = gateWidthOf(entries);
  const fire = trackAxisMedians ? universalFireCheck(entries, trackAxisMedians) : null;
  const structuralIssues = Validator.validateGeneratedVocabulary({ entries }, axisNames);
  return {
    entryCount: entries.length,
    conceptKeyRatio: Number(concept.toFixed(3)), conceptKeyRatioPasses: concept >= 0.7,
    axisShare, overrepresentedAxes,
    gateWidthCounts, singleAxisRatio: Number(singleAxisRatio.toFixed(3)), singleAxisRatioPasses: singleAxisRatio <= 0.3,
    universalFire: fire?.perEntry ?? null, universallyFiring: fire?.universallyFiring ?? null,
    universalFireTestPasses: fire ? fire.universallyFiring.length === 0 : null,
    structuralIssueCount: structuralIssues.length, structuralIssues,
    gate4Summary: {
      conceptKeyRatio: concept >= 0.7 ? "PASS" : "FAIL",
      axisBias: overrepresentedAxes.length === 0 ? "PASS" : `FAIL (${overrepresentedAxes.join(", ")})`,
      gateWidth: singleAxisRatio <= 0.3 ? "PASS" : "FAIL",
      universalFireTest: fire ? (fire.universallyFiring.length === 0 ? "PASS" : `FAIL (${fire.universallyFiring.length} entries)`) : "SKIPPED (no --replay dir given)",
      structural: structuralIssues.length === 0 ? "PASS" : `FAIL (${structuralIssues.length} issues)`
    }
  };
}

function parseArgs(argv) {
  const args = { file: "data/aestheticVocabulary.generated.json", replayDir: null };
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--replay") args.replayDir = argv[++index];
    else positional.push(argv[index]);
  }
  if (positional[0]) args.file = positional[0];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, "..");
  const aestheticAxesData = require(path.join(root, "data/aestheticAxes.json"));
  const axisNames = Object.keys(aestheticAxesData.axes);
  const generated = JSON.parse(fs.readFileSync(path.resolve(root, args.file), "utf8"));
  const trackAxisMedians = args.replayDir ? trackAxisMediansFromReplayDir(args.replayDir, axisNames, root) : null;
  console.log(JSON.stringify(buildReport(generated.entries || [], axisNames, trackAxisMedians), null, 2));
}

if (require.main === module) main();
module.exports = { conceptKeyRatio, axisShareOf, gateWidthOf, satisfiesEntry, universalFireCheck, buildReport };
