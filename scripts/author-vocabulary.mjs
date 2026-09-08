#!/usr/bin/env node
// Dev-only offline vocabulary authoring tool. NEVER required/imported by server.js, any
// browser-loaded script (index.html), or any other runtime module -- it calls an LLM directly
// and writes a *.generated.json review file, never a runtime data file. Run by hand:
//   node scripts/author-vocabulary.mjs --target vocabulary --limit 12
//   node scripts/author-vocabulary.mjs --target genre-context --limit 8
// See docs/VOCABULARY_AUTHORING.md for the required human-review-then-merge workflow -- nothing
// this script writes is ever auto-promoted to a runtime data file by any other script.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config({ quiet: true });
const OpenAI = require("openai");
const GenreContext = require("../js/semantic/genreContextEngine.js");
const Validator = require("../js/semantic/knowledgeConsistencyValidator.js");

const root = path.resolve(import.meta.dirname, "..");
const readJson = async relativePath => JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));

const aestheticAxesData = await readJson("data/aestheticAxes.json");
const AXIS_NAMES = Object.keys(aestheticAxesData.axes || {});
// STEP 4-1: real axis values (per data/axisDistribution.json, from scripts/replay.cjs) cluster
// well below the 0.55-0.8 thresholds hand-guessed into data/aestheticRegions.json's first 28
// entries -- so the LLM is never asked for an absolute threshold here. It picks a percentile BAND
// instead, converted to an actual number after generation (see convertBandToRange below), with
// the original band label kept alongside the number for later recalibration.
const axisDistribution = await readJson("data/axisDistribution.json").catch(() => null);
const BAND_NAMES = ["very_high", "high", "mid", "low"];
function convertBandToRange(axisName, band) {
  const axisPercentiles = axisDistribution?.percentiles?.[axisName];
  if (!axisPercentiles) return { min: 0.5 }; // no distribution data yet -- a neutral fallback, flagged by the caller
  const round = value => Number.isFinite(value) ? Number(value.toFixed(3)) : undefined;
  if (band === "very_high") return { min: round(axisPercentiles.p90) };
  if (band === "high") return { min: round(axisPercentiles.p75) };
  if (band === "mid") return { min: round(axisPercentiles.p40), max: round(axisPercentiles.p70) };
  if (band === "low") return { max: round(axisPercentiles.p25) };
  return { min: 0.5 };
}
const genreContextKnowledge = await readJson("data/genreContextKnowledge.json");
// data/genreCompositions.json is gone: genre names are no longer authored into a table.
const genreCompositions = { rules: [] };
const genreAliases = await readJson("data/genreAliases.json");
const discogsModel = await readJson("models/music-shower/assets/discogs-effnet-bsdynamic-1.json");

// Canonicalizes a raw Discogs-EffNet class label the same way semanticEngine.js's
// canonicalGenre() does (split "parent---specific", resolve through data/genreAliases.json), so
// any label this offers to (or accepts from) the LLM is genuinely reachable at runtime.
function canonicalLabelsFromModel() {
  const aliasLookup = new Map(Object.entries(genreAliases).map(([key, value]) => [key.toLowerCase(), value]));
  return [...new Set((discogsModel.classes || []).map(rawClass => {
    const specific = rawClass.includes("---") ? rawClass.split("---", 2)[1] : rawClass;
    return aliasLookup.get(specific.toLowerCase()) || specific;
  }))];
}
const CANONICAL_LABELS = canonicalLabelsFromModel();

