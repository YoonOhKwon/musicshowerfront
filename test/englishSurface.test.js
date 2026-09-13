"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RealtimeMusicSession } = require("../lib/realtimeMusicSession");
const Surface = require("../lib/englishSurface");

const tone = (seconds = 1) => Float32Array.from({ length: 16000 * seconds }, (_, i) =>
  0.2 * Math.sin(i * 2 * Math.PI * 440 / 16000));
const settle = () => new Promise(resolve => setImmediate(resolve));

test("English surfaces come from Latin text or the Flamingo source before any translation", () => {
  assert.equal(Surface.directEnglishSurface({ text: "Vaporwave" }), "Vaporwave");
  assert.equal(Surface.directEnglishSurface({ text: "다공성 심야 유리", canonicalText: "porous midnight glass",
    sourceFamily: "directAudio" }), "porous midnight glass");
  assert.equal(Surface.directEnglishSurface({ text: "저역 감소", canonicalText: "저역 감소" }), undefined);
});

test("translation responses are matched by id and rejected when not short English", () => {
  const batch = [{ id: "t0", text: "저역 감소" }, { id: "t1", text: "성긴 반주층" }, { id: "t2", text: "신스" }];
  const parsed = Surface.parseEnglishSurfaceBatch(JSON.stringify({ items: [
    { id: "t0", en: "reduced low end." },
    { id: "t1", en: "여전히 한국어" },
    { id: "t2", en: "a very long explanation of what a synthesizer is and why it matters here" },
    { id: "t9", en: "unknown id" }
  ] }), batch);
  assert.deepEqual([...parsed], [["저역 감소", "reduced low end"]]);
  const prompt = Surface.buildEnglishSurfacePrompt(batch);
  assert.match(prompt, /"id":"t0","text":"저역 감소"/);
  assert.match(prompt, /Add no mood, imagery, cause, or musical claim/);
});

test("the shared translator only calls the model for uncached Korean phrases", async () => {
  const calls = [];
  const client = { chat: { completions: { create: async request => {
    calls.push(request);
    const items = JSON.parse(request.messages[0].content.split("Input items:\n")[1]);
    return { choices: [{ message: { content: JSON.stringify({ items: items.map(item => ({ id: item.id, en: `en ${item.text.length}` })) }) } }] };
  } } } };
  const { translate } = Surface.createEnglishSurfaceTranslator({ client, model: "test" });
  const first = await translate({ items: [{ text: "저역 감소" }, { text: "Vaporwave" }, { text: "저역 감소" }] });
  assert.deepEqual(first.translations, { "저역 감소": "en 5" });
  const second = await translate({ items: [{ text: "저역 감소" }] });
  assert.deepEqual(second.translations, { "저역 감소": "en 5" });
  assert.equal(calls.length, 1);
});

function create(translate) {
  const messages = [], translated = [];
  const session = new RealtimeMusicSession({ streamId: "session-en", send: message => messages.push(message),
    analyze: async () => ({ structuredPacket: { aestheticConcepts: [{ text: "porous midnight glass", confidence: 0.8 }] },
      observationId: "capture-en" }),
    realize: async () => ({ realizationItems: [{ text: "porous midnight glass", category: "association",
      family: ["다공성 심야 유리"] }] }),
    translate: async ({ items }) => {
      translated.push(items.map(item => item.text));
      return translate(items);
    } });
  session.start();
  return { session, messages, translated };
}

test("Korean mode never requests translations; English mode fills textEn for every token", async t => {
  const { session, messages, translated } = create(items =>
    ({ translations: Object.fromEntries(items.map(item => [item.text, `english for ${item.text.length}`])) }));
  t.after(() => session.close());
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  assert.equal(translated.length, 0);

  session.setWordLanguage("en");
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(translated.length, 1);
  assert.equal(translated[0].includes("다공성 심야 유리"), false, "Flamingo words use their English source");
  const tokens = messages.filter(message => message.type === "word_pool").at(-1).tokens;
  assert.ok(tokens.length);
  assert.ok(tokens.every(token => token.textEn), JSON.stringify(tokens.filter(token => !token.textEn)));
  assert.equal(tokens.find(token => token.text === "다공성 심야 유리").textEn, "porous midnight glass");
});

test("a failed translation is not retried on every publish", async t => {
  const { session, translated } = create(() => { throw new Error("offline"); });
  t.after(() => session.close());
  session.setWordLanguage("en");
  for (let i = 0; i < 13; i++) { session.push(tone()); await settle(); }
  await settle();
  assert.equal(translated.length, 1);
  assert.ok(session.englishRetryAt > Date.now());
});
