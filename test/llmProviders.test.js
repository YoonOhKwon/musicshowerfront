"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adaptChatRequestForGemini, responsesToChatRequest, chatToResponsesResponse, retryDelayMs,
  createRequestLimiter, createGeminiClient, createLlmProviders
} = require("../lib/llmProviders");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");

function fakeClock(start = Date.UTC(2026, 8, 14, 18, 0, 0)) {
  let time = start;
  return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } };
}

test("chat requests are adapted to what the Gemini endpoint accepts", () => {
  const adapted = adaptChatRequestForGemini({ model: "gpt-5.6-sol", messages: [], reasoning_effort: "none",
    max_completion_tokens: 420, store: false, prompt_cache_key: "x", verbosity: "low",
    response_format: { type: "json_object" } }, "gemini-3.1-flash-lite");
  assert.equal(adapted.model, "gemini-3.1-flash-lite");
  // "none" is rejected with INVALID_ARGUMENT by the endpoint.
  assert.equal(adapted.reasoning_effort, "low");
  assert.equal(adapted.max_completion_tokens, 1024);
  assert.equal(adapted.store, undefined);
  assert.equal(adapted.prompt_cache_key, undefined);
  assert.equal(adapted.verbosity, undefined);
  assert.deepEqual(adapted.response_format, { type: "json_object" });
  assert.equal(adaptChatRequestForGemini({ max_tokens: 4000, reasoning_effort: "medium" }, "m").max_completion_tokens, 4000);
});

test("Responses API requests and responses round-trip through Chat Completions", () => {
  const chat = responsesToChatRequest({ model: "gpt", instructions: "be brief",
    input: [{ role: "developer", content: [{ type: "input_text", text: "rules" }] }, { role: "user", content: "{\"a\":1}" }],
    max_output_tokens: 3000, reasoning: { effort: "medium" },
    text: { verbosity: "low", format: { type: "json_schema", name: "pool", strict: true, schema: { type: "object" } } } });
  assert.deepEqual(chat.messages, [{ role: "system", content: "be brief" }, { role: "system", content: "rules" }, { role: "user", content: "{\"a\":1}" }]);
  assert.equal(chat.response_format.type, "json_schema");
  assert.equal(chat.response_format.json_schema.name, "pool");
  assert.equal(chat.max_completion_tokens, 3000);
  assert.equal(chat.reasoning_effort, "medium");

  const done = chatToResponsesResponse({ model: "gemini-3.1-flash-lite", choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  assert.equal(done.status, "completed");
  assert.equal(done.output_text, "{}");
  assert.equal(done.usage.input_tokens, 10);
  const cut = chatToResponsesResponse({ choices: [{ finish_reason: "length", message: { content: "{\"a\"" } }] });
  assert.equal(cut.status, "incomplete");
  assert.equal(cut.incomplete_details.reason, "max_output_tokens");
});

test("the limiter paces requests under the per-minute and daily free-tier limits", async () => {
  const clock = fakeClock();
  const limiter = createRequestLimiter({ rpm: 2, rpd: 3, maxWaitMs: 61000, now: clock.now, sleep: clock.sleep });
  await limiter.acquire();
  await limiter.acquire();
  const before = clock.now();
  await limiter.acquire();
  assert.ok(clock.now() - before >= 59000, "third request waits for the minute window");
  await assert.rejects(limiter.acquire(), error => error.code === "llm_daily_limit");
});

test("a minute limit that would need too long a wait fails fast instead of stalling the pipeline", async () => {
  const clock = fakeClock();
  const limiter = createRequestLimiter({ rpm: 1, rpd: 100, maxWaitMs: 5000, now: clock.now, sleep: clock.sleep });
  await limiter.acquire();
  await assert.rejects(limiter.acquire(), error => error.status === 429 && error.code === "llm_rate_limited");
});

test("an upstream quota error puts the provider into cooldown using its retry delay", async () => {
  const clock = fakeClock();
  const limiter = createRequestLimiter({ rpm: 10, rpd: 100, now: clock.now, sleep: clock.sleep });
  limiter.noteQuotaError({ status: 429, message: "RESOURCE_EXHAUSTED \"retryDelay\": \"31s\"" });
  await assert.rejects(limiter.acquire(), error => error.code === "llm_rate_limited");
  clock.advance(32000);
  await limiter.acquire();
  assert.equal(retryDelayMs({ message: "no hint" }, 60000), 60000);
});

test("the daily count resets on a new Pacific day", async () => {
  const clock = fakeClock(Date.UTC(2026, 8, 14, 6, 0, 0));
  const limiter = createRequestLimiter({ rpm: 10, rpd: 1, now: clock.now, sleep: clock.sleep });
  await limiter.acquire();
  await assert.rejects(limiter.acquire(), error => error.code === "llm_daily_limit");
  clock.advance(24 * 3600 * 1000);
  await limiter.acquire();
});

test("an overloaded Gemini model falls through to the next model; bad requests do not", async () => {
  const clock = fakeClock();
  const limiter = createRequestLimiter({ rpm: 100, rpd: 100, now: clock.now, sleep: clock.sleep });
  const seen = [];
  const upstream = { chat: { completions: { create: async request => {
    seen.push(request.model);
    if (request.model === "busy") throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 });
    return { model: request.model, choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }] };
  } } } };
  const gemini = createGeminiClient({ client: upstream, models: ["busy", "backup"], limiter });
  const response = await gemini.chat.completions.create({ messages: [], response_format: { type: "json_object" } });
  assert.deepEqual(seen, ["busy", "backup"]);
  assert.equal(response.model, "backup");

  const failing = createGeminiClient({ client: { chat: { completions: { create: async () => {
    throw Object.assign(new Error("Request contains an invalid argument."), { status: 400 });
  } } } }, models: ["a", "b"], limiter });
  await assert.rejects(failing.chat.completions.create({ messages: [] }), error => error.status === 400);
});