// Curated 2-3 axis territories to seed the LLM's creative direction (section 3.1: "축 공간을
// 영역으로 나누고, 각 영역마다 다양한 결의 감상 어휘를 요청"). Kept in sync with
// data/aestheticAxes.json by the assertion loop right below -- a renamed/removed axis here fails
// loudly instead of silently authoring against a stale axis name.
const SEED_REGIONS = [
  { axes: ["nostalgia", "decay"], description: "낡고 바랜 기억, 오래된 매체의 질감" },
  { axes: ["nostalgia", "glossiness", "urbanity"], description: "버블경제 시절 도시의 반짝임" },
  { axes: ["artificiality", "glossiness"], description: "인공적이고 매끈한 광택" },
  { axes: ["artificiality", "drive"], description: "가상의 질주감, 디지털 스피드" },
  { axes: ["decay", "warmth"], description: "따뜻하게 낡아가는 느낌" },
  { axes: ["drive", "tension"], description: "조여오는 질주감, 압박된 속도" },
  { axes: ["intimacy", "warmth"], description: "가까운 거리의 온기" },
  { axes: ["urbanity", "glossiness"], description: "도시의 야경, 매끈한 스카이라인" },
  { axes: ["weight", "tension"], description: "짓누르는 압박감" },
  { axes: ["weight", "intimacy"], description: "육중하고 가까운 존재감" },
  { axes: ["glossiness", "drive"], description: "매끄럽게 미끄러지는 속도감" },
  { axes: ["decay", "intimacy"], description: "낡은 방 안의 고요한 근접감" },
  { axes: ["nostalgia", "warmth"], description: "따뜻한 회상" },
  { axes: ["artificiality", "tension"], description: "인공적으로 조여오는 긴장" },
  { axes: ["urbanity", "drive"], description: "도시의 속도감" },
  { axes: ["decay", "weight"], description: "무겁게 가라앉은 열화" },
  { axes: ["glossiness", "warmth"], description: "따뜻한 광택" },
  { axes: ["intimacy", "decay", "warmth"], description: "낡은 온기가 남은 방" },
  { axes: ["artificiality", "urbanity"], description: "인공적인 도시 감각" },
  { axes: ["nostalgia", "drive"], description: "짙어지는 향수, 흘러가는 시간" },
  // STEP 2 additions: syncopation (split out of the old combined "motion") and the two newly
  // added axes (density, clarity) had no seed territory at all until now.
  { axes: ["syncopation", "urbanity"], description: "도시의 엇박 그루브, 개러지풍 스텝" },
  { axes: ["density", "weight"], description: "짓누르는 밀도, 두꺼운 질감" },
  { axes: ["clarity", "intimacy"], description: "투명하고 가까운 소리결" }
];
for (const region of SEED_REGIONS) for (const axis of region.axes)
  if (!AXIS_NAMES.includes(axis)) throw new Error(`SEED_REGIONS references unknown axis "${axis}" -- keep this list in sync with data/aestheticAxes.json`);

function parseArgs(argv) {
  const args = { target: "vocabulary", limit: 20, out: null, model: process.env.OPENAI_LANGUAGE_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-sol",
    termsPerRegion: 6, targets: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--target") args.target = argv[++index];
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--model") args.model = argv[++index];
    else if (arg === "--terms-per-region") args.termsPerRegion = Number(argv[++index]);
    else if (arg === "--targets") args.targets = argv[++index].split(",").map(name => name.trim()).filter(Boolean);
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error("--limit must be a positive number");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (!client) {
  console.error("OPENAI_API_KEY is not set (checked .env) -- cannot author vocabulary. Set it and retry.");
  process.exit(1);
}

const VOCAB_ITEM_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: 40 },
    layer: { type: "string", enum: ["AESTHETIC", "IMPRESSION"] },
    conceptKey: { type: "string", maxLength: 60 },
    region: { type: "array", minItems: 1, maxItems: 4,
      items: { type: "object", additionalProperties: false,
        properties: { axis: { type: "string", enum: AXIS_NAMES }, band: { type: "string", enum: BAND_NAMES } },
        required: ["axis", "band"] } },
    minAxes: { type: "integer", minimum: 1, maximum: 4 },
    register: { type: "string", enum: ["impression", "association", "cultural"] },
    relatedKeys: { type: "array", maxItems: 5, items: { type: "string", maxLength: 60 } },
    clicheRisk: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["text", "layer", "conceptKey", "region", "minAxes", "register", "relatedKeys", "clicheRisk"]
};
const VOCAB_RESPONSE_SCHEMA = { type: "object", additionalProperties: false,
  properties: { entries: { type: "array", items: VOCAB_ITEM_SCHEMA } }, required: ["entries"] };

