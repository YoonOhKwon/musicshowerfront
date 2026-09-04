const Primitives = require("../js/semantic/musicalPrimitiveEngine");
const Idioms = require("../js/semantic/musicalIdiomEngine");
const Grammar = require("../js/semantic/rhythmicGrammar");
const Pipeline = require("../js/semantic/semanticCandidatePipeline");
const Impressions = require("../js/semantic/impressionSynthesizer");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const { profile, RICH_KINDS } = require("../test/fixtures/languageProfiles");
const lexicon = require("../data/musicalLexicon.json");
const taxonomy = require("../data/genreTaxonomy.json");
const contextKnowledge = require("../data/genreContextKnowledge.json");

const schema = Primitives.schema();
const engine = new Idioms.Engine(lexicon, { primitiveSchema: schema, genreTaxonomy: taxonomy });
// Identical sampling to scripts/knowledge-coverage.cjs and test/musicLanguageReform.test.js --
// all three must classify DECLARED_ONLY primitives the same way (section 16).
const primitiveSamples = [...RICH_KINDS, "cold", "warm", "jazz"].map(kind => Primitives.analyze(profile(kind)));
const primitiveClassification = Validator.classifyPrimitives(schema, primitiveSamples);
const report = Validator.validate({ lexicon, primitiveSchema: schema, graph: engine.graph,
  detectorRules: Pipeline.productionRules, detectorCapabilities: Grammar.detectorCapabilities, contextKnowledge,
  primitiveClassification, impressionRules: Impressions.RULES, directConsumerPaths: Pipeline.primitiveConsumerPaths });
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
