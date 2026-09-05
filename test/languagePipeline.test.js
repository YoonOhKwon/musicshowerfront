const test = require("node:test");
const assert = require("node:assert/strict");
const Snapshot = require("../js/semantic/semanticSnapshot");
const Critic = require("../js/semantic/languageCritic");
const Pool = require("../js/semantic/phrasePoolEngine");
const Selection = require("../js/visual/phraseSelection");
const Providers = require("../js/semantic/phraseProviders");
const { createLanguageRequest, createLanguageService, parseLanguageResponse, validateLanguageInput,
  normalizeTokenUsage, accumulateTokenUsage } = require("../lib/languageService");
const { profile, responseFixture } = require("./fixtures/languageProfiles");
const payload = () => parseLanguageResponse(responseFixture());
const input = () => ({ snapshot: Snapshot.serialize(profile()), recentPhrases: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("semantic snapshot contains only compact observed descriptors, not PCM or embeddings", () => {
  const state = profile();
  state.audio = { pcm: [1, 2, 3] }; state.embedding = [4, 5, 6];
  const snapshot = Snapshot.serialize(state);
  assert.equal(snapshot.rhythm.tempo, "fast");
  assert.equal(snapshot.audio, undefined);
  assert.equal(snapshot.embedding, undefined);
  assert.equal(snapshot.space.width, undefined);
  assert.equal(Snapshot.serialize({}).timbre.warmth, "unknown");
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.ok(JSON.stringify(snapshot).length < 3000);
});

test("same genre with contrasting character and different genres yield distinct snapshots", () => {
  const cold = Snapshot.serialize(profile("cold"));
  const warm = Snapshot.serialize(profile("warm"));
  const jazz = Snapshot.serialize(profile("jazz"));
  assert.equal(cold.primaryGenre, warm.primaryGenre);
  assert.notEqual(cold.fingerprint, warm.fingerprint);
  assert.notEqual(cold.timbre.warmth, warm.timbre.warmth);
  assert.notEqual(jazz.fingerprint, cold.fingerprint);
});

test("distinctiveness honestly labels session comparisons, never fabricated genre norms", () => {
  const tracker = new Snapshot.DistinctivenessTracker();
  for (let i = 0; i < 10; i++) tracker.observe(profile("cold").trackCharacter);
  const result = tracker.observe(profile("warm").trackCharacter);
  assert.equal(result.genreRelativeAvailable, false);
  assert.ok(result.statements.some(text => text.includes("session's recent baseline")));
  tracker.reset();
  assert.equal(tracker.current.statements.length, 0);
});

test("language request preserves Sol and explicit prefix while bounding recent memory", () => {
  const request = createLanguageRequest({ ...input(), recentPhrases: Array.from({ length: 200 }, () => "최근 문구") }, { model: "gpt-5.6-sol" });
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.store, false);
  // Section 5: fast/deep merged into one profile once phrasePoolEngine.js's axis-signature gate
  // started filtering out the routine top-up case locally -- every call reaching this point
  // already represents a real gap, so there is one schema/effort/budget, not two graded by reason.
  assert.equal(request.text.format.schema.properties.genre.maxItems, 2);
  assert.equal(JSON.parse(request.input[1].content).recentPhrases.length, 24);
  assert.equal(request.input[0].content[0].prompt_cache_breakpoint.mode, "explicit");
  assert.equal(request.max_output_tokens, 6000);
  const withExtra = input();
  withExtra.snapshot.rhythm.pcm = [1, 2, 3];
  assert.equal(validateLanguageInput(withExtra).snapshot.rhythm.pcm, undefined);
});

test("every call reason resolves to the single merged tuning profile", () => {
  const { callMode, CALL_TUNING } = require("../lib/languageService");
  for (const reason of ["pool-low", "pool-ready", "semantic-change", "initial-generation", "semantic-event", undefined])
    assert.equal(callMode(reason), "default", reason);

  const request = createLanguageRequest({ ...input(), reason: "pool-low" });
  assert.equal(request.reasoning.effort, "low");
  assert.equal(request.max_output_tokens, CALL_TUNING.default.maxOutputTokens);
  assert.equal(request.text.format.schema.properties.genre.maxItems, 2);
  assert.ok(request.max_output_tokens < 10000, "the merged profile must request meaningfully less than the old flat deep-mode 10000");

  // A different reason must produce an IDENTICAL request shape now -- there is nothing left to
  // grade by reason (the reason string still flows into the prompt payload itself for context).
  const otherReasonRequest = createLanguageRequest({ ...input(), reason: "semantic-change" });
  assert.equal(otherReasonRequest.reasoning.effort, request.reasoning.effort);
  assert.equal(otherReasonRequest.max_output_tokens, request.max_output_tokens);
  assert.deepEqual(otherReasonRequest.text.format.schema, request.text.format.schema);
});

test("malformed snapshots, incomplete responses and malformed candidate scores are rejected", () => {
  assert.throws(() => validateLanguageInput({ snapshot: {} }), /Missing/);
  assert.throws(() => parseLanguageResponse({ status: "incomplete" }), /incomplete/);
  assert.throws(() => parseLanguageResponse({ status: "completed", output_text: "no" }), /valid JSON/);
  const response = responseFixture();
  const value = JSON.parse(response.output_text);
  value.genre[0].confidence = 9;
  response.output_text = JSON.stringify(value);
  assert.throws(() => parseLanguageResponse(response), /validation/);
});

test("critic accepts literal music, ordinary moods and English genres, rejecting imagery and invalid anchors", () => {
  const candidates = [...payload().candidates, { text: "과열된 긴장", category: "mood" },
    { text: "저중력 부유", category: "mood" }, { text: "분석 중", category: "live" },
    { text: "차분함", anchors: ["invented.stereoWidth"] }, { text: "긴장된 분위기", category: "mood" }];
  const ranked = Critic.rank(candidates, { recent: ["긴장감"], context: { snapshot: input().snapshot }, limit: 36 });
  assert.ok(ranked.selected.some(item => item.text === "긴장감"));
  assert.ok(ranked.selected.some(item => item.text === "Techno" && item.category === "genre"));
  assert.ok(!ranked.selected.some(item => /과열|저중력|분석/.test(item.text)));
  assert.ok(ranked.assessed.some(item => item.diagnostics.invalidAnchors === 1));
  assert.equal(new Set(ranked.selected.map(item => item.semanticKey)).size, ranked.selected.length);
  assert.ok(ranked.selected.every(item => ["genre", "live", "dynamics", "mood"].includes(item.category)));
});

test("critic does not substitute invented language to evade repetition", () => {
  const ranked = Critic.rank([{ text: "차분함", category: "mood" }, { text: "정지된 온기", category: "mood", originality: 1 }],
    { recent: ["차분함"] });
  assert.deepEqual(ranked.selected.map(item => item.text), ["차분함"]);
});

test("one remote batch supplies many words, pool-low triggers only after cooldown", async () => {
  let calls = 0;
  const provider = { generate: async () => { calls++; return payload(); } };
  const engine = new Pool.Engine({ provider, stableDelayMs: 0, lowWatermark: 1 });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(engine.state.provider, "remote-generative");
  assert.equal(engine.state.selectedCount, payload().candidates.length);
  for (let i = 0; i < 100; i++) await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(calls, 1);
  for (const item of engine.pool) engine.noteUsed(item.text);
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(engine.state.status, "cooldown");
  assert.equal(calls, 1);
  assert.equal(engine.remaining(), 0);
  engine.lastRequestAt = Date.now() - 46000;
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(calls, 2);
});

test("generation waits for stable evidence and does not respond to raw fingerprint jitter", async () => {
  let calls = 0;
  const engine = new Pool.Engine({ provider: { generate: async () => { calls++; return payload(); } }, stableDelayMs: 5000 });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(calls, 0);
  engine.epochStartedAt -= 6000;
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(calls, 1);
  engine.lastRequestAt -= 60000;
  await engine.regenerate({ state: profile("warm"), sessionId: 1, epoch: 1 });
  assert.equal(calls, 1, "a meaningful semantic epoch or depleted pool is required");
});

test("old epoch and session responses cannot replace a newer pool; network slot remains single", async () => {
  const pending = deferred(); let calls = 0;
  const engine = new Pool.Engine({ provider: { generate: () => { calls++; return pending.promise; } }, stableDelayMs: 0, minimumIntervalMs: 0 });
  const old = engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  await engine.regenerate({ state: profile("warm"), sessionId: 1, epoch: 2 });
  assert.equal(calls, 1);
  pending.resolve(payload()); await old;
  assert.ok(engine.snapshot().every(item => item.epoch === 2 && item.source !== "remote-generative"));
  const next = deferred();
  engine.provider.generate = () => next.promise;
  const previous = engine.regenerate({ state: profile(), sessionId: 1, epoch: 2 });
  engine.reset(3);
  assert.ok(engine.activeRequest);
  next.resolve(payload()); await previous;
  assert.deepEqual(engine.snapshot(), []);
  assert.equal(engine.activeRequest, null);
});

test("cache reuses a still-fresh matching epoch and remains bounded", async () => {
  let calls = 0;
  const engine = new Pool.Engine({ provider: { generate: async () => { calls++; return payload(); } }, stableDelayMs: 0, minimumIntervalMs: 0 });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 2 });
  assert.equal(calls, 1);
  assert.equal(engine.state.cache, "hit");
  assert.ok(engine.snapshot().every(item => item.epoch === 2));
  const lru = new Pool.LRUCache(2); lru.set("a", { x: 1 }); lru.set("b", { x: 2 }); lru.get("a"); lru.set("c", { x: 3 });
  assert.equal(lru.get("b"), null);
  engine.reset(4); assert.equal(engine.cache.map.size, 0);
});

