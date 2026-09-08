const fs = require("fs");
const path = require("path");
const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Grammar = require("../js/semantic/rhythmicGrammar");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const Metrics = require("../js/semantic/languageDiversityMetrics");
const { profile, RICH_KINDS } = require("../test/fixtures/languageProfiles");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");
const contextKnowledge = require("../data/genreContextKnowledge.json");
const aestheticAxes = require("../data/aestheticAxes.json");

const schema = Primitives.schema();
const engine = new Idioms.Engine(lexicon, { primitiveSchema: schema, genreTaxonomy: taxonomy });
// Identical sampling to scripts/knowledge-coverage.cjs and test/musicLanguageReform.test.js --
// all three must classify DECLARED_ONLY primitives the same way (section 16).
const primitiveSamples = [...RICH_KINDS, "cold", "warm", "jazz"].map(kind => Primitives.analyze(profile(kind)));
const primitiveClassification = Validator.classifyPrimitives(schema, primitiveSamples);
const report = Validator.validate({ lexicon, primitiveSchema: schema, graph: engine.graph,
  detectorRules: Pipeline.productionRules, detectorCapabilities: Grammar.detectorCapabilities, contextKnowledge,
  primitiveClassification, impressionRules: [], directConsumerPaths: Pipeline.primitiveConsumerPaths });

// Section 3: wording-convention drift on genreContextKnowledge.json (warning-tier, informational
// -- never fails the build) and axis-space blind-spot report over the CURRENT runtime vocabulary
// (data/aestheticRegions.json), so a shrinking blind-spot ratio is visible over successive
// authoring rounds without needing a separate script.
const categorySuffixIssues = Validator.validateCategorySuffix(contextKnowledge);
const axisCoverage = Metrics.axisCoverage([], Object.keys(aestheticAxes.axes || {}));

// Any *.generated.json review file present (scripts/author-vocabulary.mjs's output, not yet
// merged) is validated and reported, but never affects report.ok/exit code -- it is explicitly
// pre-review content (docs/VOCABULARY_AUTHORING.md), not runtime data.
const generatedVocabularyPath = path.join(__dirname, "..", "data", "aestheticVocabulary.generated.json");
const generatedVocabularyIssues = fs.existsSync(generatedVocabularyPath)
  ? Validator.validateGeneratedVocabulary(JSON.parse(fs.readFileSync(generatedVocabularyPath, "utf8")), Object.keys(aestheticAxes.axes || {}))
  : null;

console.log(JSON.stringify({ ...report, categorySuffixIssues, axisCoverage: { blindSpotRatio: axisCoverage.blindSpotRatio,
  blindSpots: axisCoverage.blindSpots }, generatedVocabularyIssues }, null, 2));
if (!report.ok) process.exitCode = 1;
