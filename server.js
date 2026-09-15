const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer, WebSocket } = require("ws");
const { RealtimeMusicSession } = require("./lib/realtimeMusicSession");
const { analyzeStreamAudio } = require("./lib/streamDeepAnalysis");
const { inferStreamModels } = require("./lib/streamModelService");
const { createEnglishSurfaceTranslator } = require("./lib/englishSurface");
const { createGroundedAssociator } = require("./lib/groundedAssociation");
const { createUsageLedger } = require("./lib/usageLedger");
const { createLlmProviders } = require("./lib/llmProviders");
const { createLanguageService, emptyTokenUsage, CALL_TUNING: CallTuning } = require("./lib/languageService");
const DirectAudioReview = require("./lib/directAudioReview");
const DirectAudioRealizer = require("./lib/directAudioRealizer");
const GenreAdvisory = require("./js/semantic/genreAdvisory");
const GenreLabels = require("./js/semantic/genreLabelShape");

require("dotenv").config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_VERSION = "2026.09.13.token-mode-v37";
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "medium";
const MAX_OUTPUT_TOKENS = Math.max(256, Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) || 10000);
const LANGUAGE_MODEL = process.env.OPENAI_LANGUAGE_MODEL || MODEL;
const CACHE_DIR = process.env.NODE_TEST_CONTEXT ? null : path.join(__dirname, ".cache");
// Token (API) mode can be answered by OpenAI (paid) or Gemini (free tier). The client chooses per
// audio connection; HTTP endpoints accept an llmProvider field. Keys never leave the server.
const llmProviders = createLlmProviders({ cacheDir: CACHE_DIR, openaiModel: LANGUAGE_MODEL });
// Every language-model call is written to the usage ledger (llm-usage.jsonl) tagged with its
// purpose and provider.
const usageLedger = createUsageLedger();
// Translations do not depend on the provider, so both providers share one cache.
const englishSurfaceCache = new Map();

function createProviderServices(id) {
  const provider = llmProviders.get(id);
  const client = provider.client;
  const model = id === "openai" ? LANGUAGE_MODEL : provider.models[0];
  return {
    id, client, model,
    clientFor: purpose => usageLedger.clientFor(client, purpose, id),
    englishSurfaces: createEnglishSurfaceTranslator({ client: usageLedger.clientFor(client, "english-surface", id),
      model, cache: englishSurfaceCache, cacheFile: CACHE_DIR ? path.join(CACHE_DIR, "english-surfaces.json") : null }),
    groundedAssociations: createGroundedAssociator({ client: usageLedger.clientFor(client, "grounded-association", id), model }),
    realizationClient: usageLedger.clientFor(client, "korean-realization", id),
    languageService: createLanguageService({
      client: usageLedger.clientFor(client, "language-pool", id), model,
      reasoningEffort: process.env.OPENAI_LANGUAGE_REASONING_EFFORT || "medium",
      onUsage: usage => recordUsage(usage)
    })
  };
}
const providerServices = Object.fromEntries(llmProviders.ids.map(id => [id, createProviderServices(id)]));
const servicesFor = id => providerServices[llmProviders.resolve(id)];
const requestProvider = req => req.body?.llmProvider || req.query?.llmProvider || req.get?.("x-llm-provider");
const languageService = servicesFor(llmProviders.defaultId).languageService;

app.use((req, res, next) => {
  // Enables SharedArrayBuffer on supporting browsers. `credentialless` keeps
  // public CDN assets usable; clients without isolation use transferable PCM.
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "credentialless");
  next();
});
app.use(cors());
app.use(express.json({ limit: "250kb" }));

const LIVE_WORD_LAYERS = new Set(["LIVE", "FACT", "CONTEXT", "AESTHETIC", "IMPRESSION"]);
const LIVE_WORD_TYPES = new Set(["single", "fragment", "nominal", "micro"]);
let liveWordPool = {
  revision: 0,
  updatedAt: null,
  sessionId: null,
  semanticEpoch: 0,
  trackEpoch: 0,
  tokens: []
};
let liveWordPoolSignature = "[]";

function normalizeLiveWordToken(item) {
  if (!item || typeof item !== "object") return null;
  const text = String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!text) return null;

  const requestedLayer = String(item.layer || "FACT").toUpperCase();
  const requestedType = String(item.type || (text.length > 20 ? "micro" : "fragment")).toLowerCase();
  const token = {
    text,
    layer: LIVE_WORD_LAYERS.has(requestedLayer) ? requestedLayer : "FACT",
    type: LIVE_WORD_TYPES.has(requestedType) ? requestedType : "fragment"
  };
  if (Number.isFinite(Number(item.glow))) token.glow = Math.max(0.1, Math.min(4, Number(item.glow)));
  return token;
}