test("a json_schema the endpoint rejects is retried as JSON mode with the schema in the prompt", async () => {
  const clock = fakeClock();
  const limiter = createRequestLimiter({ rpm: 100, rpd: 100, now: clock.now, sleep: clock.sleep });
  const formats = [];
  const upstream = { chat: { completions: { create: async request => {
    formats.push(request.response_format.type);
    if (request.response_format.type === "json_schema") throw Object.assign(new Error("invalid schema"), { status: 400 });
    return { choices: [{ finish_reason: "stop", message: { content: "{}" } }] };
  } } } };
  const gemini = createGeminiClient({ client: upstream, models: ["m"], limiter });
  const response = await gemini.responses.create({ input: "hi", text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } } });
  assert.deepEqual(formats, ["json_schema", "json_object"]);
  assert.equal(response.status, "completed");
});

test("the provider registry reports availability without exposing keys", () => {
  class FakeOpenAI { constructor(options) { this.options = options; } }
  const providers = createLlmProviders({ OpenAI: FakeOpenAI, env: { GEMINI_API_KEY: "g-secret", GEMINI_RPM: "5" } });
  assert.equal(providers.defaultId, "gemini");
  assert.equal(providers.isConfigured("openai"), false);
  const described = providers.describe();
  assert.deepEqual(described.map(item => [item.id, item.configured]), [["openai", false], ["gemini", true]]);
  assert.equal(described[1].freeTier.rpm, 5);
  assert.ok(!JSON.stringify(described).includes("g-secret"));
  assert.equal(providers.resolve("unknown"), "gemini");
});

test("sessions lock the chosen provider and refuse one the server has no key for", t => {
  const messages = [];
  const session = new RealtimeMusicSession({ streamId: "p", send: m => messages.push(m), analyze: async () => ({}),
    realize: async () => ({}), llmProviders: ["gemini"], defaultLlmProvider: "gemini" });
  t.after(() => session.close());
  session.start({ tokenMode: "token", llmProvider: "openai" });
  assert.equal(session.started, false);
  assert.equal(messages.at(-1).code, "LLM_PROVIDER_UNAVAILABLE");
  session.start({ tokenMode: "token", llmProvider: "gemini" });
  const started = messages.find(m => m.type === "started");
  assert.equal(started.llmProvider, "gemini");
  session.start({ tokenMode: "token", llmProvider: "openai" });
  assert.equal(session.llmProvider, "gemini");
  const pool = messages.filter(m => m.type === "word_pool").at(-1);
  assert.equal(pool.analysis.llmProvider, "gemini");
  assert.equal(pool.analysis.openAIEnabled, false);
  assert.equal(pool.analysis.llmEnabled, true);
});
