// Section-1 inventory report: how much of the declared musical knowledge is real vs. hollow.
// Numbers here are computed from the actual engines and fixtures, never estimated by hand.
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Impressions = require("../js/semantic/impressionSynthesizer");
const Grammar = require("../js/semantic/rhythmicGrammar");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const GenreContext = require("../js/semantic/genreContextEngine");
const { profile, RICH_KINDS } = require("../test/fixtures/languageProfiles");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");
const contextKnowledge = require("../data/genreContextKnowledge.json");
const genreAliases = require("../data/genreAliases.json");
const discogsModel = require("../models/music-shower/assets/discogs-effnet-bsdynamic-1.json");

// Section-0 regression line: what fraction of data/genreContextKnowledge.json's genre entries
// can an actual Discogs-EffNet classifier output ever reach? Mirrors semanticEngine.js's own
// canonicalGenre() (split "parent---specific", then resolve through data/genreAliases.json)
// followed by the SAME resolveGenreEntry() the live lookup uses, so this can never silently
// disagree with runtime behavior the way the primitive-classification report once did.
function genreReachability() {
  const aliasLookup = new Map(Object.entries(genreAliases).map(([key, value]) => [key.toLowerCase(), value]));
  const canonicalLabels = (discogsModel.classes || []).map(rawClass => {
    const specific = rawClass.includes("---") ? rawClass.split("---", 2)[1] : rawClass;
    return aliasLookup.get(specific.toLowerCase()) || specific;
  });
  const genreKeys = Object.keys(contextKnowledge.genres || {});
  const reachable = new Set();
  for (const label of canonicalLabels) {
    const found = GenreContext.resolveGenreEntry(contextKnowledge, label);
    if (found) reachable.add(found);
  }
  const unreachable = genreKeys.filter(key => !reachable.has(key));
  return { totalGenreKeys: genreKeys.length, reachableCount: reachable.size,
    reachabilityRatio: genreKeys.length ? reachable.size / genreKeys.length : 1, unreachable };
}

const schema = Primitives.schema();
const sampleKinds = [...RICH_KINDS, "cold", "warm", "jazz"];
const samples = sampleKinds.map(kind => Primitives.analyze(profile(kind)));

const classification = Validator.classifyPrimitives(schema, samples);
const classificationSummary = Validator.summarizeClassification(classification);

const engine = new Idioms.Engine(lexicon, { primitiveSchema: schema, genreTaxonomy: taxonomy });
const coverage = Validator.coverageReport(engine.graph, lexicon, { impressionRules: Impressions.RULES,
  directConsumerPaths: Pipeline.primitiveConsumerPaths });

const report = Validator.validate({ lexicon, primitiveSchema: schema, graph: engine.graph,
  detectorRules: Pipeline.productionRules, detectorCapabilities: Grammar.detectorCapabilities,
  contextKnowledge, primitiveClassification: classification, impressionRules: Impressions.RULES,
  directConsumerPaths: Pipeline.primitiveConsumerPaths });

// report.issues carries every severity tier (error/high/warning/info, section 17); count by code
// across all of them so this report and a plain `npm run check` can never silently disagree.
const warningsByCode = {};
for (const item of report.issues) if (item.severity !== "error") warningsByCode[item.code] = (warningsByCode[item.code] || 0) + 1;

// Two distinct genre-awareness mechanisms: specializations change the WORDING per genre;
// contextMultipliers only boost confidence without changing text. Both count as real
// genre-specific knowledge (section 20), so both are reported.
const genreRealizationCount = lexicon.entries.reduce((sum, entry) =>
  sum + (entry.specializations || []).length, 0);
const genreMultiplierCount = lexicon.entries.reduce((sum, entry) =>
  sum + (entry.contextMultipliers || []).length, 0);

const reachability = genreReachability();

const summary = {
  genreKnowledgeReachabilityRatio: Number(reachability.reachabilityRatio.toFixed(3)),
  genreKnowledgeReachableCount: reachability.reachableCount,
  genreKnowledgeTotalCount: reachability.totalGenreKeys,
  primitiveSchemaCount: report.stats.primitivePaths,
  primitiveDetectorSupportedCount: classificationSummary.REAL_DETECTOR,
  primitiveDerivedCount: classificationSummary.DERIVED,
  primitiveDeclaredOnlyCount: classificationSummary.DECLARED_ONLY,
  primitiveFixtureAvailabilityCount: report.stats.primitivePaths - classificationSummary.DECLARED_ONLY,
  canonicalIdiomCount: report.stats.rules,
  idiomRealizationCount: genreRealizationCount,
  genreConfidenceMultiplierCount: genreMultiplierCount,
  genreSpecializedIdiomCount: lexicon.entries.filter(entry =>
    (entry.specializations || []).length > 0 || (entry.contextMultipliers || []).length > 0).length,
  impressionRuleCount: Impressions.RULES.length,
  directPrimitiveConsumerCount: Pipeline.primitiveConsumerPaths.length,
  graphNodes: report.stats.graphNodes,
  graphEdges: report.stats.graphEdges,
  validatorErrors: report.errors.length,
  validatorWarnings: report.warnings.length,
  detectorWarningCount: (warningsByCode["optional-detector-disabled"] || 0) + (warningsByCode["narrow-detector-headroom"] || 0),
  unreachableRuleCount: report.errors.filter(e => /unreachable/.test(e.code)).length,
  missingDetectorReferenceCount: (warningsByCode["idiom-requires-declared-only"] || 0),
  unusedPrimitiveCount: (warningsByCode["unused-primitive"] || 0),
  orphanPrimitiveCount: coverage.orphanPrimitives.length
};

const declaredOnlyPaths = Object.entries(classification).filter(([, state]) => state === "DECLARED_ONLY").map(([path]) => path);
const topPrimitivesByIdiomCount = Object.entries(coverage.byPrimitive).slice(0, 15);
const genreCoverage = Object.entries(coverage.byGenre).sort((a, b) => b[1] - a[1]);

const output = { summary, warningsByCode, declaredOnlyPaths, topPrimitivesByIdiomCount, genreCoverage,
  orphanPrimitives: coverage.orphanPrimitives.slice(0, 30), unreachableGenreKeys: reachability.unreachable };

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("=== Primitive coverage ===");
  console.log(JSON.stringify(summary, null, 1));
  console.log("\n=== Genre knowledge reachability (" + reachability.reachableCount + "/" + reachability.totalGenreKeys + ") ===");
  console.log("Unreachable from the 400-class model:", reachability.unreachable.join(", ") || "(none)");
  console.log("\n=== DECLARED_ONLY primitives (" + declaredOnlyPaths.length + ") ===");
  console.log(declaredOnlyPaths.join(", "));
  console.log("\n=== Top primitives by idiom count ===");
  for (const [path, count] of topPrimitivesByIdiomCount) console.log(`${path} -> ${count} idioms`);
  console.log("\n=== Orphan primitives (no idiom consumer, first 30) ===");
  console.log(coverage.orphanPrimitives.slice(0, 30).join(", "));
  console.log("\n=== Genre idiom coverage ===");
  for (const [genre, count] of genreCoverage) console.log(`${genre} -> ${count} supported idioms`);
}
if (!report.ok) process.exitCode = 1;
