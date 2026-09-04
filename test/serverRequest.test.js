const test = require("node:test");
const assert = require("node:assert/strict");
const { createMusicAnalysisRequest, musicProfileSchema, BUILD_VERSION } = require("../server");

test("server exposes a build identifier for stale-process diagnosis", () => {
  assert.equal(BUILD_VERSION, "2026.09.05.song-language-diversity-v17");
});

test("Sol request keeps medium reasoning and an explicit reusable prompt prefix", () => {
  const request = createMusicAnalysisRequest({ audio: {}, rhythm: {} }, 10000);
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.max_output_tokens, 10000);
  assert.deepEqual(request.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.deepEqual(
    request.input[0].content[0].prompt_cache_breakpoint,
    { mode: "explicit" }
  );
});

test("structured output omits unused prose while retaining visual semantics", () => {
  const properties = musicProfileSchema.properties;
  assert.equal(properties.summary, undefined);
  assert.equal(properties.words.minItems, 8);
  assert.equal(properties.words.maxItems, 12);
  assert.ok(properties.genreProfile);
  assert.ok(properties.instrumentationProfile);
  assert.ok(properties.moodProfile);
  assert.ok(properties.visualProfile);
});
