#!/usr/bin/env node
// STEP 3: replays real captured snapshots (test/fixtures/replays/*.json, from the in-app
// recorder -- js/debug/replayRecorder.js) through the SAME deterministic pipeline production
// uses (aesthetic axes -> genreContextEngine -> SemanticCandidatePipeline -> critic -> reservoir
// -> song profile -> selection), so tuning a threshold can be checked in seconds against real
// evidence instead of re-listening to a track and hoping ML inference didn't drift underneath you.
//
// Usage:
//   node scripts/replay.cjs --input test/fixtures/replays/ --report
//   node scripts/replay.cjs --input test/fixtures/replays/ --baseline out/baseline.json --compare
const fs = require("fs");
const path = require("path");

const AestheticAxisEngine = require("../js/semantic/aestheticAxisEngine");
const AestheticEvidence = require("../js/semantic/aestheticEvidenceEngine");
const GenreContext = require("../js/semantic/genreContextEngine");
const Manager = require("../js/semantic/semanticFacetManager");
const Critic = require("../js/semantic/languageCritic");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Arrangement = require("../js/semantic/arrangementEngine");
const MusicalIdioms = require("../js/semantic/musicalIdiomEngine");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Evidence = require("../js/semantic/evidenceReservoir");
const SongProfile = require("../js/semantic/songLanguageProfile");
const Selection = require("../js/visual/phraseSelection");
const Metrics = require("../js/semantic/languageDiversityMetrics");
const Quality = require("../js/semantic/phraseQuality");
const ReplayRecorder = require("../js/debug/replayRecorder");

const aestheticAxesData = require("../data/aestheticAxes.json");
const aestheticRegionsData = require("../data/aestheticRegions.json");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");
const genreCompositions = require("../data/genreCompositions.json");
const musicalLexicon = require("../data/musicalLexicon.json");
const genreTaxonomy = require("../data/genreTaxonomy.json");