test("network failure retains relevant phrases and cannot break the caller", async () => {
  const engine = new Pool.Engine({ provider: { generate: async () => { throw new Error("offline"); } }, stableDelayMs: 0 });
  const phrases = await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.ok(phrases.length > 0);
  assert.equal(engine.state.status, "fallback");
  assert.match(engine.state.error, /offline/);
  assert.ok(phrases.every(item => !Pool.GENERIC.has(item.text)));
});

test("server deduplicates one in-flight request, caches results and disables hidden retries", async () => {
  const pending = deferred(); let calls = 0; let options;
  const client = { responses: { create: (_request, settings) => { calls++; options = settings; return pending.promise; } } };
  const service = createLanguageService({ client, minimumIntervalMs: 0 });
  const first = service.generate(input());
  const second = service.generate(input());
  await assert.rejects(service.generate({ snapshot: Snapshot.serialize(profile("warm")) }), /already running/);
  pending.resolve(responseFixture());
  const [generated] = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(options.maxRetries, 0);
  assert.equal(generated.meta.tokenUsage.request.inputTokens, 100);
  assert.equal(generated.meta.tokenUsage.request.outputTokens, 200);
  assert.equal(generated.meta.tokenUsage.request.totalTokens, 300);
  assert.equal(generated.meta.tokenUsage.languageSession.requests, 1);
  const cached = await service.generate(input());
  assert.equal(cached.meta.cache, "server"); assert.equal(calls, 1);
  assert.equal(cached.meta.tokenUsage.request.totalTokens, 0);
  assert.equal(cached.meta.tokenUsage.languageSession.totalTokens, 300);
});