function updateLiveWordPool({ tokens: inputTokens, sessionId = null, semanticEpoch = 0, trackEpoch = 0 } = {}) {
  const tokens = (Array.isArray(inputTokens) ? inputTokens : [])
    .map(normalizeLiveWordToken)
    .filter(Boolean)
    .slice(0, 100);
  const signature = JSON.stringify(tokens);
  const revision = signature === liveWordPoolSignature
    ? liveWordPool.revision
    : liveWordPool.revision + 1;
  liveWordPoolSignature = signature;
  liveWordPool = {
    revision,
    updatedAt: Date.now(),
    sessionId,
    semanticEpoch: Number(semanticEpoch) || 0,
    trackEpoch: Number(trackEpoch) || 0,
    tokens
  };
  return liveWordPool;
}

app.post("/api/live-word-pool", (req, res) => {
  updateLiveWordPool(req.body || {});
  res.json({ ok: true, ...liveWordPool });
});

app.get("/api/live-word-pool", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(liveWordPool);
});

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
    language: { configured: llmProviders.isConfigured(llmProviders.defaultId), model: servicesFor(llmProviders.defaultId).model,
      minimumIntervalMs: 45000, ...languageService.state },
    llmProviders: llmProviders.describe(),
    defaultLlmProvider: llmProviders.defaultId,
    soundCloud: { configured: true, mode: "browser-tab-audio-websocket", credentialsRequired: false },
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
    const result = await servicesFor(requestProvider(req)).languageService.generate(req.body);
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

// Periodic direct-audio (Music Flamingo) capture, called from js/main.js every ~30s of
// listening. A caption never becomes a display-ready word here: reviewCaption() classifies each
// sentence (musical/cultural-or-historical/impression) and toObservations() turns the
// structured or open-world claims into candidate-shaped observations at reduced, source-differentiated
// confidence (lib/directAudioReview.js) -- js/main.js feeds those into
// applyDirectAudioObservations(), which joins the SAME evidence-fusion/temporal-stability pipeline
// every other source goes through (js/semantic/semanticEngine.js's updateTemporalEvidence()). The
// full `review` is still returned alongside `observations` for transparency/debugging, not as a
// separate approval gate.
const activeDeepAnalyses = new Map();

function notifyFlamingoCancellation({ requestId, sessionId, trackEpoch }) {
  // Fire-and-forget: the Python server handles this on a separate lightweight thread and its
  // generation stopping criterion releases stale KV/activation memory at the next token.
  fetch("http://localhost:5005/cancel", {
    method: "POST",
    headers: {
      "Content-Length": "0",
      "X-Music-Shower-Request-Id": requestId || "",
      "X-Music-Shower-Session": sessionId || "",
      "X-Music-Shower-Track-Epoch": String(trackEpoch ?? "")
    }
  }).catch(() => { /* the main request path reports server availability */ });
}