function parseArgs(argv) {
  const args = { input: "test/fixtures/replays", report: false, baseline: null, compare: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index];
    else if (arg === "--report") args.report = true;
    else if (arg === "--baseline") args.baseline = argv[++index];
    else if (arg === "--compare") args.compare = true;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(__dirname, "..");

function loadRecordings(inputPath) {
  const resolved = path.resolve(root, inputPath);
  const files = fs.statSync(resolved).isDirectory()
    ? fs.readdirSync(resolved).filter(name => name.endsWith(".json")).map(name => path.join(resolved, name))
    : [resolved];
  return files.map(file => ({ file, recording: JSON.parse(fs.readFileSync(file, "utf8")) }));
}

// Warns (does not fail) when a recording's stamped metadata no longer matches current code -- the
// same signal ReplayRecorder.js's header comment promises: "recollect this recording" advice, not
// a hard block, since an axisSchemaVersion bump is often exactly WHY someone is re-running this.
function checkDrift(file, recording) {
  const warnings = [];
  if (recording.axisSchemaVersion !== ReplayRecorder.SCHEMA_VERSION)
    warnings.push(`axisSchemaVersion ${recording.axisSchemaVersion} != current ${ReplayRecorder.SCHEMA_VERSION} -- frame shape may have changed, consider re-recording`);
  if (recording.modelVersion !== ReplayRecorder.MODEL_VERSION)
    warnings.push(`modelVersion "${recording.modelVersion}" != current "${ReplayRecorder.MODEL_VERSION}"`);
  if (JSON.stringify(recording.preprocessingConfig) !== JSON.stringify(ReplayRecorder.PREPROCESSING_CONFIG))
    warnings.push("preprocessingConfig no longer matches the current constant");
  for (const warning of warnings) process.stderr.write(`[replay] ${path.basename(file)}: ${warning}\n`);
  return warnings;
}

const idiomEngine = new MusicalIdioms.Engine(musicalLexicon, { primitiveSchema: Primitives.schema(), genreTaxonomy });

// One shared engine instance per replay run (not per-frame) so trajectory (delta/direction) and
// the axis-signature-based call-gating cache behave exactly as they would across a real session,
// not as if every frame were the first one ever seen.
function buildEngines() {
  const axisEngine = new AestheticAxisEngine.Engine(aestheticAxesData, aestheticRegionsData);
  const aestheticEvidenceEngine = new AestheticEvidence.Engine(axisEngine);
  const genreContextEngine = new GenreContext.Engine(genreContextKnowledge, axisEngine, genreCompositions);
  return { axisEngine, aestheticEvidenceEngine, genreContextEngine };
}

function stateFromFrame(frame) {
  return {
    genre: frame.genre || {}, moodDimensions: frame.moodDimensions || {},
    productionEvidence: frame.productionEvidence || {}, rhythmicGrammar: frame.rhythmicGrammar || {},
    instruments: frame.instruments || [], trackCharacter: frame.trackCharacter || {},
    expressionFeatures: frame.expressionFeatures || {}
  };
}

function replayTrack(recording) {
  const { aestheticEvidenceEngine, genreContextEngine } = buildEngines();
  const arrangementEngine = new Arrangement.Engine();
  const evidence = new Evidence.Reservoir({ capacity: 180 });
  const song = new SongProfile.Profile();
  const seed = [...recording.track].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) || 1;
  evidence.clear(seed);
  song.reset(seed);
  let value = seed >>> 0;
  const random = () => ((value = (value * 1664525 + 1013904223) >>> 0) / 4294967296);

  const recent = [];
  const axisSamples = [];
  let silentFrameCount = 0;
  for (const frame of recording.frames) {
    const state = stateFromFrame(frame);
    state.aestheticEvidence = aestheticEvidenceEngine.evaluate(state);
    state.genreContextEvidence = genreContextEngine.evaluate(state);
    axisSamples.push(state.genreContextEvidence.axes || {});
    Pipeline.populate(state, { arrangementEngine, idiomEngine });
    const generated = Manager.base(state);
    const context = { snapshot: Snapshot.serialize(state), eligibleTexts: generated.map(item => item.text) };
    const grounded = Critic.rank(generated, { context, limit: 120 }).selected;
    let candidates = evidence.observe(grounded, { sessionId: seed, epoch: 1, at: frame.t, observationSeconds: (frame.t || 0) / 1000 });
    song.observe(state, candidates, { sessionId: seed, at: frame.t });
    candidates = song.annotate(evidence.snapshot({ at: frame.t }), frame.t);
    const chosen = Selection.choose(candidates, recent.slice(-12), random, { observationSeconds: (frame.t || 0) / 1000, now: frame.t, explorationRate: 0.3 });
    if (chosen) {
      recent.push(chosen);
      evidence.noteDisplayed(chosen, frame.t);
      song.noteUsed(chosen, frame.t);
    } else silentFrameCount++;
  }
  return { track: recording.track, selected: recent, axisSamples, frameCount: recording.frames.length, silentFrameCount };
}

function percentiles(values, points = [10, 25, 50, 75, 90, 95]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Object.fromEntries(points.map(p => [`p${p}`, null]));
  return Object.fromEntries(points.map(p => {
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return [`p${p}`, sorted[index]];
  }));
}

function axisDistributions(axisSamples, axisNames) {
  const byAxis = {};
  for (const axis of axisNames) byAxis[axis] = percentiles(axisSamples.map(sample => sample[axis]).filter(v => typeof v === "number"));
  return byAxis;
}

function combinationSizeDistribution(items) {
  const counts = {};
  for (const item of items) {
    const size = Array.isArray(item.axes) ? item.axes.length : (item.source === "aesthetic-axis" ? 1 : 0);
    if (item.source !== "aesthetic-axis") continue;
    counts[size] = (counts[size] || 0) + 1;
  }
  return counts;
}

