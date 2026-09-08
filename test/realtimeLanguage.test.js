const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../js/semantic/musicExpressionEngine");
const Pool = require("../js/semantic/phrasePoolEngine");
const Critic = require("../js/semantic/languageCritic");
const Selection = require("../js/visual/phraseSelection");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { validateLanguageInput, parseLanguageResponse } = require("../lib/languageService");
const { profile, responseFixture } = require("./fixtures/languageProfiles");
const texts = state => E.generate(state).map(x => x.text);
const baseline = { rms: 0.02, peak: 0.08, energy: 0.07, bass: 0.12, mid: 0.2, high: 0.1, centroid: 1100, flux: 0.001, transientDensity: 0.1, flatness: 0.1 };

test("sample-peak, RMS and time-domain crest factor are independently measured", () => {
  const frame = E.measure([0, 0, 0, 1]);
  assert.equal(frame.rms, 0.5);
  assert.equal(frame.peak, 1);
  assert.ok(Math.abs(frame.crestFactorDb - 6.0206) < 0.001);
  assert.deepEqual(E.measure([0, 0]).rms, 0);
});

test("linear spectral measurement locates a low tone without log-bin brightness bias", () => {
  const bins = new Float32Array(2048).fill(-Infinity);
  bins[8] = -12;
  const result = E.measureSpectrum(bins, 48000, 4096);
  assert.ok(Math.abs(result.centroid - 93.75) < 0.001);
  assert.equal(result.bass, 1);
  assert.equal(result.high, 0);
  assert.ok(result.flatness < 0.001);
});

test("a drop and quiet passage change LIVE/DYNAMICS within one 500ms sample", () => {
  const history = new E.FeatureHistory();
  for (let at = 0; at <= 4000; at += 500) history.update(baseline, at);
  const loud = history.update({ ...baseline, rms: 0.3, peak: 0.9, energy: 0.8, bass: 0.85, centroid: 4000, transientDensity: 0.85 }, 4500);
  const rising = texts({ ...profile(), expressionFeatures: loud });
  for (const text of ["높은 음압", "에너지 상승", "저역 유입", "강한 드롭", "드롭 진입"]) assert.ok(rising.includes(text), text);
  const quiet = history.update({ ...baseline, rms: 0.004, energy: 0.01 }, 5000);
  const falling = texts({ ...profile(), expressionFeatures: quiet });
  assert.ok(falling.includes("낮은 음압"));
  assert.ok(falling.includes("에너지 하강"));
  assert.ok(!falling.includes("높은 음압"));
  assert.ok(!falling.includes("강한 드롭"));
});

test("startup has no invented state and silence clears energetic and genre labels", () => {
  assert.deepEqual(E.generate({}), []);
  const silent = new E.FeatureHistory().update({ rms: 0, peak: 0, energy: 0 }, 0);
  assert.deepEqual(texts({ ...profile(), expressionFeatures: silent }), ["낮은 음압", "낮은 에너지"]);
});

test("history is throttled and bounded by both count and duration", () => {
  const history = new E.FeatureHistory();
  const first = history.update(baseline, 0);
  assert.equal(history.update({ ...baseline, rms: 1 }, 200), first);
  for (let at = 500; at < 180000; at += 500) history.update(baseline, at);
  assert.equal(history.frames.length, 90);
  assert.ok(history.summary().windowSeconds <= 45);
  assert.equal(history.current.deltaEnergy, 0);
  history.reset();
  assert.equal(history.frames.length, 0);
  assert.equal(history.current, null);
});

test("low crest sine and silence never imply strong compression", () => {
  for (const rms of [0, 0.25]) {
    const history = new E.FeatureHistory();
    for (let at = 0; at <= 5000; at += 500) history.update({ ...baseline, rms, peak: rms * Math.SQRT2, flatness: 0 }, at);
    assert.equal(history.current.compressionEstimate, null);
    assert.ok(!texts({ expressionFeatures: history.current }).includes("강한 압축"));
  }
});

test("simple mood vocabulary is allowed, independent traits do not become compounds", () => {
  for (const text of ["차분함", "긴장감", "몽환적", "차가움"]) assert.equal(Critic.assess({ text, category: "mood" }).valid, true);
  for (const text of ["과열된 긴장", "저중력 부유", "냉각된 긴장", "유리 같은 고독", "밤의 추진력"])
    assert.equal(Critic.assess({ text, category: "mood", originality: 1 }).valid, false);
  const warm = texts(profile("warm"));
  assert.ok(warm.includes("차분함"));
  assert.ok(warm.includes("따뜻함"));
});

test("all legitimate English genre spellings pass, but neighborhood scores cannot become genres", () => {
  for (const text of ["Jersey Club", "UK Garage", "2-Step", "IDM", "Footwork", "Neo Soul", "Drum & Bass", "Art Pop"])
    assert.equal(Critic.assess({ text, category: "genre", confidence: 0.8 }).valid, true, text);
  const state = { ...profile(), genre: { primary: "House", confidence: 0.8, uncertain: true,
    fineCandidates: [{ label: "Jersey Club", score: 0.99 }], topK: [{ label: "Juke", confidence: 0.2 }] } };
  assert.equal(E.generate(state).filter(x => x.category === "genre").length, 0);
});

test("semantic synonyms deduplicate and an accurate repeat remains eligible", () => {
  const selected = Critic.rank(["높은 음압", "큰 음압", "매우 높은 라우드니스", "긴장감", "긴장됨", "긴장된 분위기"].map(text => ({ text })), { recent: ["높은 음압", "긴장감"] }).selected;
  assert.deepEqual(selected.map(x => x.text).sort(), ["긴장감", "높은 음압"]);
});