app.post("/api/deep-analysis", express.raw({ type: "audio/wav", limit: "30mb" }), async (req, res) => {
  let requestState = null;
  let deepAnalysisTimeout = null;
  try {
    const receivedBytes = req.body.length;
    let audioPayload = trimPcmWavToLastSeconds(req.body, 30);
    const trimNote = audioPayload.length < receivedBytes
      ? `, trimmed to latest 30s (${audioPayload.length} bytes)` : "";
    // If an old client sent an oversized clip, do not retain both the original Express body and
    // its trimmed copy for the full duration of a slow model generation.
    req.body = null;
    console.log(`[deep-analysis] received ${receivedBytes} bytes${trimNote}, forwarding to Flamingo server (localhost:5005)...`);
    const audioSha256 = crypto.createHash("sha256").update(audioPayload).digest("hex");
    const observationId = `flam-${audioSha256.slice(0, 10)}-${Date.now()}`;
    const sessionId = String(req.get("X-Music-Shower-Session") || "").slice(0, 40) || null;
    const segmentId = String(req.get("X-Music-Shower-Segment") || "").slice(0, 40) || observationId;
    const trackEpoch = Number(req.get("X-Music-Shower-Track-Epoch") || 0);
    const requestId = String(req.get("X-Music-Shower-Request-Id") || observationId);
    const activeAudioMs = Math.max(0, Number(req.get("X-Music-Shower-Active-Ms")) || 0);
    // Only the one value is forwarded; anything else is ignored rather than passed through.
    const listenDepth = req.get("X-Music-Shower-Listen-Depth") === "first-impression"
      ? "first-impression" : "";
    // Word-pool generation is always blind. Local genre evidence is used only by the separate
    // post-generation /api/compose-genre adjudicator below.

    activeDeepAnalyses.get(sessionId)?.cancel("superseded");
    const upstreamController = new AbortController();
    let completed = false;
    let cancellationSent = false;
    const cancel = (reason = "cancelled") => {
      if (completed || cancellationSent) return;
      cancellationSent = true;
      if (requestState) requestState.cancelReason = reason;
      upstreamController.abort();
      notifyFlamingoCancellation({ requestId, sessionId, trackEpoch });
    };
    requestState = { requestId, sessionId, cancel, cancelReason: null };
    activeDeepAnalyses.set(sessionId, requestState);
    res.once("close", () => {
      if (!completed) cancel("browser-disconnected");
    });
    deepAnalysisTimeout = setTimeout(() => cancel("timeout"), 5 * 60 * 1000);

    const flamingoHeaders = {
      "Content-Type": "audio/wav", "Content-Length": audioPayload.length,
      "X-Music-Shower-Session": sessionId || "",
      "X-Music-Shower-Segment": segmentId,
      "X-Music-Shower-Track-Epoch": String(trackEpoch),
      "X-Music-Shower-Request-Id": requestId,
      "X-Music-Shower-Active-Ms": String(Math.round(activeAudioMs))
    };
    if (listenDepth) flamingoHeaders["X-Music-Shower-Listen-Depth"] = listenDepth;
    const flamingoRes = await fetch("http://localhost:5005/analyze", {
      method: "POST",
      headers: flamingoHeaders,
      body: audioPayload,
      signal: upstreamController.signal
    });
    clearTimeout(deepAnalysisTimeout);
    deepAnalysisTimeout = null;
    audioPayload = null;
    if (!flamingoRes.ok) throw new Error("Flamingo server error: " + await flamingoRes.text());
    const flamingoData = await flamingoRes.json();
    const caption = flamingoData.caption || "";
    const structuredPacket = flamingoData.structuredPacket || null;
    const review = DirectAudioReview.reviewCaption({ caption, structuredPacket, provider: "music-flamingo",
      audioSha256, observationId, audioSegmentId: segmentId, sessionId, activeAudioMs, trackEpoch, requestId,
      continuity: flamingoData.continuity || null }, {});
    const observations = DirectAudioReview.toObservations(review, { trackEpoch, requestId });
    console.log(`[deep-analysis] id=${observationId} caption received (${caption.length} chars), ${observations.length} observation(s) extracted`);
    completed = true;
    res.json({ ...review, observations, observationId, sessionId, segmentId, trackEpoch, requestId, activeAudioMs });
  } catch (error) {
    const cancelled = error.name === "AbortError" || Boolean(requestState?.cancelReason);
    if (cancelled) {
      console.log(`[deep-analysis cancelled] id=${requestState?.requestId || "unknown"} reason=${requestState?.cancelReason || "aborted"}`);
    } else {
      console.error("[deep-analysis error] (is flamingo_server.py running on :5005?)", error.message);
    }
    if (!res.headersSent && !res.destroyed) {
      res.status(cancelled ? 409 : 500).json(cancelled
        ? { error: "Deep Listen request cancelled.", reason: requestState?.cancelReason || "aborted" }
        : { error: error.message });
    }
  } finally {
    if (deepAnalysisTimeout) clearTimeout(deepAnalysisTimeout);
    if (requestState && activeDeepAnalyses.get(requestState.sessionId) === requestState) {
      activeDeepAnalyses.delete(requestState.sessionId);
    }
  }
});

// Every batch repeats the whole realization prompt, so a capture split into 4-5 batches of five paid
// for that prompt 4-5 times (llm-usage.jsonl, 2026-09-13). Twelve concepts per batch keeps one or two
// calls per capture and still leaves room in the completion budget below.
const REALIZATION_BATCH_SIZE = 12;

// The browser normally sends a canonical mono PCM WAV, but a stale tab from an older build can
// still upload minutes of accumulated audio. Music Flamingo only consumes 30 seconds and would
// otherwise keep hearing the stale beginning. Parse ordinary PCM WAV chunks and retain the latest
// 30 seconds at the server boundary; unknown/non-PCM payloads pass through unchanged.
function trimPcmWavToLastSeconds(input, maxSeconds = 30) {
  if (!Buffer.isBuffer(input) || input.length < 44 || input.toString("ascii", 0, 4) !== "RIFF" ||
      input.toString("ascii", 8, 12) !== "WAVE") return input;
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= input.length) {
    const id = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const payloadAt = offset + 8;
    if (payloadAt + size > input.length) return input;
    if (id === "fmt " && size >= 16) {
      format = {
        encoding: input.readUInt16LE(payloadAt),
        channels: input.readUInt16LE(payloadAt + 2),
        sampleRate: input.readUInt32LE(payloadAt + 4),
        blockAlign: input.readUInt16LE(payloadAt + 12),
        bitsPerSample: input.readUInt16LE(payloadAt + 14)
      };
    } else if (id === "data") {
      data = { headerAt: offset, payloadAt, size };
      break;
    }
    offset = payloadAt + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || !format.sampleRate || !format.blockAlign ||
      ![8, 16, 24, 32].includes(format.bitsPerSample) || format.channels < 1) return input;
  const sampleFrames = Math.max(1, Math.floor(format.sampleRate * Math.max(1, Number(maxSeconds) || 30)));
  const maxDataBytes = sampleFrames * format.blockAlign;
  if (data.size <= maxDataBytes) return input;
  const output = Buffer.allocUnsafe(data.payloadAt + maxDataBytes);
  input.copy(output, 0, 0, data.payloadAt);
  input.copy(output, data.payloadAt, data.payloadAt + data.size - maxDataBytes, data.payloadAt + data.size);
  output.writeUInt32LE(maxDataBytes, data.headerAt + 4);
  output.writeUInt32LE(output.length - 8, 4);
  return output;
}