const VOCAB_INSTRUCTIONS = `You author short Korean appreciative/impressionistic phrases for a live music visualization app. These words are NOT factual claims about the music -- they are impressions a listener might form, licensed by (not proven by) the given axis territory.
Absolute rules, no exceptions:
- Never identify a song, artist, or composer. Never claim an actual recording date, place, or personnel.
- Never narrate an unobserved person or event ("she looked out the window").
- 1-4 words per phrase, Korean-first; an established English aesthetic term (Y2K, lo-fi, liminal, city pop) is fine when it is genuinely how the scene refers to itself, not an invented coinage.
- Within one request, vary the REGISTER across entries: literal description, metaphor, cultural/scene reference, tactile/textural, spatial. Do not just list synonyms of the same idea.
- conceptKey identifies the CONCEPT (e.g. "nostalgia.tape_hiss"), not the surface wording -- lowercase, dot-separated.
- relatedKeys should point to conceptKeys of OTHER entries you are also producing in this same batch where a real thematic link exists; use an empty array if none.
- clicheRisk: your own honest 0-1 estimate of how generic/AI-poetry-sounding this phrase already is (0 = fresh, 1 = a cliche like "차가운 황홀").
- minAxes must be between 1 and the number of conditions in region, normally equal to region.length.
- region[].band is a RELATIVE percentile band against how this axis actually measures across real
  tracks, not an absolute 0-1 threshold: "very_high" = top 10% of tracks on this axis, "high" = top
  25%, "mid" = the middle range (40th-70th percentile), "low" = bottom 25%. Pick the band that
  matches the phrase's intensity -- e.g. a phrase about an overwhelming wall of sound should use
  "very_high" density, not "mid".
Return only the structured JSON, no prose.`;

const GENRE_CANDIDATE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: 40 },
    category: { type: "string", enum: ["lineage", "era", "scene", "culture", "association"] },
    requires: { type: "array", minItems: 2, maxItems: 3,
      items: { type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, min: { type: "number", minimum: 0, maximum: 1 } }, required: ["path", "min"] } }
  },
  required: ["text", "category", "requires"]
};
const GENRE_RESPONSE_SCHEMA = { type: "object", additionalProperties: false,
  properties: { candidates: { type: "array", items: GENRE_CANDIDATE_SCHEMA } }, required: ["candidates"] };

const ALLOWED_CONTEXT_PATHS = [...Validator.CONTEXT_PATHS];
const GENRE_INSTRUCTIONS = `You author style-association candidates for a music knowledge base, in the exact schema given.
Absolute rules:
- "requires" conditions must use ONLY these exact snapshot paths (copy verbatim, do not invent new ones): ${ALLOWED_CONTEXT_PATHS.join(", ")}.
- Use at least 2 requires conditions from at least 2 different prefixes (e.g. one rhythmicGrammar.* and one productionEvidence.*) so a single measurement can never alone unlock the phrase.
- category "era" text must end in 년대, 스타일, or 계열. category "scene" text must end in 씬 or 문화. category "lineage" text normally ends in 계열. category "association" is a style comparison ("~미학", "~감성", "~연상"), never identification.
- Never claim actual origin, recording date, or identify an artist.
Return only the structured JSON, no prose.`;

// Section 4: Discogs' 400 classes are a coordinate system, not a wall -- an internet/scene genre
// name (Future Funk, French House) that has no dedicated class can still be inferred from WHICH
// classes the classifier's own top-K weights, combined with real audio evidence. requiresTopK
// must reference REAL model labels (enforced by the enum below), never an invented one.
const COMPOSITION_RULE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    text: { type: "string", maxLength: 40 },
    requiresTopK: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", enum: CANONICAL_LABELS } },
    minTopKCount: { type: "integer", minimum: 1, maximum: 4 },
    requires: { type: "array", minItems: 2, maxItems: 3,
      items: { type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, min: { type: "number", minimum: 0, maximum: 1 } }, required: ["path", "min"] } }
  },
  required: ["text", "requiresTopK", "minTopKCount", "requires"]
};
const COMPOSITION_RESPONSE_SCHEMA = { type: "object", additionalProperties: false,
  properties: { rules: { type: "array", items: COMPOSITION_RULE_SCHEMA } }, required: ["rules"] };