test("LLM token tracking includes cache and reasoning details and accumulates safely", () => {
  const request = normalizeTokenUsage({
    input_tokens: 120,
    input_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
    output_tokens: 45,
    output_tokens_details: { reasoning_tokens: 21 },
    total_tokens: 165
  });
  assert.deepEqual(request, {
    requests: 1, inputTokens: 120, cachedInputTokens: 80, cacheWriteTokens: 12,
    outputTokens: 45, reasoningTokens: 21, totalTokens: 165, cacheHitRate: 2 / 3
  });
  const total = accumulateTokenUsage(request, request);
  assert.equal(total.requests, 2);
  assert.equal(total.totalTokens, 330);
  assert.equal(total.cacheHitRate, 2 / 3);
});

test("phrase pool preserves project token totals and clears last-request cost on cache reuse", async () => {
  const tokenUsage = {
    request: { requests: 1, inputTokens: 120, cachedInputTokens: 80, outputTokens: 45, reasoningTokens: 21, totalTokens: 165, cacheHitRate: 2 / 3 },
    languageSession: { requests: 1, inputTokens: 120, cachedInputTokens: 80, outputTokens: 45, reasoningTokens: 21, totalTokens: 165, cacheHitRate: 2 / 3 },
    projectSession: { requests: 3, inputTokens: 520, cachedInputTokens: 180, outputTokens: 245, reasoningTokens: 71, totalTokens: 765, cacheHitRate: 180 / 520 }
  };
  let calls = 0;
  const engine = new Pool.Engine({ minimumIntervalMs: 0, stableDelayMs: 0, provider: { generate: async () => {
    calls += 1;
    return { ...payload(), meta: { model: "test-sol", tokenUsage } };
  } } });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.equal(engine.state.tokenUsage.projectSession.totalTokens, 765);
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 2 });
  assert.equal(calls, 1);
  assert.equal(engine.state.cache, "hit");
  assert.equal(engine.state.tokenUsage.request.totalTokens, 0);
  assert.equal(engine.state.tokenUsage.projectSession.totalTokens, 765);
});

