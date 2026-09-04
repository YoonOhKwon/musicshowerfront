const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { profile } = require("../test/fixtures/languageProfiles");
const Critic = require("../js/semantic/languageCritic");
const Layers = require("../js/semantic/languageLayerPolicy");
const Quality = require("../js/semantic/phraseQuality");
const Pool = require("../js/semantic/phrasePoolEngine");
const Manager = require("../js/semantic/semanticFacetManager");
const Selection = require("../js/visual/phraseSelection");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { createLanguageService } = require("../lib/languageService");
const { BUILD_VERSION } = require("../server");

const LAYERS = Layers.names;
const FACT_SOURCES = ["primitive", "idiom", "rhythm", "instrument", "production", "arrangement"];
const RELATION_FAMILIES = ["PRIMARY_GENRE", "PARENT", "LINEAGE", "ADJACENCY", "ERA", "SCENE", "CULTURE", "ARTIST", "AESTHETIC_ASSOCIATION"];
const countBy = (items, keys, getter) => Object.fromEntries(keys.map(key => [key, items.filter(item => getter(item) === key).length]));
const layerCounts = items => countBy(items, LAYERS, item => item.layer);
const factSources = items => countBy(items.filter(item => item.layer === "FACT"), FACT_SOURCES, item => item.source);
const relationFamilies = items => countBy(items, RELATION_FAMILIES, item => Quality.relationFamily(item));

