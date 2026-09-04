const path = require("path");
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createLanguageService, emptyTokenUsage, CALL_TUNING: CallTuning } = require("./lib/languageService");

require("dotenv").config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = "2026.09.05.song-language-diversity-v17";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "medium";
const MAX_OUTPUT_TOKENS = Math.max(256, Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) || 10000);
const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const LANGUAGE_MODEL = process.env.OPENAI_LANGUAGE_MODEL || MODEL;
const languageService = createLanguageService({
  client, model: LANGUAGE_MODEL,
  reasoningEffort: process.env.OPENAI_LANGUAGE_REASONING_EFFORT || "medium",
  onUsage: usage => recordUsage(usage)
});

app.use((req, res, next) => {
  // Enables SharedArrayBuffer on supporting browsers. `credentialless` keeps
  // public CDN assets usable; clients without isolation use transferable PCM.
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "credentialless");
  next();
});
app.use(cors());
app.use(express.json({ limit: "250kb" }));

const musicProfileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    genreProfile: {
      type: "object",
      additionalProperties: false,
      properties: {
        family: { type: "string" },
        primary: { type: "string" },
        secondary: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["name", "confidence"]
          }
        },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["family", "primary", "secondary", "confidence"]
    },
    instrumentationProfile: {
      type: "object",
      additionalProperties: false,
      properties: {
        prominent: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              family: {
                type: "string",
                enum: [
                  "voice",
                  "strings",
                  "woodwind",
                  "brass",
                  "keys",
                  "guitar",
                  "bass",
                  "percussion",
                  "electronic",
                  "folk",
                  "ensemble",
                  "unknown"
                ]
              },
              role: {
                type: "string",
                enum: ["lead", "solo", "bass", "rhythm", "harmony", "pad", "texture", "percussion", "ensemble"]
              },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["name", "family", "role", "confidence"]
          }
        },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["prominent", "confidence"]
    },
    moodProfile: {
      type: "object",
      additionalProperties: false,
      properties: {
        labels: {
          type: "array",
          minItems: 4,
          maxItems: 6,
          items: { type: "string" }
        },
        valence: { type: "number", minimum: 0, maximum: 1 },
        arousal: { type: "number", minimum: 0, maximum: 1 },
        tension: { type: "number", minimum: 0, maximum: 1 },
        warmth: { type: "number", minimum: 0, maximum: 1 },
        spaciousness: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["labels", "valence", "arousal", "tension", "warmth", "spaciousness"]
    },
    visualProfile: {
      type: "object",
      additionalProperties: false,
      properties: {
        primaryHue: { type: "number", minimum: 0, maximum: 360 },
        secondaryHue: { type: "number", minimum: 0, maximum: 360 },
        saturation: { type: "number", minimum: 0, maximum: 1 },
        brightness: { type: "number", minimum: 0, maximum: 1 },
        pulse: { type: "number", minimum: 0, maximum: 1 },
        turbulence: { type: "number", minimum: 0, maximum: 1 },
        density: { type: "number", minimum: 0, maximum: 1 }
      },
      required: [
        "primaryHue",
        "secondaryHue",
        "saturation",
        "brightness",
        "pulse",
        "turbulence",
        "density"
      ]
    },
    words: {
      type: "array",
      minItems: 8,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          category: {
            type: "string",
            enum: [
              "genre",
              "instrument",
              "technique",
              "harmony",
              "texture",
              "mood",
              "rhythm",
              "space",
              "color",
              "motion",
              "era"
            ]
          },
          weight: { type: "number", minimum: 0.05, maximum: 1 }
        },
        required: ["text", "category", "weight"]
      }
    },
    intensity: { type: "number", minimum: 0, maximum: 1 }
  },
  required: [
    "genreProfile",
    "instrumentationProfile",
    "moodProfile",
    "visualProfile",
    "words",
    "intensity"
  ]
};