function buildReport(runs) {
  const axisNames = Object.keys(aestheticAxesData.axes);
  const songs = runs.map(run => {
    const metrics = Metrics.evaluate(run.selected);
    return {
      track: run.track, frameCount: run.frameCount, silentFrameCount: run.silentFrameCount,
      spokenVocabulary: metrics.phraseCount, uniqueConceptKeys: Metrics.concepts(run.selected).size,
      layerDistribution: metrics.layerDistribution, axisCombinationSizes: combinationSizeDistribution(run.selected),
      axisDistributions: axisDistributions(run.axisSamples, axisNames),
      examples: run.selected.slice(0, 12).map(item => item.text)
    };
  });
  const pairs = [];
  for (let left = 0; left < runs.length; left++) for (let right = left + 1; right < runs.length; right++)
    pairs.push({ pair: [runs[left].track, runs[right].track], jaccard: Metrics.jaccard(runs[left].selected, runs[right].selected) });
  const allTexts = runs.map(run => new Set(run.selected.map(item => item.text)));
  const universallySpoken = runs.length > 1
    ? [...allTexts[0]].filter(text => allTexts.every(set => set.has(text))) : [];
  const everSpoken = new Set(runs.flatMap(run => run.selected.map(item => item.text)));
  const neverSpoken = []; // populated below once we know the full seed vocabulary, see main()
  const silentSongs = songs.filter(song => song.spokenVocabulary === 0).map(song => song.track);
  return {
    generatedAt: new Date().toISOString(), songs,
    separation: { averageJaccard: pairs.length ? pairs.reduce((sum, item) => sum + item.jaccard, 0) / pairs.length : 0,
      maximumJaccard: pairs.length ? Math.max(...pairs.map(item => item.jaccard)) : 0, pairs },
    universallySpoken, everSpokenCount: everSpoken.size, silentSongs, neverSpoken
  };
}

function main() {
  const startedAt = Date.now();
  const loaded = loadRecordings(args.input);
  if (!loaded.length) {
    console.error(`No recordings found under ${args.input}`);
    process.exitCode = 1;
    return;
  }
  const driftWarnings = [];
  for (const { file, recording } of loaded) driftWarnings.push(...checkDrift(file, recording));
  const runs = loaded.map(({ recording }) => replayTrack(recording));
  const report = buildReport(runs);
  report.driftWarnings = driftWarnings;
  report.elapsedMs = Date.now() - startedAt;

  if (args.baseline && !args.compare) {
    fs.mkdirSync(path.dirname(path.resolve(root, args.baseline)), { recursive: true });
    fs.writeFileSync(path.resolve(root, args.baseline), JSON.stringify(report, null, 2));
    console.log(`Baseline written to ${args.baseline} (${runs.length} tracks, ${report.elapsedMs}ms)`);
    return;
  }
  if (args.compare) {
    if (!args.baseline) { console.error("--compare requires --baseline <path>"); process.exitCode = 1; return; }
    const before = JSON.parse(fs.readFileSync(path.resolve(root, args.baseline), "utf8"));
    const beforeByTrack = Object.fromEntries(before.songs.map(song => [song.track, song]));
    const rows = report.songs.map(song => {
      const prior = beforeByTrack[song.track];
      return { track: song.track, spokenBefore: prior?.spokenVocabulary ?? null, spokenAfter: song.spokenVocabulary,
        openLayerBefore: prior?.layerDistribution?.openLayerRatio ?? null, openLayerAfter: song.layerDistribution.openLayerRatio };
    });
    console.log(JSON.stringify({ elapsedMs: report.elapsedMs, driftWarnings, rows,
      averageJaccardBefore: before.separation?.averageJaccard ?? null, averageJaccardAfter: report.separation.averageJaccard }, null, 2));
    return;
  }
  console.log(JSON.stringify(report, null, args.report ? 2 : 0));
}

// Pure helpers exported for test/replayHarness.test.js -- guarded so `node scripts/replay.cjs`
// still runs the CLI directly, and `require("./scripts/replay.cjs")` from a test never does.
if (require.main === module) main();
module.exports = { percentiles, axisDistributions, combinationSizeDistribution, checkDrift,
  stateFromFrame, buildReport, replayTrack };