function duplicateMetrics(items) {
  const exact = new Map(), semantic = new Map();
  for (const item of items) {
    const literal = item.text.toLowerCase().replace(/\s+/g, " ").trim();
    exact.set(literal, (exact.get(literal) || 0) + 1);
    const key = Quality.conceptKey(item); semantic.set(key, [...(semantic.get(key) || []), item.text]);
  }
  const semanticGroups = [...semantic.values()].filter(group => group.length > 1);
  const mixedLanguage = group => group.some(text => /[가-힣]/.test(text)) && group.some(text => /[A-Za-z]/.test(text));
  return { exactDuplicateCount: [...exact.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    semanticDuplicateCount: semanticGroups.reduce((sum, group) => sum + group.length - 1, 0),
    crossLanguageDuplicateCount: semanticGroups.filter(mixedLanguage).reduce((sum, group) => sum + group.length - 1, 0) };
}

function selectForScreen(pool, state, count = 12) {
  let seed = 1777;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const recent = [], active = [];
  for (let index = 0; index < count; index++) {
    const item = Selection.choose(pool, recent, random, { active,
      changing: Boolean(state.expressionFeatures?.changing),
      observationSeconds: state.expressionFeatures?.observationSeconds ?? 30 });
    if (!item) break;
    recent.push(item); active.push(item.text);
  }
  return recent;
}

// Quality is judged on the five epistemic layers, not just on "did the JSON parse".
function measure(selected) {
  const total = Math.max(1, selected.length);
  const layerCounts = Object.fromEntries(Layers.names.map(layer =>
    [layer, selected.filter(item => item.layer === layer).length]));
  const distances = new Set(selected.map(item => item.semanticDistance));
  const concepts = new Set(selected.map(item => Quality.conceptKey(item)));
  const genericPoetry = selected.filter(item => /네온|별빛|유리빛|파동|잔광|몽환의|심장/.test(item.text) &&
    !(item.evidenceAxes || []).length).length;
  return {
    layerCounts,
    layersPresent: Layers.names.filter(layer => layerCounts[layer] > 0).length,
    distanceDiversity: distances.size,
    primitiveRatio: selected.filter(item => Quality.isPrimitive(item.text)).length / total,
    genericRatio: selected.filter(item => Quality.isGeneric(item.text)).length / total,
    genericPoetryRatio: genericPoetry / total,
    duplicateConceptRatio: 1 - concepts.size / total,
    contextCount: selected.filter(item => item.layer === "CONTEXT").length,
    aestheticCount: selected.filter(item => item.layer === "AESTHETIC").length,
    impressionCount: selected.filter(item => item.layer === "IMPRESSION").length,
    meanSpecificity: selected.reduce((sum, item) => sum + (item.specificity || 0), 0) / total,
    meanNovelty: selected.reduce((sum, item) => sum + (item.novelty || 0), 0) / total,
    meanContrastiveness: selected.reduce((sum, item) => sum + (item.contrastiveness || 0), 0) / total
  };
}

// Runs the ACTUAL PhrasePool.Engine used in production — context building (with eligibleTexts),
// the fallback/freshness/cooldown gates, the real critic, install(), and the real curate() —
// instead of calling Critic.rank() in isolation. No pipeline logic is duplicated here.
async function runFixture(name, state, service) {
  const generatedItems = Manager.base(state);
  const context = { snapshot: Snapshot.serialize(state), eligibleTexts: generatedItems.map(item => item.text) };
  const criticAccepted = Critic.rank(generatedItems, { context, limit: 100 }).selected;
  const engine = new Pool.Engine({
    provider: { generate: input => service.generate(input) },
    stableDelayMs: 0, minimumIntervalMs: 0, lowWatermark: 1
  });
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  const inspection = engine.inspection();
  const assessed = inspection.candidates || [];
  const generated = assessed.length;
  const acceptedItems = assessed.filter(item => item.valid);
  const pooled = engine.snapshot();
  const selected = selectForScreen(pooled, state);
  const selectedKeys = new Set(selected.map(item => Critic.semanticKey(item)));
  const acceptedButNeverSelected = acceptedItems.filter(item => !selectedKeys.has(item.semanticKey)).map(item => item.text);
  const rejected = assessed.filter(item => !item.valid).map(item => ({
    text: item.text, layer: item.layer, reasons: item.diagnostics?.reasons || [item.diagnostics?.rejectionReason],
    evidenceScore: Number((item.evidenceScore || 0).toFixed(3)),
    resolvedAnchorRatio: item.diagnostics?.resolvedAnchorRatio,
    contradiction: Number((item.diagnostics?.contradiction || 0).toFixed(2)),
    contradicted: item.diagnostics?.contradicted || []
  }));
  return {
    name, state: { primaryGenre: state.genre.primary, genreConfidence: state.genre.confidence },
    engineState: { status: engine.state.status, provider: engine.state.provider, reason: engine.state.reason,
      error: engine.state.error, model: engine.state.model || null, latencyMs: engine.state.latencyMs || 0,
      cache: engine.state.cache || "miss" },
    tokenUsage: inspection.state?.tokenUsage || null,
    funnel: { generated, accepted: acceptedItems.length, pool: pooled.length, selected: selected.length },
    survival: Object.fromEntries([["generated", generatedItems], ["criticAccepted", criticAccepted], ["pooled", pooled], ["selected", selected]]
      .map(([stage, items]) => [stage, layerCounts(items)])),
    factSources: Object.fromEntries([["generated", generatedItems], ["criticAccepted", criticAccepted], ["pooled", pooled], ["selected", selected]]
      .map(([stage, items]) => [stage, factSources(items)])),
    contextRelations: Object.fromEntries([["generated", generatedItems], ["criticAccepted", criticAccepted], ["pooled", pooled], ["selected", selected]]
      .map(([stage, items]) => [stage, relationFamilies(items)])),
    duplicates: duplicateMetrics(pooled),
    acceptedButNeverSelected, rejected: rejected.slice(0, 15),
    metrics: measure(selected), selected: selected.map(item => `${item.layer}:${item.category}:${item.text}`)
  };
}

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Use --live explicitly. This evaluation makes paid API calls (one per fixture).");
  require("dotenv").config({ quiet: true });
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for live evaluation.");
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_LANGUAGE_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const service = createLanguageService({ client, model, minimumIntervalMs: 0 });
  const report = { generatedAt: new Date().toISOString(), projectVersion: "Music Shower V16 Music-to-Language Reform", buildVersion: BUILD_VERSION,
    fixtureVersion: 2, basis: "controlled measurements through the shared production SemanticCandidatePipeline, PhrasePool, Critic and PhraseSelection",
    model, architecture: "LIVE/FACT/CONTEXT/AESTHETIC/IMPRESSION via production semantic candidate and phrase pipeline", results: [] };
  const warnings = [];
  const fixtures = ["futurefunk", "futurefunkb", "citypop", "ukgarage", "jungle", "liquiddnb", "funk", "jazztrio", "shoegaze", "ambient"];
  for (const name of fixtures) {
    console.log(`Interpreting ${name}: ${model}, full PhrasePool pipeline...`);
    const state = profile(name);
    const result = await runFixture(name, state, service);
    report.results.push(result);
    fs.writeFileSync(path.resolve(__dirname, "../docs/language-v2-live-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ name, funnel: result.funnel, metrics: result.metrics, selected: result.selected }, null, 2));

    assert.ok(result.engineState.status !== "fallback" || result.engineState.error, `${name}: expected a remote pool or a recorded error, not silent fallback`);
    if (result.funnel.selected === 0) warnings.push(`${name}: nothing reached the screen (generated=${result.funnel.generated}, accepted=${result.funnel.accepted})`);
    if (result.metrics.primitiveRatio > 0.35) warnings.push(`${name}: raw primitive descriptors are ${(result.metrics.primitiveRatio * 100).toFixed(0)}% of the display language`);
    if (result.metrics.genericPoetryRatio > 0.1) warnings.push(`${name}: ungrounded poetic imagery is ${(result.metrics.genericPoetryRatio * 100).toFixed(0)}%`);
    if (result.metrics.duplicateConceptRatio > 0.3) warnings.push(`${name}: ${(result.metrics.duplicateConceptRatio * 100).toFixed(0)}% of phrases repeat a concept already shown`);
    // Ambient/uncertain must not borrow club vocabulary; the others are free to use it if earned.
    if (["ambient", "uncertain"].includes(name)) {
      const clubWords = result.selected.filter(text => /4\/4 플로어|사이드체인|클럽|French House|four-on-floor/i.test(text));
      assert.deepEqual(clubWords, [], `${name}: club-culture vocabulary must not appear without rhythmic/production evidence for it`);
    }
    if (name === "futurefunk" && result.metrics.layersPresent < 2) warnings.push(`${name}: rich fixture reached only ${result.metrics.layersPresent} layer(s)`);
    if (["futurefunk", "citypop", "ukgarage"].includes(name)) {
      if (result.survival.selected.FACT < 1) warnings.push(`${name}: rich fixture selected no FACT`);
      if (result.survival.selected.CONTEXT < 1) warnings.push(`${name}: rich fixture selected no CONTEXT`);
    }
    const highResolutionFact = FACT_SOURCES.filter(source => source !== "primitive")
      .some(source => result.factSources.selected[source] > 0);
    if (name !== "uncertain" && !highResolutionFact) warnings.push(`${name}: selected FACT is raw-primitive-only`);
    const selectedContext = result.survival.selected.CONTEXT;
    const relationPeak = Math.max(0, ...Object.entries(result.contextRelations.selected)
      .filter(([family]) => family !== "PRIMARY_GENRE").map(([, count]) => count));
    if (selectedContext / Math.max(1, result.funnel.selected) > 0.6 && relationPeak / Math.max(1, selectedContext) > 0.65)
      warnings.push(`${name}: CONTEXT is saturated by one relation family`);
    if (result.duplicates.crossLanguageDuplicateCount) warnings.push(`${name}: cross-language semantic duplicates survived pooling`);
  }
  report.usageSummary = { calls: service.state.requests, cacheHits: service.state.cacheHits,
    tokenUsage: service.state.tokenUsage, projectTokenUsage: service.state.projectTokenUsage };
  report.warnings = warnings;
  fs.writeFileSync(path.resolve(__dirname, "../docs/language-v2-live-report.json"), JSON.stringify(report, null, 2));
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  console.log(`PASS: ${fixtures.length} live fixtures through the production pipeline. ` +
    `Layers reached: ${report.results.map(r => r.metrics.layersPresent).join("/")}; ` +
    `selected: ${report.results.map(r => r.funnel.selected).join("/")}.`);
}
if (require.main === module) {
  main().catch(error => { console.error(`Language smoke failed: ${error.code || ""} ${error.message}`); process.exitCode = 1; });
}
module.exports = { runFixture, measure };