test("server missing-key and repeated-failure paths have explicit fallback and cooldown", async () => {
  await assert.rejects(createLanguageService().generate(input()), /not configured/);
  const service = createLanguageService({ client: { responses: { create: () => { throw new Error("offline"); } } } });
  await assert.rejects(service.generate(input()), /offline/);
  await assert.rejects(service.generate(input()), /cooling down/);
});

// A connection timeout has no HTTP status at all (it never reached a response) -- this is the
// exact shape that used to collapse into an unlogged, undifferentiated 502 (section 11's bug).
test("a connection timeout is classified as a timeout, not a bare unexplained failure", async () => {
  const timeoutError = new Error("Request timed out.");
  timeoutError.name = "APIConnectionTimeoutError";
  const service = createLanguageService({ client: { responses: { create: () => { throw timeoutError; } } }, minimumIntervalMs: 0 });
  await assert.rejects(service.generate(input()), error => {
    assert.equal(error.timedOut, true);
    assert.ok(Number.isFinite(error.elapsedMs));
    assert.equal(error.upstreamErrorType, "APIConnectionTimeoutError");
    return true;
  });
  assert.equal(service.state.lastError.code, "language_provider_timeout");
  assert.equal(service.state.lastError.status, 504);
  assert.equal(service.state.lastError.timedOut, true);
});

// A genuine upstream HTTP error (rate limit, billing, etc.) already carries a real status/code --
// that must pass through unchanged, not get relabeled as a timeout or a generic failure.
test("a real upstream HTTP error keeps its own status and code, not a generic 502", async () => {
  const upstreamError = Object.assign(new Error("429 You have no credits remaining."),
    { status: 429, code: "credit_balance_exhausted" });
  const service = createLanguageService({ client: { responses: { create: () => { throw upstreamError; } } }, minimumIntervalMs: 0 });
  await assert.rejects(service.generate(input()), error => {
    assert.equal(error.timedOut, false);
    return true;
  });
  assert.equal(service.state.lastError.code, "credit_balance_exhausted");
  assert.equal(service.state.lastError.status, 429);
});

test("repeated provider failures escalate the retry backoff instead of hammering the API", async () => {
  const engine = new Pool.Engine({ minimumIntervalMs: 0, stableDelayMs: 0,
    provider: { generate: async () => { throw new Error("provider down"); } } });
  const state = profile();
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(engine.consecutiveFailures, 1);
  assert.equal(engine.backoffMs(), 5000);
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  // Still inside the 5s backoff window from the first failure -- must not have retried yet.
  assert.equal(engine.consecutiveFailures, 1);
  engine.lastRequestAt = Date.now() - 6000;
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(engine.consecutiveFailures, 2);
  assert.equal(engine.backoffMs(), 10000);
  engine.lastRequestAt = Date.now() - 11000;
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(engine.consecutiveFailures, 3);
  assert.equal(engine.backoffMs(), 20000);
});

test("the failure KIND changes the wait, not just the failure count (section 13-1)", async () => {
  const failWith = fields => {
    const error = new Error("provider refused");
    Object.assign(error, fields);
    return new Pool.Engine({ minimumIntervalMs: 0, stableDelayMs: 0,
      provider: { generate: async () => { throw error; } } });
  };
  const state = profile();
  // An exhausted credit balance cannot be fixed by asking again in five seconds.
  const rateLimited = failWith({ status: 429, code: "credit_balance_exhausted", retryable: true });
  await rateLimited.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(rateLimited.backoffMs(), 60000);
  assert.equal(rateLimited.state.errorCode, "credit_balance_exhausted");
  // A missing key is not retryable at all, so it waits out of the way entirely.
  const misconfigured = failWith({ status: 503, code: "language_not_configured", retryable: false });
  await misconfigured.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(misconfigured.backoffMs(), 600000);
  assert.equal(misconfigured.state.retryable, false);
  // A transient failure keeps the normal fast-escalating schedule.
  const transient = failWith({ status: 504, code: "language_provider_timeout", retryable: true });
  await transient.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(transient.backoffMs(), 5000);
  // In every case the local engine must have taken over rather than leaving the pool empty.
  for (const engine of [rateLimited, misconfigured, transient]) {
    assert.equal(engine.state.status, "fallback");
    assert.ok(engine.snapshot().length > 0, "local fallback must keep speaking");
  }
});