function normalizedRealizationConcepts(concepts = []) {
  const seen = new Set();
  const normalized = [];
  for (const source of concepts) {
    const text = String(typeof source === "string" ? source : source?.text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text) continue;
    const category = String(typeof source === "object" ? source?.category || "association" : "association").toLowerCase();
    const layer = String(typeof source === "object" ? source?.layer || "" : "").toUpperCase() ||
      (["rhythm", "instrumentation", "performance", "arrangement", "production", "dynamics", "live"].includes(category) ? "FACT"
        : ["scene", "era", "culture", "lineage", "genre"].includes(category) ? "CONTEXT"
          : category === "mood" ? "IMPRESSION" : "AESTHETIC");
    const key = `${category}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ id: `c${normalized.length}`, text, category, layer });
  }
  return normalized.slice(0, 40);
}

// Layers share one request: each item carries its layer and the prompt states every present layer's
// policy. Splitting by layer cost ~4 calls per capture even at twelve concepts per batch, because a
// capture spans FACT, CONTEXT, AESTHETIC and IMPRESSION (llm-usage.jsonl, 2026-09-13). Items stay
// ordered by layer so a batch boundary rarely splits one.
function realizationBatches(concepts = [], size = REALIZATION_BATCH_SIZE) {
  const order = ["FACT", "LIVE", "CONTEXT", "AESTHETIC", "IMPRESSION"];
  const rank = layer => (order.indexOf(layer) + 1) || order.length + 1;
  const sorted = [...concepts].sort((a, b) => rank(a.layer) - rank(b.layer));
  const batches = [];
  for (let i = 0; i < sorted.length; i += size) batches.push(sorted.slice(i, i + size));
  return batches;
}

function fastRealizerMode(category) {
  if (category === "association") return "aesthetic";
  if (category === "mood") return "impression";
  if (["scene", "era", "culture", "lineage"].includes(category)) return "context";
  return category;
}

const REALIZATION_LAYER_POLICIES = {
  FACT: "Translate the audible claim precisely with standard Korean music terminology. Preserve every technical meaning; add no metaphor, mood, cause, or unheard detail.",
  CONTEXT: "Render it as a concise, qualified style/scene/era association. Do not turn a hypothesis into a proven origin, date, or authorship claim.",
  IMPRESSION: "Render the Music Flamingo impression faithfully as concise subjective Korean. Preserve its nuance without adding a new emotion, image, story, or musical claim.",
  AESTHETIC: "Render the Music Flamingo aesthetic concept faithfully as concise Korean. Preserve its scope without adding a new aesthetic label, scene, image, story, or musical claim."
};
const realizationPolicyLayer = layer => layer === "LIVE" ? "FACT" : REALIZATION_LAYER_POLICIES[layer] ? layer : "AESTHETIC";

function buildRealizationPrompt(batch = []) {
  const layers = [...new Set(batch.map(item => realizationPolicyLayer(item.layer)))];
  const policies = (layers.length ? layers : ["AESTHETIC"]).map(layer => `- ${layer}: ${REALIZATION_LAYER_POLICIES[layer]}`).join("\n");
  return `You are Music Shower's Korean surface-language specialist. These concepts were produced by Music Flamingo after directly listening to audio.
Each item has a layer. Apply that layer's policy to that item only; never carry the freedom of one layer into another.
Layer policies:
${policies}

For every input item:
- Produce 3 to 6 natural Korean alternatives, normally 2-10 words each.
- Preserve every semantic atom in the source: subject/instrument, modifier, metre, relation, contrast, and mix position when present.
- Never collapse a multi-part observation into one generic head noun (for example, a balanced drums-and-synths mix cannot become only "synth").
- Keep alternatives genuinely distinct by varying Korean syntax and emphasis while preserving exactly the concept supplied by Music Flamingo.
- Do not emit raw English-only phrases, JSON commentary, analysis, confidence, or reasoning.
- Return exactly one JSON object shaped as {"items":[{"id":"c0","phrases":["...","..."]}]}.
- Copy each input id exactly. Do not use the source text as a JSON key.

Input items:
${JSON.stringify(batch.map(({ id, text, category, layer }) => ({ id, layer: realizationPolicyLayer(layer), text, category })))}`;
}

function realizationSurfaceUnits(value) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
  const units = new Set();
  for (let index = 0; index < compact.length - 1; index++) units.add(compact.slice(index, index + 2));
  return units;
}

function realizationSurfaceSimilarity(left, right) {
  const a = realizationSurfaceUnits(left), b = realizationSurfaceUnits(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const unit of a) if (b.has(unit)) shared += 1;
  return shared / Math.max(1, new Set([...a, ...b]).size);
}

function realizationSurfaceSkeleton(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // A genitive particle does not create a genuinely different screen expression:
    // "깊은 밤의 공기" and "깊은 밤 공기" should occupy one rotation slot.
    .map(token => token.length > 1 && token.endsWith("의") ? token.slice(0, -1) : token)
    .filter(Boolean)
    .join("");
}

function distinctRealizationFamily(values = [], limit = 6) {
  const family = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const phrase = value.replace(/\s+/g, " ").trim();
    if (!phrase || phrase.length > 60 || !/[가-힣]/.test(phrase) || /[{}\[\]\r\n]/.test(phrase)) continue;
    const skeleton = realizationSurfaceSkeleton(phrase);
    if (family.some(existing => realizationSurfaceSkeleton(existing) === skeleton ||
        realizationSurfaceSimilarity(existing, phrase) >= 0.68)) continue;
    family.push(phrase);
    if (family.length >= limit) break;
  }
  return family;
}

function parseRealizationBatch(content, batch = []) {
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  const byId = new Map(batch.map(item => [item.id, item]));
  const output = [];
  const accept = (item, values) => {
    if (!item || !Array.isArray(values)) return;
    const family = distinctRealizationFamily(values, 6);
    if (family.length) output.push({ text: item.text, category: item.category, layer: item.layer, family });
  };
  if (Array.isArray(parsed?.items)) {
    for (const result of parsed.items) accept(byId.get(String(result?.id || "")), result?.phrases || result?.family);
  } else if (parsed && typeof parsed === "object") {
    for (const item of batch) accept(item, parsed[item.id] || parsed[item.text]);
  }
  return output;
}

// Current reasoning-capable Chat Completions models reject the legacy `max_tokens` field and
// explicitly require `max_completion_tokens`. Keep this in one exported helper so both direct
// audio realization and open-world expansion cannot silently drift back to the incompatible
// request shape.
function chatCompletionBudget(maxCompletionTokens) {
  return { max_completion_tokens: Math.max(1, Math.round(Number(maxCompletionTokens) || 1)) };
}

// Asynchronous LLM realization endpoint that converts Flamingo concepts into rich Korean
// concept families while BYPASSING the ~45s regular language pool cooldown.
async function realizeDirectAudio({ concepts = [], sessionId = null, trackEpoch = 0, provider = null } = {}, signal) {
    const services = servicesFor(provider);
    if (!Array.isArray(concepts) || !concepts.length) {
      return { realizations: {}, realizationItems: [], failures: [], trackEpoch };
    }

    const normalized = normalizedRealizationConcepts(concepts);
    const realizations = {};
    const realizedByKey = new Map();

    // First, pass through fast zero-latency dictionary / rule realizer
    for (const item of normalized) {
      const fastFamily = DirectAudioRealizer.realize(item.text, fastRealizerMode(item.category));
      if (fastFamily && fastFamily.length) {
        realizedByKey.set(item.id, { ...item, family: fastFamily });
      }
    }

    // Keep each response comfortably inside its budget. Layer grouping also lets FACT translation
    // stay literal while AESTHETIC/IMPRESSION wording remains deliberately expressive.
    const failures = [];
    if (services.client && normalized.length > 0) {
      const batches = realizationBatches(normalized);
      const results = await Promise.allSettled(batches.map(async batch => {
        const response = await services.realizationClient.chat.completions.create({
          model: services.model,
          messages: [{ role: "user", content: buildRealizationPrompt(batch) }],
          response_format: { type: "json_object" },
          // 12 concepts x up to 6 Korean phrases each, plus JSON scaffolding and a little reasoning.
          // At the default effort 47% of this purpose's output tokens were reasoning.
          reasoning_effort: "low",
          ...chatCompletionBudget(2600)
        }, { signal, timeout: 45000, maxRetries: 0 });
        const content = response.choices?.[0]?.message?.content;
        if (!content) throw new Error("empty realization response");
        return parseRealizationBatch(content, batch);
      }));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          for (const item of result.value) {
            const original = normalized.find(concept => concept.category === item.category && concept.text === item.text);
            if (original) {
              const fallbackFamily = realizedByKey.get(original.id)?.family || [];
              const mergedFamily = distinctRealizationFamily([...item.family, ...fallbackFamily], 6);
              realizedByKey.set(original.id, { ...original, family: mergedFamily.length ? mergedFamily : item.family });
            }
          }
        } else {
          const layer = [...new Set((batches[index] || []).map(item => item.layer))].join("+") || "UNKNOWN";
          const message = String(result.reason?.message || result.reason || "unknown error").slice(0, 160);
          failures.push({ layer, batchSize: batches[index]?.length || 0, message });
          console.warn(`[realize-direct-audio] ${layer} batch failed, using fast fallback: ${message}`);
        }
      });
    }

    const realizationItems = [...realizedByKey.values()];
    for (const item of realizationItems) realizations[item.text] = item.family;
    return { realizations, realizationItems, failures, trackEpoch, sessionId,
      batchCount: services.client ? realizationBatches(normalized).length : 0 };
}

app.post("/api/realize-direct-audio", async (req, res) => {
  try {
    res.json(await realizeDirectAudio({ ...(req.body || {}), provider: requestProvider(req) }));
  } catch (err) {
    console.error("[realize-direct-audio error]", err);
    res.status(500).json({ error: err.message });
  }
});

// CONTEXT is a collaboration. The fixed-label classifier and Music Flamingo hear the same audio
// through completely different apparatus, and where they disagree the disagreement is itself
// information. This reconciles the two READINGS -- it never listens, so it is not a third witness:
// its output carries its own provenance and must never be counted as corroboration of either
// input it was built from.
//
// No specimen genre names appear in this prompt. Showing examples to an open-vocabulary model
// narrows what it is willing to say, which is the failure this whole pipeline exists to avoid.
app.post("/api/compose-genre", async (req, res) => {
  try {
    const {
      classifier = {}, deepListen = [], uncertainties = [],
      localGenreHistory = [], blindFlamingoGenreHistory = [],
      audibleObservations = [], signatureRelations = [],
      flamingoIndependent = true, classifierIndependent = true,
      listeningMode = "blind"
    } = req.body || {};
    const advisory = GenreAdvisory.sanitize(classifier);
    const heard = (Array.isArray(deepListen) ? deepListen : [])
      .map(item => ({
        label: String(item?.label || "").replace(/\s+/g, " ").trim().slice(0, 64),
        confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0))
      }))
      .filter(item => item.label).slice(0, 5);
    const services = servicesFor(requestProvider(req));
    if (!services.client || (!advisory && !heard.length)) return res.json({ composite: [], uncertainties: [] });

    const lines = (items, label, score) => items.length
      ? items.map(item => `  - ${item[label]} (${item[score].toFixed(2)})`).join("\n")
      : "  (none)";
    const classifierLines = lines(advisory?.candidates || [], "label", "score");
    const heardLines = lines(heard, "label", "confidence");
    const openQuestions = (Array.isArray(uncertainties) ? uncertainties : [])
      .filter(item => typeof item === "string").slice(0, 5)
      .map(item => `  - ${item.slice(0, 120)}`).join("\n");
    const margin = (advisory?.uncertainty?.margin ?? 0).toFixed(3);
    const entropy = (advisory?.uncertainty?.entropy ?? 1).toFixed(2);
    const selfUncertain = advisory?.uncertainty?.uncertain ? ", self-reported UNCERTAIN" : "";
    const advisoryIndependent = classifierIndependent !== false;
    const flamingoMode = listeningMode === "assisted" ? "assisted" : "blind";
    const flamingoIndependentFlag = flamingoIndependent !== false && flamingoMode === "blind";
    const historyLine = (items, pick) => (Array.isArray(items) ? items : []).slice(-6)
      .map(pick).filter(Boolean).map(line => `  - ${line}`).join("\n");
    const localHistoryLines = historyLine(localGenreHistory, item => {
      const top = item?.topK?.[0]?.label || item?.label;
      return top ? `${top} raw=${Number(item.rawTopScore ?? item.topK?.[0]?.score ?? 0).toFixed(2)}` : "";
    });
    const flamingoHistoryLines = historyLine(blindFlamingoGenreHistory, item => {
      const label = item?.hypotheses?.[0]?.label || item?.label;
      return label ? `${label} mode=${item.listeningMode || "blind"} independent=${item.independent !== false}` : "";
    });
    const observationLines = [
      ...(Array.isArray(audibleObservations) ? audibleObservations : []).slice(0, 6)
        .map(item => `  - obs ${item?.id || ""} ${String(item?.text || "").slice(0, 80)}`),
      ...(Array.isArray(signatureRelations) ? signatureRelations : []).slice(0, 4)
        .map(item => `  - rel ${item?.id || ""} ${String(item?.text || "").slice(0, 80)}`)
    ].filter(line => line.trim().length > 4).join("\n");

    const prompt = [
      "You are an evidence adjudicator. You did not hear the audio. Do not invent audible facts.",
      "Independence is given as metadata. Never assume two readings are independent systems,",
      "and never treat a fixed-label classifier as well calibrated.",
      "",
      `READING A — pretrained classifier with a FIXED label set (independent=${advisoryIndependent}).`,
      "Treat this as fast broad genre evidence. It names the nearest trained label:",
      classifierLines,
      `Uncertainty diagnostics (not probabilities): margin ${margin}, entropy ${entropy}${selfUncertain}.`,
      localHistoryLines ? `\nLocal patch history:\n${localHistoryLines}` : "",
      "",
      `READING B — Music Flamingo (listeningMode=${flamingoMode}, independent=${flamingoIndependentFlag}).`,
      "Open vocabulary. If independent=false or listeningMode=assisted, this is correlated with A",
      "and must not be counted as a second independent vote.",
      heardLines,
      flamingoHistoryLines ? `\nBlind Flamingo genre history:\n${flamingoHistoryLines}` : "",
      observationLines ? `\nAudible observations and signature relations:\n${observationLines}` : "",
      openQuestions ? `\nWhat B said it was unsure about:\n${openQuestions}` : "",
      "",
      'Reconcile them. Return strict JSON: {"composite": [...], "uncertainties": [...]}.',
      'Each composite entry is {"label", "confidence", "relation", "reconciles", "evidenceRefs", "synthesized"}.',
      "- label: the name for this music. Use whatever name is actually right, from either reading or",
      "  from neither. You are not restricted to the labels above, and you must not invent one to",
      "  fill space.",
      '- relation: "agreement" when both independent readings point at the same thing; "specialization"',
      "  when B names something narrower that A's labels are the surrounding territory of; \"conflict\"",
      "  when they cannot both be true. If B is not independent, agreement is assisted, not two-system.",
      "- reconciles: which labels from above this entry accounts for.",
      "- evidenceRefs: ids or labels that support the entry.",
      "- synthesized: true when the label was not uttered by A or B and you proposed it from evidence.",
      "- confidence 0..1, reflecting how well the independent evidence actually supports this name.",
      "  Do not raise confidence because an assisted reading repeated a classifier label.",
      "Return at most 3 entries, fewer when the readings do not support more, and an empty array when",
      "they cannot be reconciled at all -- say why in uncertainties instead.",
      "uncertainties: short strings naming what stays unresolved between the two readings."
    ].join("\n");

    const response = await services.clientFor("genre-composition").chat.completions.create({
      model: services.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      ...chatCompletionBudget(420)
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    const RELATIONS = new Set(["agreement", "specialization", "conflict"]);
    const knownLabels = new Set([
      ...(advisory?.candidates || []).map(item => item.label.toLowerCase()),
      ...heard.map(item => item.label.toLowerCase())
    ]);
    const composite = (Array.isArray(parsed.composite) ? parsed.composite : []).slice(0, 3)
      .map(item => {
        const label = String(item?.label || "").replace(/\s+/g, " ").trim().slice(0, 64);
        const synthesized = Boolean(item?.synthesized) || (label && !knownLabels.has(label.toLowerCase()));
        return {
          label,
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
          relation: RELATIONS.has(item?.relation) ? item.relation : "agreement",
          reconciles: (Array.isArray(item?.reconciles) ? item.reconciles : [])
            .map(value => String(value || "").trim().slice(0, 64)).filter(Boolean).slice(0, 6),
          evidenceRefs: (Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [])
            .map(value => String(value || "").trim().slice(0, 64)).filter(Boolean).slice(0, 8),
          synthesized,
          independent: Boolean(advisoryIndependent && flamingoIndependentFlag && !synthesized)
        };
      })
      .filter(item => item.label && GenreLabels.isPlausibleGenreLabel(item.label));
    res.json({
      composite,
      uncertainties: (Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [])
        .filter(item => typeof item === "string" && item.trim())
        .map(item => item.slice(0, 160)).slice(0, 5)
    });
  } catch (err) {
    console.error("[compose-genre error]", err);
    res.status(500).json({ error: err.message, composite: [], uncertainties: [] });
  }
});

// World-knowledge concept expansion for a newly-discovered open-world genre/microgenre
// (OpenWorldConceptRegistry.proposeExpansion). World knowledge only PROPOSES a small neighborhood
// of candidate related concepts here -- it is the caller's registry + evidence fusion that decides
// which of them ever become stable enough to surface, so this deliberately returns a short,
// low-confidence list rather than an encyclopedia dump.
app.post("/api/expand-concept", async (req, res) => {
  try {
    const { concept, conceptType = "genre" } = req.body || {};
    const label = String(concept || "").trim();
    if (!label) return res.status(400).json({ error: "A concept label is required." });
    const services = servicesFor(requestProvider(req));
    if (!services.client) return res.json({ expansions: {} });

    const prompt = `You are a music knowledge specialist. For the ${conceptType} "${label}", propose a SMALL neighborhood of related concepts, only where you have genuine grounded knowledge -- leave a category as an empty array rather than guessing.
Return strict JSON with these keys, each an array of 0-3 short phrases (a few words, no sentences):
- scene: regional or subcultural scene(s) associated with it
- lineage: closely related genres/microgenres it descends from or influenced
- culture: broader cultural context (not a specific person, place or date)
- productionTraits: characteristic production/instrumentation traits
- aestheticAssociations: visual/sensory aesthetic associations
Do not include the concept's own name in any list.`;

    const response = await services.clientFor("concept-expansion").chat.completions.create({
      model: services.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      ...chatCompletionBudget(400)
    });
    const content = response.choices?.[0]?.message?.content;
    const parsed = content ? JSON.parse(content) : {};
    const expansions = {};
    for (const key of ["scene", "lineage", "culture", "productionTraits", "aestheticAssociations"]) {
      if (Array.isArray(parsed[key])) {
        expansions[key] = parsed[key].filter(v => typeof v === "string" && v.trim()).slice(0, 3);
      }
    }
    res.json({ concept: label, conceptType, expansions });
  } catch (err) {
    console.error("[expand-concept error]", err);
    res.status(500).json({ error: err.message, expansions: {} });
  }
});