const analysisInstructions = `
You are a specialist music-information-retrieval interpreter, ethnomusicology-aware genre analyst, and synesthetic art director.
Infer the CURRENT musical segment only from the supplied browser DSP measurements.

Quality rules:
- Treat BPM confidence, chroma focus and motion, transient density, sustain, temporal variance, spectral balance, MFCC and band energy together.
- instrumentationEvidence candidates are heuristic cues, not ground truth. Confirm them against the full DSP profile and lower confidence when cues conflict.
- Detect musical roles as well as sources: bass foundation or bassline, melodic lead or solo, chordal accompaniment, pad, rhythmic comping, drums and percussion, voice, and ensemble texture.
- Only call something a solo when melodic dominance, note motion, dynamics and arrangement sparsity support it. Prefer "piano/keys" or another instrument family when the exact source is uncertain.
- Evaluate genre without an electronic-music prior. Consider classical and contemporary classical, jazz, blues, gospel, soul, R&B, funk, disco, pop, rock, punk, metal, hip-hop, electronic and ambient, country, folk and bluegrass, reggae and dub, Latin traditions, African and Afro-diasporic traditions, Middle Eastern, South Asian, East Asian and other regional/traditional music, soundtrack, new age, experimental and hybrid forms.
- Build genre from hierarchy and evidence: broad family/tradition, primary genre, plausible subgenre alternatives, rhythmic language, harmonic language, instrumentation, production era and regional influence.
- Calibrate genre confidence. Prefer a correct parent genre over an unsupported microgenre, but provide specific subgenres when several independent cues agree.
- Secondary genres must be plausible alternatives or influences. Do the evidence comparison internally and return only their names and calibrated confidence.
- Mood coordinates describe perceived valence, arousal, tension, warmth and spaciousness from 0 to 1.
- Generate concise, literal music descriptions. Allow English genre names and ordinary Korean mood words. Prefer accurate rhythm, timbre, dynamics and mood labels; never invent poetic compounds or scenery.
- Cover multiple semantic categories, including instrument/technique/harmony when supported. Weight the most segment-specific words highest.
- Use the overall visual profile to agree with the segment; the browser derives per-word motion and color deterministically.
- Return only the compact schema fields. Do not output explanations, evidence prose, arrangement prose or a summary.

Calibration reference:
- Treat every individual DSP measurement as ambiguous. Raise confidence only when rhythm, harmonic focus or motion, spectral distribution, temporal variation, and timbral shape provide independent agreement.
- A stable pulse and transient grid can support dance, funk, rock, hip-hop, pop, or regional rhythmic traditions; distinguish them using syncopation, bass behavior, spectral texture, harmonic motion, and instrumentation candidates rather than BPM alone.
- High chroma focus suggests pitched organization, not a specific key, chord, instrument, or culture. Chroma motion can indicate harmonic or melodic activity; compare it with sustain, dynamics, and transient density.
- MFCC and spectral shape describe timbral envelopes. Use them to compare acoustic, electric, electronic, percussive, vocal-like, bright, dark, dense, or sparse character, but never claim an exact instrument from one coefficient family.
- Low-frequency share does not by itself imply electronic dance music. It can represent acoustic bass, drums, organ, orchestral weight, amplified instruments, or production balance.
- Use confidence above 0.85 only when several independent measurements strongly agree, 0.65 to 0.85 for a convincing parent genre with uncertain subtype, 0.45 to 0.65 for mixed or ambiguous evidence, and below 0.45 when the segment is sparse, transitional, noisy, or under-observed.
- Prefer stable parent categories and honest secondary alternatives to fragile microgenre guesses. Regional or traditional labels require combined rhythmic, timbral, harmonic, and instrumentation support.
`.trim();

const sessionUsage = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0
};
let lastAIError = null;

