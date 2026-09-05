const test = require("node:test");
const assert = require("node:assert/strict");
const Validator = require("../js/semantic/knowledgeConsistencyValidator");
const aestheticAxes = require("../data/aestheticAxes.json");
const genreContextKnowledge = require("../data/genreContextKnowledge.json");

const AXIS_NAMES = Object.keys(aestheticAxes.axes);

function validEntry(overrides = {}) {
  return { text: "과거의 향기", layer: "AESTHETIC", conceptKey: "nostalgia.scent",
    region: [{ axis: "nostalgia", min: 0.55 }, { axis: "decay", min: 0.45 }], minAxes: 2,
    register: "impression", relatedKeys: [], clicheRisk: 0.2, ...overrides };
}

test("a well-formed generated vocabulary batch passes with no issues", () => {
  const issues = Validator.validateGeneratedVocabulary({ entries: [validEntry()] }, AXIS_NAMES);
  assert.deepEqual(issues, []);
});

test("relatedKeys may point to another conceptKey in the same batch", () => {
  const entries = [validEntry({ conceptKey: "a", relatedKeys: ["b"] }), validEntry({ conceptKey: "b", text: "다른 표현" })];
  assert.deepEqual(Validator.validateGeneratedVocabulary({ entries }, AXIS_NAMES), []);
});

test("catches an unknown axis in a region condition", () => {
  const issues = Validator.validateGeneratedVocabulary({ entries: [validEntry({ region: [{ axis: "not_real", min: 0.5 }] })] }, AXIS_NAMES);
  assert.ok(issues.some(item => item.code === "vocabulary-unknown-axis"));
});

test("catches a duplicate conceptKey across entries", () => {
  const entries = [validEntry({ conceptKey: "dup" }), validEntry({ conceptKey: "dup", text: "다른 표현" })];
  const issues = Validator.validateGeneratedVocabulary({ entries }, AXIS_NAMES);
  assert.ok(issues.some(item => item.code === "vocabulary-concept-key-duplicate"));
});

test("catches a relatedKeys reference to a conceptKey that does not exist in the batch", () => {
  const issues = Validator.validateGeneratedVocabulary({ entries: [validEntry({ relatedKeys: ["ghost.key"] })] }, AXIS_NAMES);
  assert.ok(issues.some(item => item.code === "vocabulary-related-key-unknown"));
});

test("catches text that fails safeText() for its declared layer (song identification, control chars)", () => {
  const issues = Validator.validateGeneratedVocabulary({ entries: [validEntry({ text: "이 곡은 재즈입니다" })] }, AXIS_NAMES);
  assert.ok(issues.some(item => item.code === "vocabulary-fails-safe-text"));
});

test("catches minAxes outside [1, region.length] and an invalid layer", () => {
  const tooMany = Validator.validateGeneratedVocabulary({ entries: [validEntry({ minAxes: 5 })] }, AXIS_NAMES);
  assert.ok(tooMany.some(item => item.code === "vocabulary-min-axes-invalid"));
  const badLayer = Validator.validateGeneratedVocabulary({ entries: [validEntry({ layer: "FACT" })] }, AXIS_NAMES);
  assert.ok(badLayer.some(item => item.code === "vocabulary-layer-invalid"));
});

test("category-suffix convention: existing genreContextKnowledge.json entries are mostly clean, and a synthetic violation is caught", () => {
  const baseline = Validator.validateCategorySuffix(genreContextKnowledge);
  assert.ok(baseline.every(item => item.severity === "warning"), "convention drift is a warning, never an error");
  const broken = { genres: { Test: { candidates: [{ text: "이상한 단어", category: "era" }, { text: "이상한 단어2", category: "scene" }] } } };
  const issues = Validator.validateCategorySuffix(broken);
  assert.ok(issues.some(item => item.code === "era-suffix-convention"));
  assert.ok(issues.some(item => item.code === "scene-suffix-convention"));
});

test("category-suffix convention accepts the standard era/scene suffixes", () => {
  const clean = { genres: { Test: { candidates: [
    { text: "1980년대", category: "era" }, { text: "레트로 스타일", category: "era" }, { text: "레트로 계열", category: "era" },
    { text: "재즈 클럽 씬", category: "scene" }, { text: "재즈 클럽 문화", category: "scene" }
  ] } } };
  assert.deepEqual(Validator.validateCategorySuffix(clean), []);
});