app.post("/api/music-analysis", async (req, res) => {
  try {
    const { featurePacket } = req.body || {};
    if (!featurePacket?.audio || !featurePacket?.rhythm) {
      return res.status(400).json({ error: "A complete featurePacket is required." });
    }
    const services = servicesFor(requestProvider(req));
    if (!services.client) {
      return res.status(503).json({ error: "Optional language-model enrichment is not configured." });
    }

    const startedAt = Date.now();
    const response = await services.clientFor("music-analysis").responses.create(createMusicAnalysisRequest(featurePacket));

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

function attachRealtimeAudioSocket(server, { analyze = analyzeStreamAudio, realize = realizeDirectAudio,
  inferModels = inferStreamModels,
  translate = (args, signal, provider) => servicesFor(provider).englishSurfaces.translate(args, signal),
  associate = (args, signal, provider) => servicesFor(provider).groundedAssociations.associate(args, signal),
  associationsOnScreen = process.env.MUSIC_SHOWER_ASSOCIATIONS_ON_SCREEN !== "0",
  forensicListening = process.env.MUSIC_SHOWER_FORENSIC_LISTENING !== "0" } = {}) {
  const socketServer = new WebSocketServer({
    server,
    path: "/ws/music-shower",
    maxPayload: 1024 * 1024
  });
  const configuredOrigins = new Set(
    String(process.env.MUSIC_SHOWER_ALLOWED_ORIGINS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );

  socketServer.on("connection", (socket, request) => {
    const origin = String(request.headers.origin || "");
    if (configuredOrigins.size && !configuredOrigins.has(origin)) {
      socket.close(1008, "Origin is not allowed");
      return;
    }

    const streamId = crypto.randomUUID();
    const send = payload => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    };
    // Language-model hooks follow the provider this connection chose in its start message.
    const session = new RealtimeMusicSession({ streamId, send, analyze, inferModels, associationsOnScreen, forensicListening,
      realize: (args, signal) => realize({ ...args, provider: session.llmProvider }, signal),
      translate: translate && ((args, signal) => translate(args, signal, session.llmProvider)),
      associate: associate && ((args, signal) => associate(args, signal, session.llmProvider)),
      llmProviders: llmProviders.ids.filter(id => llmProviders.isConfigured(id)),
      defaultLlmProvider: llmProviders.defaultId });
    send({ type: "ready", streamId, sampleRate: 16000, trackEpoch: session.trackEpoch,
      tokenModeControl: true, tokenModes: ["free", "token"], defaultTokenMode: "free",
      llmProviders: llmProviders.describe(), defaultLlmProvider: llmProviders.defaultId,
      poolSource: "music-shower-final", buildVersion: BUILD_VERSION });
    socket.once("close", () => session.close());
    socket.on("error", () => session.close());

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        let message = null;
        try { message = JSON.parse(data.toString("utf8")); } catch { return; }
        if (message?.type === "start") {
          session.start(message);
        } else if (message?.type === "track_changed" || message?.type === "playback") {
          session.playback(message);
        } else if (message?.type === "word_language") {
          session.setWordLanguage(message.language);
        } else if (message?.type === "word_used") {
          session.noteUsed(message);
        } else if (message?.type === "ping") {
          send({ type: "pong", at: Date.now() });
        }
        return;
      }

      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!pcm.length || pcm.length % 4 !== 0) return;
      const samples = new Float32Array(pcm.length / 4);
      for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readFloatLE(index * 4);
      session.push(samples);
    });
  });

  return socketServer;
}