test("a successful generation resets the failure streak back to zero", async () => {
  let shouldFail = true;
  const engine = new Pool.Engine({ minimumIntervalMs: 0, stableDelayMs: 0,
    provider: { generate: async () => { if (shouldFail) throw new Error("provider down"); return payload(); } } });
  const state = profile();
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(engine.consecutiveFailures, 1);
  shouldFail = false;
  engine.lastRequestAt = Date.now() - 6000;
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(engine.consecutiveFailures, 0);
  assert.equal(engine.backoffMs(), 0);
});

test("a pool-low refill requests the low-reasoning, small-schema call (the only profile there is now)", async () => {
  let sentRequest = null;
  const client = { responses: { create: (request) => { sentRequest = request; return Promise.resolve(responseFixture()); } } };
  const service = createLanguageService({ client, minimumIntervalMs: 0 });
  await service.generate({ ...input(), reason: "pool-low" });
  assert.equal(sentRequest.reasoning.effort, "low");
  assert.equal(sentRequest.text.format.schema.properties.genre.maxItems, 2);
});

test("selection suppresses visible synonyms but permits accurate later repetition", () => {
  const words = [{ text: "높은 음압", category: "dynamics", weight: 1 }];
  assert.equal(Selection.choose(words, [], () => 0, { active: ["큰 음압"] }), undefined);
  assert.equal(Selection.choose(words, [{ text: "높은 음압" }], () => 0).text, "높은 음압");
  assert.ok(Selection.treatment({ type: "micro" }).scale < Selection.treatment({ type: "single" }).scale);
});

test("worker critique is asynchronous and a session change during ranking rejects its result", async () => {
  const pending = deferred();
  const engine = new Pool.Engine({ stableDelayMs: 0, provider: { generate: async () => payload() }, ranker: { rank: () => pending.promise } });
  const generation = engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  await new Promise(resolve => setImmediate(resolve));
  engine.reset(2);
  pending.resolve(Critic.rank(payload().candidates));
  await generation;
  assert.deepEqual(engine.snapshot(), []);
});

test("long-session histories and phrase cache stay bounded", async () => {
  const engine = new Pool.Engine({ provider: { generate: async () => payload() }, stableDelayMs: 0, minimumIntervalMs: 0, cacheSize: 4 });
  for (let epoch = 0; epoch < 20; epoch++) {
    await engine.regenerate({ state: profile(epoch % 2 ? "warm" : "cold"), sessionId: 1, epoch });
    for (const item of engine.snapshot().slice(0, 8)) engine.noteUsed(item.text);
  }
  assert.ok(engine.recent.length <= 32);
  assert.ok(engine.worldHistory.length <= 12);
  assert.ok(engine.cache.map.size <= 4);
  assert.ok(engine.pool.length <= 40);
  assert.equal(engine.activeRequest, null);
});

test("browser remote provider sends the compact request and accepts the service response", async () => {
  const original = global.fetch;
  let sent;
  global.fetch = async (url, options) => {
    assert.equal(url, "/api/language-pool");
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...payload(), meta: { model: "test-sol" } }), { status: 200 });
  };
  try {
    const provider = new Providers.RemoteGenerativeProvider();
    const result = await provider.generate(input());
    assert.equal(sent.snapshot.primaryGenre, "Techno");
    assert.equal(result.candidates.length, payload().candidates.length);
    assert.equal(provider.state.model, "test-sol");
    assert.equal(provider.state.status, "ready");
  } finally { global.fetch = original; }
});

test("browser provider failure is explicit and non-Worker critic fallback is functional", async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ message: "cooldown" }), { status: 429 });
  try {
    const provider = new Providers.RemoteGenerativeProvider();
    await assert.rejects(provider.generate(input()), /cooldown/);
    assert.equal(provider.state.status, "error");
    const ranked = await new Providers.WorkerCritic().rank(payload().candidates, {});
    assert.equal(ranked.selected.length, payload().candidates.length);
  } finally { global.fetch = original; }
});