const COMPOSITION_INSTRUCTIONS = `You author rules that infer an internet/scene genre NAME that has no dedicated class in a 400-class Discogs-EffNet genre classifier, from a combination of which real classes the classifier tends to rank highly for that style plus real audio evidence.
Absolute rules:
- text is a TENTATIVE hypothesis, never a fact -- it MUST end in 계열 or 경향.
- requiresTopK must list 2-3 of the REAL class labels given to you (copy verbatim) that a classifier would plausibly rank highly for tracks that scene/internet-genre community would call by this name. Never invent a label.
- minTopKCount is normally 2 unless requiresTopK has only 1-2 entries.
- requires: 2-3 conditions using ONLY these exact snapshot paths (copy verbatim): ${ALLOWED_CONTEXT_PATHS.join(", ")}, from at least 2 different prefixes.
- Never claim actual origin or identify an artist.
Return only the structured JSON, no prose.`;

async function authorComposition(targetName, hint, count) {
  const prompt = `Known real class labels: ${CANONICAL_LABELS.join(", ")}\nAuthor ${count} composition rule(s) for the internet/scene genre "${targetName}"${hint ? ` (${hint})` : ""}.`;
  const parsed = await callResponses(COMPOSITION_INSTRUCTIONS, prompt, COMPOSITION_RESPONSE_SCHEMA, "composition_rule_batch");
  return parsed.rules || [];
}

async function runCompositions() {
  // Targets are supplied by the operator (there is no automatic way to discover "genre names the
  // internet uses but Discogs doesn't classify" -- that list itself takes human judgment). Reuses
  // whatever data/genreCompositions.json already covers as the default target set so a re-run
  // authors alternative rule variants for the same known gaps; pass --targets to override.
  const targets = args.targets || [];
  const rules = [];
  for (const target of targets.slice(0, args.limit)) {
    process.stderr.write(`Authoring composition rule for [${target}] ...\n`);
    try {
      rules.push(...await authorComposition(target, null, 1));
    } catch (error) {
      process.stderr.write(`  [${target}] failed: ${error.message}\n`);
    }
  }
  const output = { generatedAt: new Date().toISOString(), model: args.model, rules };
  const issues = Validator.validateGenreCompositions(output, {});
  return { output, issues };
}

async function callResponses(instructions, prompt, schema, schemaName) {
  const response = await client.responses.create({
    model: args.model,
    input: [
      { role: "developer", content: [{ type: "input_text", text: instructions }] },
      { role: "user", content: [{ type: "input_text", text: prompt }] }
    ],
    text: { verbosity: "low", format: { type: "json_schema", name: schemaName, strict: true, schema } }
  }, { timeout: 60000, maxRetries: 1 });
  return JSON.parse(response.output_text);
}

async function authorVocabularyRegion(region, count) {
  const prompt = `axes: ${region.axes.join(", ")}\ndescription: ${region.description}\nGenerate ${count} DISTINCT phrases for this axis territory. Each region[].axis must be one of exactly: ${region.axes.join(", ")}. minAxes should normally equal ${region.axes.length}.`;
  const parsed = await callResponses(VOCAB_INSTRUCTIONS, prompt, VOCAB_RESPONSE_SCHEMA, "vocabulary_batch");
  return parsed.entries || [];
}

// STEP 4-1: converts each region condition's LLM-chosen band into an actual {min, max} threshold
// against data/axisDistribution.json's real measured percentiles, while keeping the original band
// label on the same condition for later recalibration (the whole point of banding instead of
// asking for an absolute number). minAxes is carried through unchanged.
function applyBandConversion(entries) {
  const usedFallback = new Set();
  for (const entry of entries) {
    for (const condition of entry.region || []) {
      const band = condition.band;
      const range = convertBandToRange(condition.axis, band);
      if (!axisDistribution?.percentiles?.[condition.axis]) usedFallback.add(condition.axis);
      condition.min = range.min ?? 0;
      if (Number.isFinite(range.max)) condition.max = range.max;
    }
  }
  return [...usedFallback];
}