if (require.main === module) {
  const server = http.createServer(app);
  attachRealtimeAudioSocket(server);
  server.listen(PORT, () => {
    console.log(`AI Music Synesthesia running at http://localhost:${PORT}`);
    console.log(`AI configured: ${Boolean(process.env.OPENAI_API_KEY)}`);
    for (const provider of llmProviders.describe()) {
      console.log(`LLM provider ${provider.id}: ${provider.configured ? `configured (${provider.model})` : "no key"}` +
        (provider.freeTier ? ` · pacing ${provider.freeTier.rpm}/min, ${provider.freeTier.rpd}/day (used today ${provider.freeTier.usedToday})` : ""));
    }
    console.log(`Default LLM provider: ${llmProviders.defaultId}`);
    console.log(`AI model: ${MODEL} (${REASONING_EFFORT})`);
    console.log(`AI max output tokens: ${MAX_OUTPUT_TOKENS}`);
    console.log(`Language pool model: ${LANGUAGE_MODEL} | fast=${JSON.stringify(CallTuning.fast)} deep=${JSON.stringify(CallTuning.deep)}`);
    console.log("SoundCloud mode: browser tab audio over WebSocket (no API key required)");
    console.log(`Build: ${BUILD_VERSION}`);
  });
}

module.exports = { app, createMusicAnalysisRequest, musicProfileSchema, BUILD_VERSION,
  normalizedRealizationConcepts, realizationBatches, buildRealizationPrompt, parseRealizationBatch,
  realizationSurfaceSimilarity, distinctRealizationFamily, chatCompletionBudget, trimPcmWavToLastSeconds,
  normalizeLiveWordToken, updateLiveWordPool, attachRealtimeAudioSocket };