test("category scheduling is independent of pool size and adapts to musical change", () => {
  let seed = 17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pool = ["genre", "live", "dynamics", "mood"].flatMap(category =>
    Array.from({ length: category === "live" ? 20 : 1 }, (_, i) => ({ text: category + i, category, weight: 1 })));
  const sample = changing => {
    const counts = { genre: 0, live: 0, dynamics: 0, mood: 0 };
    for (let i = 0; i < 10000; i++) counts[Selection.choose(pool, [], random, { changing }).category]++;
    return counts;
  };
  const stable = sample(false), changing = sample(true);
  // Selection now schedules by epistemic layer first (LanguageLayerPolicy), then by facet within
  // a layer — a single-item layer (here CONTEXT/"genre") gets its whole layer share, not a raw
  // per-item share, so it now draws well above a flat per-category split; "live" shares LIVE's
  // layer budget across 20 items instead of getting item-count-proportional priority.
  assert.ok(stable.genre > 1800 && stable.genre < 2500, `genre share drifted: ${stable.genre}`);
  // With no observationSeconds supplied this is the mature-listening band, where LIVE deliberately
  // falls to about 6% while FACT remains largest and deep interpretation has opened up.
  assert.ok(stable.live > 400 && stable.live < 900, `live share drifted: ${stable.live}`);
  assert.ok(changing.live + changing.dynamics > stable.live + stable.dynamics);
});

test("AI snapshot preserves measured values, deltas, chroma and window while stripping raw payloads", () => {
  const history = new E.FeatureHistory();
  for (let at = 0; at <= 22000; at += 500) history.update({ ...baseline, chroma: new Array(12).fill(0.2) }, at);
  const state = { ...profile(), expressionFeatures: history.current, analysisWindow: history.summary() };
  const snapshot = Snapshot.serialize(state);
  snapshot.measurements.pcm = [1, 2, 3];
  const cleaned = validateLanguageInput({ snapshot }).snapshot;
  assert.equal(cleaned.measurements.rms, baseline.rms);
  assert.equal(cleaned.measurements.deltaEnergy, 0);
  assert.equal(cleaned.measurements.chroma.length, 12);
  assert.equal(cleaned.measurements.pcm, undefined);
  assert.equal(cleaned.analysisWindow.windowSeconds, 22);
  assert.ok(JSON.stringify(cleaned).length < 12000);
});

test("AI waits for 20 seconds, but realtime words are already available", async () => {
  let calls = 0;
  const engine = new Pool.Engine({ stableDelayMs: 0, provider: { generate: async () => { calls++; return parseLanguageResponse(responseFixture()); } } });
  const history = new E.FeatureHistory();
  for (let at = 0; at <= 19500; at += 500) {
    const state = { ...profile(), expressionFeatures: history.update(baseline, at), analysisWindow: history.summary() };
    await engine.regenerate({ state, sessionId: 1, epoch: 1 });
    assert.ok(engine.snapshot().length);
  }
  assert.equal(calls, 0);
  const state = { ...profile(), expressionFeatures: history.update(baseline, 20000), analysisWindow: history.summary() };
  await engine.regenerate({ state, sessionId: 1, epoch: 1 });
  assert.equal(calls, 1);
});

test("in-flight AI and a rejected API request cannot freeze current words", async () => {
  let reject;
  const provider = { generate: () => new Promise((_, fail) => { reject = fail; }) };
  const engine = new Pool.Engine({ provider, stableDelayMs: 0 });
  const pending = engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.ok(engine.snapshot().some(x => x.text === "높은 음압"));
  await engine.regenerate({ state: profile("warm"), sessionId: 1, epoch: 1 });
  assert.ok(engine.snapshot().some(x => x.text === "낮은 음압"));
  assert.ok(!engine.snapshot().some(x => x.text === "높은 음압"));
  reject(new Error("offline"));
  await pending;
  assert.ok(engine.snapshot().some(x => x.text === "낮은 음압"));
});

test("late same-epoch responses are rechecked against the current quiet passage", async () => {
  let resolve;
  const engine = new Pool.Engine({ stableDelayMs: 0, provider: { generate: () => new Promise(done => { resolve = done; }) } });
  const pending = engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  await engine.regenerate({ state: profile("warm"), sessionId: 1, epoch: 1 });
  resolve(parseLanguageResponse(responseFixture()));
  await pending;
  assert.ok(!engine.snapshot().some(x => ["높은 음압", "격렬함"].includes(x.text)));
  assert.ok(engine.snapshot().some(x => x.text === "낮은 음압"));
  assert.ok(!engine.snapshot().some(x => x.category === "mood" && x.source !== "directAudio"),
    "a quiet local measurement must not be promoted into a local IMPRESSION");
});

test("responses older than 60 seconds cannot refresh enrichment or cache", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  let release;
  const engine = new Pool.Engine({ stableDelayMs: 0, minimumIntervalMs: 0,
    provider: { generate: () => new Promise(resolve => { release = resolve; }) } });
  const pending = engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  t.mock.timers.tick(61000);
  release(parseLanguageResponse(responseFixture()));
  await pending;
  assert.equal(engine.hasRemotePool, false);
  assert.equal(engine.cache.map.size, 0);
  assert.ok(engine.snapshot().length);
  assert.equal(engine.activeRequest, null);
});

test("usage memory stays bounded and provider errors remain inspectable during cooldown", async () => {
  const engine = new Pool.Engine({ stableDelayMs: 0, provider: { generate: async () => { throw new Error("network unavailable"); } } });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  await engine.regenerate({ state: profile(), sessionId: 1, epoch: 1 });
  assert.match(engine.state.error, /network unavailable/);
  for (let i = 0; i < 1000; i++) engine.noteUsed("word" + i);
  assert.ok(engine.used.size <= 96);
  assert.equal(engine.recent.length, 32);
});