async function runVocabulary() {
  if (!axisDistribution) process.stderr.write("[author-vocabulary] data/axisDistribution.json not found -- bands will fall back to a flat 0.5 threshold. Run scripts/replay.cjs first for real percentile calibration.\n");
  const regionsNeeded = Math.max(1, Math.ceil(args.limit / args.termsPerRegion));
  const regions = SEED_REGIONS.slice(0, regionsNeeded);
  const entries = [];
  for (const region of regions) {
    if (entries.length >= args.limit) break;
    process.stderr.write(`Authoring region [${region.axes.join("+")}] ...\n`);
    try {
      const batch = await authorVocabularyRegion(region, Math.min(args.termsPerRegion, args.limit - entries.length));
      entries.push(...batch);
    } catch (error) {
      process.stderr.write(`  region [${region.axes.join("+")}] failed: ${error.message}\n`);
    }
  }
  const trimmed = entries.slice(0, args.limit);
  const fallbackAxes = applyBandConversion(trimmed);
  if (fallbackAxes.length) process.stderr.write(`[author-vocabulary] no distribution data for axes: ${fallbackAxes.join(", ")} -- their bands used the flat 0.5 fallback, review by hand.\n`);
  const output = { generatedAt: new Date().toISOString(), model: args.model,
    sourceRegions: regions.map(region => region.axes), entries: trimmed };
  const issues = Validator.validateGeneratedVocabulary(output, AXIS_NAMES);
  return { output, issues };
}

async function authorGenreContext(label, count) {
  const prompt = `genre label: ${label}\nGenerate ${count} DISTINCT style-association candidates for this genre.`;
  const parsed = await callResponses(GENRE_INSTRUCTIONS, prompt, GENRE_RESPONSE_SCHEMA, "genre_candidate_batch");
  return parsed.candidates || [];
}

async function runGenreContext() {
  const covered = new Set(Object.keys(genreContextKnowledge.genres || {}).map(name => name.toLowerCase()));
  const uncovered = CANONICAL_LABELS.filter(label => !covered.has(label.toLowerCase())).slice(0, args.limit);
  const byGenre = {};
  for (const label of uncovered) {
    process.stderr.write(`Authoring genre-context candidates for [${label}] ...\n`);
    try {
      byGenre[label] = await authorGenreContext(label, args.termsPerRegion);
    } catch (error) {
      process.stderr.write(`  [${label}] failed: ${error.message}\n`);
    }
  }
  // Same shape as genreContextKnowledge.json's own `genres` object, so a reviewer can diff/merge
  // it directly -- but written to a SEPARATE *.generated.json file, never merged automatically.
  const output = { generatedAt: new Date().toISOString(), model: args.model, genres: byGenre };
  const fakeKnowledge = { genres: byGenre };
  const issues = [
    ...Validator.validateContextKnowledge(fakeKnowledge, {}).filter(item => item.code === "context-path-missing"),
    ...Validator.validateCategorySuffix(fakeKnowledge)
  ];
  return { output, issues };
}

const RUNNERS = { vocabulary: runVocabulary, "genre-context": runGenreContext, compositions: runCompositions };
const DEFAULT_OUT_PATHS = { vocabulary: "data/aestheticVocabulary.generated.json",
  "genre-context": "data/genreContextCandidates.generated.json", };

async function main() {
  const runner = RUNNERS[args.target];
  if (!runner) throw new Error(`Unknown --target "${args.target}" -- expected one of: ${Object.keys(RUNNERS).join(", ")}`);
  const { output, issues } = await runner();
  const outPath = args.out || DEFAULT_OUT_PATHS[args.target];
  await fs.writeFile(path.join(root, outPath), JSON.stringify(output, null, 2) + "\n");
  const entryCount = output.entries?.length ?? output.rules?.length ?? Object.values(output.genres || {}).flat().length;
  console.log(`Wrote ${entryCount} entries to ${outPath}`);
  if (issues.length) {
    console.log(`\n${issues.length} validation issue(s) -- review before merging (see docs/VOCABULARY_AUTHORING.md):`);
    for (const item of issues) console.log(`  [${item.severity}] ${item.code}: ${item.message}`);
  } else {
    console.log("No validation issues on this batch -- still requires human review before merging (docs/VOCABULARY_AUTHORING.md).");
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