function recordUsage(usage) {
  if (usage) {
    const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
    sessionUsage.requests += 1;
    sessionUsage.inputTokens += inputTokens;
    sessionUsage.cachedInputTokens += Math.max(0, Number(usage.input_tokens_details?.cached_tokens) || 0);
    sessionUsage.cacheWriteTokens += Math.max(0, Number(usage.input_tokens_details?.cache_write_tokens) || 0);
    sessionUsage.outputTokens += outputTokens;
    sessionUsage.reasoningTokens += Math.max(0, Number(usage.output_tokens_details?.reasoning_tokens) || 0);
    sessionUsage.totalTokens += Math.max(0, Number(usage.total_tokens) || inputTokens + outputTokens);
  }
  return {
    ...sessionUsage,
    cacheHitRate: sessionUsage.inputTokens
      ? sessionUsage.cachedInputTokens / sessionUsage.inputTokens
      : 0
  };
}

function createMusicAnalysisRequest(featurePacket, maxOutputTokens = MAX_OUTPUT_TOKENS) {
  return {
    model: MODEL,
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: Math.max(256, Number(maxOutputTokens) || MAX_OUTPUT_TOKENS),
    store: false,
    prompt_cache_key: "music-shower-profile-v4",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: analysisInstructions,
            prompt_cache_breakpoint: { mode: "explicit" }
          }
        ]
      },
      {
        role: "user",
        content: `Analyze this normalized DSP snapshot:\n${JSON.stringify(featurePacket)}`
      }
    ],
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "music_synesthesia_profile_v4",
        strict: true,
        schema: musicProfileSchema
      }
    }
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Music Shower V2",
    buildVersion: BUILD_VERSION,
    coreMode: "local-audio-generative-language",
    language: { configured: Boolean(client), model: LANGUAGE_MODEL, minimumIntervalMs: 45000, ...languageService.state },
    llmTokenUsage: recordUsage(),
    llmOptional: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    lastAIError
  });
});

let languagePoolRequestSequence = 0;
app.post("/api/language-pool", async (req, res) => {
  res.set("X-Music-Shower-Build", BUILD_VERSION);
  const requestId = `lp-${++languagePoolRequestSequence}`;
  const startedAt = Date.now();
  const { semanticEpoch = null, reason = "unspecified", sessionId = null } = req.body || {};
  // Rough but useful: ~3.4 characters per token for this mixed Korean/English payload. Logged on
  // BOTH paths, because the size of the request is one of the first things to check when a call
  // fails, and the failure path is exactly where it used to be missing.
  const inputTokenEstimate = Math.round(JSON.stringify(req.body || {}).length / 3.4);
  try {
    const result = await languageService.generate(req.body);
    const meta = result.meta || {};
    console.log(`[language-pool] id=${requestId} epoch=${semanticEpoch} reason=${reason} callMode=${meta.callMode || "cache"} ` +
      `model=${meta.model || LANGUAGE_MODEL} inputTokenEstimate=${inputTokenEstimate} ` +
      `inputTokens=${meta.tokenUsage?.request?.inputTokens ?? 0} ` +
      `outputTokens=${meta.outputTokens ?? 0}/${meta.maxOutputTokens ?? 0} budgetUse=${(meta.budgetUse ?? 0).toFixed(2)} ` +
      `elapsedMs=${Date.now() - startedAt} candidates=${result.candidates?.length ?? 0} cache=${meta.cache || "miss"} status=ok`);
    // The token budget is only defensible if it is watched. Anything above 85% of the ceiling is
    // one busier response away from a truncated pool, so it is reported before it breaks.
    if ((meta.budgetUse ?? 0) >= 0.85)
      console.warn(`[language-pool] id=${requestId} budget pressure: outputTokens=${meta.outputTokens} of ${meta.maxOutputTokens} (${Math.round(meta.budgetUse * 100)}%)`);
    res.json(result);
  } catch (error) {
    // error.status is undefined for connection-level failures (timeout, DNS, abort) -- that used
    // to collapse into an undifferentiated, unlogged 502. Log the real cause here; never the key.
    const timedOut = Boolean(error.timedOut) || error.name === "APIConnectionTimeoutError" || /timed? ?out/i.test(String(error.message || ""));
    const schemaError = /schema|json|parse/i.test(String(error.message || "")) && !timedOut;
    const upstreamStatus = Number(error.status) || null;
    const status = upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : (timedOut ? 504 : 502);
    const code = error.code || (timedOut ? "language_provider_timeout" : schemaError ? "language_provider_schema_error" : "language_generation_failed");
    console.error(`[language-pool] id=${requestId} epoch=${semanticEpoch} reason=${reason} sessionId=${sessionId} ` +
      `model=${LANGUAGE_MODEL} inputTokenEstimate=${inputTokenEstimate} ` +
      `elapsedMs=${error.elapsedMs ?? (Date.now() - startedAt)} callMode=${error.callMode || "unknown"} ` +
      `upstreamStatus=${upstreamStatus ?? "none"} upstreamErrorType=${error.upstreamErrorType || error.name || "Error"} ` +
      `timedOut=${timedOut} schemaError=${schemaError} code=${code} message=${String(error.message || "").slice(0, 200)}`);
    res.status(status).json({
      error: code.toUpperCase(), code,
      message: status === 400 || status === 503 || status === 429
        ? error.message : "Language generation unavailable; local playback continues.",
      retryable: status !== 400 && code !== "language_not_configured",
      meta: { tokenUsage: {
        request: emptyTokenUsage(),
        languageSession: { ...languageService.state.tokenUsage },
        projectSession: recordUsage()
      } }
    });
  }
});

