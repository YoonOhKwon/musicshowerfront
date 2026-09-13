"use strict";

// English surfaces for the realtime word pool. Flamingo concepts already arrive in English and
// genre labels are written in Latin script, so only Korean-authored phrases (local lexicon,
// expression engine, composed phrases) need translating. The cache is shared by every session:
// local vocabulary is finite, so after a few songs almost every phrase is a cache hit.

const HANGUL = /[가-힣]/;
const BATCH_SIZE = 24;
const CACHE_LIMIT = 4000;
const MAX_ENGLISH_CHARS = 60;
const MAX_ENGLISH_WORDS = 8;

function buildEnglishSurfacePrompt(batch = []) {
  return `You are Music Shower's English surface-language specialist. Each item is a short Korean music phrase that is shown to listeners as a floating word while a song plays. Its layer is FACT (audible observation), LIVE (what is happening now), CONTEXT (genre, scene, era), AESTHETIC (sensory concept), or IMPRESSION (subjective feeling).

For every item return one natural English phrase:
- 1-6 words, no trailing period, lowercase except proper nouns and genre or scene names.
- Keep the exact musical meaning, scope, and register of the Korean. Use standard English music terminology for technical terms.
- Add no mood, imagery, cause, or musical claim that the Korean phrase does not already contain. Do not explain.
- Keep genre, artist, and scene names in their usual English spelling.
Return exactly one JSON object shaped as {"items":[{"id":"t0","en":"..."}]} and copy every input id exactly.

Input items:
${JSON.stringify(batch.map(({ id, text, layer }) => ({ id, text, layer })))}`;
}

function cleanEnglishSurface(value) {
  const text = String(value || "").replace(/\s+/g, " ").replace(/^["'“”‘’]+|["'“”‘’.。]+$/g, "").trim();
  if (!text || HANGUL.test(text) || text.length > MAX_ENGLISH_CHARS) return "";
  if (text.split(" ").length > MAX_ENGLISH_WORDS) return "";
  return text;
}

function parseEnglishSurfaceBatch(content, batch = []) {
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  const byId = new Map(batch.map(item => [item.id, item]));
  const output = new Map();
  for (const result of Array.isArray(parsed?.items) ? parsed.items : []) {
    const item = byId.get(String(result?.id || ""));
    const english = cleanEnglishSurface(result?.en ?? result?.english ?? result?.text);
    if (item && english) output.set(item.text, english);
  }
  return output;
}

// Latin-script text is already its own English surface; Flamingo words fall back to their
// English source concept. Returns undefined when only a translation can supply it.
function directEnglishSurface(token = {}) {
  const text = String(token.text || "");
  if (text && !HANGUL.test(text)) return text;
  const canonical = String(token.canonicalText || "");
  if (token.sourceFamily === "directAudio" && canonical && !HANGUL.test(canonical)) return canonical;
  return undefined;
}

function createEnglishSurfaceTranslator({ client = null, model = "", cache = new Map(), cacheLimit = CACHE_LIMIT } = {}) {
  const remember = (text, english) => {
    cache.delete(text);
    cache.set(text, english);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  };

  async function translate({ items = [] } = {}, signal) {
    const unique = new Map();
    for (const item of items) {
      const text = String(item?.text || "").replace(/\s+/g, " ").trim();
      if (text && HANGUL.test(text) && !unique.has(text)) unique.set(text, { text, layer: String(item.layer || "FACT") });
    }
    const pending = [...unique.values()].filter(item => !cache.has(item.text));
    const failures = [];
    if (client && pending.length) {
      const batches = [];
      for (let index = 0; index < pending.length; index += BATCH_SIZE) {
        batches.push(pending.slice(index, index + BATCH_SIZE).map((item, offset) => ({ ...item, id: `t${offset}` })));
      }
      const results = await Promise.allSettled(batches.map(async batch => {
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: buildEnglishSurfacePrompt(batch) }],
          response_format: { type: "json_object" },
          max_completion_tokens: 1200
        }, { signal, timeout: 45000, maxRetries: 0 });
        const content = response.choices?.[0]?.message?.content;
        if (!content) throw new Error("empty English surface response");
        return parseEnglishSurfaceBatch(content, batch);
      }));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          for (const [text, english] of result.value) remember(text, english);
        } else {
          failures.push({ batchSize: batches[index].length,
            message: String(result.reason?.message || result.reason || "unknown error").slice(0, 160) });
        }
      });
    }
    const translations = {};
    for (const text of unique.keys()) if (cache.has(text)) translations[text] = cache.get(text);
    return { translations, failures };
  }

  return { translate, cache };
}

module.exports = { buildEnglishSurfacePrompt, parseEnglishSurfaceBatch, cleanEnglishSurface,
  directEnglishSurface, createEnglishSurfaceTranslator };