app.post("/api/music-analysis", async (req, res) => {
  try {
    const { featurePacket } = req.body || {};
    if (!featurePacket?.audio || !featurePacket?.rhythm) {
      return res.status(400).json({ error: "A complete featurePacket is required." });
    }
    if (!client) {
      return res.status(503).json({ error: "Optional OpenAI enrichment is not configured." });
    }

    const startedAt = Date.now();
    const response = await client.responses.create(createMusicAnalysisRequest(featurePacket));

    if (response.status !== "completed" || !response.output_text) {
      const reason = response.incomplete_details?.reason || response.error?.code || "unknown";
      const incompleteError = new Error(`Model response was ${response.status || "empty"} (${reason}).`);
      incompleteError.status = 502;
      incompleteError.code = `response_${response.status || "empty"}_${reason}`;
      incompleteError.usage = response.usage || null;
      throw incompleteError;
    }

    const profile = JSON.parse(response.output_text);
    const accumulatedUsage = recordUsage(response.usage);
    lastAIError = null;
    res.set("X-Music-Shower-Build", BUILD_VERSION);
    res.json({
      profile,
      meta: {
        model: response.model || MODEL,
        reasoningEffort: REASONING_EFFORT,
        latencyMs: Date.now() - startedAt,
        usage: response.usage || null,
        sessionUsage: accumulatedUsage
      }
    });
  } catch (error) {
    console.error("[AI ERROR]", error);
    const upstreamStatus = Number(error.status) || 500;
    lastAIError = {
      at: new Date().toISOString(),
      status: upstreamStatus,
      message: error.message,
      code: error.code || error.error?.code || null,
      param: error.param || error.error?.param || null,
      type: error.type || error.error?.type || null,
      usage: error.usage || null
    };
    res.set("X-Music-Shower-Build", BUILD_VERSION);
    res.status(upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500).json({
      error: "AI analysis failed.",
      buildVersion: BUILD_VERSION,
      message: error.message,
      code: error.code || error.error?.code || null,
      param: error.param || error.error?.param || null,
      type: error.type || error.error?.type || null,
      usage: error.usage || null
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(express.static(__dirname));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Music Synesthesia running at http://localhost:${PORT}`);
    console.log(`AI configured: ${Boolean(process.env.OPENAI_API_KEY)}`);
    console.log(`AI model: ${MODEL} (${REASONING_EFFORT})`);
    console.log(`AI max output tokens: ${MAX_OUTPUT_TOKENS}`);
    console.log(`Language pool model: ${LANGUAGE_MODEL} | fast=${JSON.stringify(CallTuning.fast)} deep=${JSON.stringify(CallTuning.deep)}`);
    console.log(`Build: ${BUILD_VERSION}`);
  });
}

module.exports = { app, createMusicAnalysisRequest, musicProfileSchema, BUILD_VERSION };
