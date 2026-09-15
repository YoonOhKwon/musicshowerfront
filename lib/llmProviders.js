"use strict";

// Language-model providers for the token (API) mode. Every caller keeps using the OpenAI SDK call
// surface (chat.completions.create / responses.create); a provider decides which service answers.
//
//   openai  - the original paid path, unchanged.
//   gemini  - Google Gemini through its OpenAI-compatible endpoint, intended for the free tier:
//             requests are adapted to what that endpoint accepts, paced under the free-tier
//             request limits, and moved to a fallback model when one is overloaded.

const fs = require("node:fs");
const path = require("node:path");

const PROVIDER_IDS = ["openai", "gemini"];
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_DEFAULT_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];

function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function listFromEnv(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// ---------------------------------------------------------------------------------------------
// Request adaptation (pure, unit tested)

// Gemini maps reasoning_effort to its thinking level and rejects "none" / "minimal".
const GEMINI_EFFORT = { none: "low", minimal: "low", low: "low", medium: "medium", high: "high" };
// OpenAI-only request fields the Gemini endpoint does not understand.
const OPENAI_ONLY_FIELDS = ["store", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention",
  "service_tier", "verbosity", "metadata", "safety_identifier", "user", "parallel_tool_calls"];
// Thinking shares the completion budget; very small budgets come back truncated.
const GEMINI_MIN_COMPLETION_TOKENS = 1024;

function adaptChatRequestForGemini(request = {}, model) {
  const adapted = { ...request, model };
  for (const field of OPENAI_ONLY_FIELDS) delete adapted[field];
  if (adapted.reasoning_effort != null) {
    const effort = GEMINI_EFFORT[String(adapted.reasoning_effort).toLowerCase()];
    if (effort) adapted.reasoning_effort = effort;
    else delete adapted.reasoning_effort;
  }
  const budget = Number(adapted.max_completion_tokens ?? adapted.max_tokens);
  delete adapted.max_tokens;
  if (Number.isFinite(budget) && budget > 0) adapted.max_completion_tokens = Math.max(GEMINI_MIN_COMPLETION_TOKENS, Math.round(budget));
  return adapted;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join("\n");
}

// Responses API request -> Chat Completions request (the Gemini endpoint only speaks the latter).
function responsesToChatRequest(request = {}) {
  const messages = [];
  if (request.instructions) messages.push({ role: "system", content: String(request.instructions) });
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input || [];
  for (const item of input) {
    const role = item?.role === "developer" || item?.role === "system" ? "system" : item?.role === "assistant" ? "assistant" : "user";
    const content = textOfContent(item?.content);
    if (content) messages.push({ role, content });
  }
  const chat = { model: request.model, messages };
  const format = request.text?.format;
  if (format?.type === "json_schema") {
    chat.response_format = { type: "json_schema",
      json_schema: { name: format.name || "response", schema: format.schema, strict: format.strict !== false } };
  } else if (format?.type === "json_object") {
    chat.response_format = { type: "json_object" };
  }
  if (request.max_output_tokens) chat.max_completion_tokens = request.max_output_tokens;
  if (request.reasoning?.effort) chat.reasoning_effort = request.reasoning.effort;
  return chat;
}

// Chat Completions response -> the Responses API fields callers read.
function chatToResponsesResponse(response = {}) {
  const choice = response.choices?.[0] || {};
  const outputText = typeof choice.message?.content === "string" ? choice.message.content : "";
  const truncated = choice.finish_reason === "length";
  const usage = response.usage || {};
  return {
    id: response.id,
    model: response.model,
    status: outputText && !truncated ? "completed" : "incomplete",
    incomplete_details: truncated ? { reason: "max_output_tokens" } : outputText ? null : { reason: choice.finish_reason || "empty" },
    output_text: outputText,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
      total_tokens: Number(usage.total_tokens) || 0,
      input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0 },
      output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0 }
    }
  };
}

// A strict json_schema the endpoint cannot accept becomes JSON mode with the schema in the prompt.
function jsonSchemaAsPrompt(request) {
  const schema = request.response_format?.json_schema?.schema;
  const messages = [...(request.messages || [])];
  messages.push({ role: "system",
    content: `Return only one JSON object that matches this JSON schema exactly:\n${JSON.stringify(schema)}` });
  return { ...request, messages, response_format: { type: "json_object" } };
}

// Retry on the next model when the upstream is overloaded / unavailable, not when the request is wrong.
function isOverloaded(error) {
  const status = Number(error?.status);
  return status === 503 || status === 500 || status === 502 || status === 504 ||
    /high demand|overloaded|unavailable/i.test(String(error?.message || ""));
}

function isQuotaExceeded(error) {
  return Number(error?.status) === 429 || /quota|rate limit|resource.?exhausted/i.test(String(error?.message || ""));
}

// Gemini reports "retryDelay": "31s" inside RESOURCE_EXHAUSTED errors.
function retryDelayMs(error, fallbackMs) {
  const text = `${error?.message || ""} ${JSON.stringify(error?.error || "")}`;
  const match = text.match(/retry(?:Delay|[ _-]?after)?["':\s]*"?(\d+(?:\.\d+)?)s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : fallbackMs;
}

// ---------------------------------------------------------------------------------------------
// Free-tier pacing

// Pacific calendar day: Gemini daily quotas reset at midnight Pacific time.
function pacificDay(time) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(time));
}

function abortError() {
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  return error;
}

function createRequestLimiter({ rpm = 10, rpd = 900, maxWaitMs = 20000, cooldownMs = 60000, stateFile = null,
  now = Date.now, sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  }) } = {}) {
  const recent = [];
  let day = pacificDay(now());
  let dayCount = 0;
  let cooldownUntil = 0;
  let queue = Promise.resolve();

  if (stateFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (saved.day === day) dayCount = Math.max(0, Number(saved.count) || 0);
    } catch {
      // No saved count yet.
    }
  }
  const persist = () => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ day, count: dayCount }));
    } catch {
      // Pacing still works in memory.
    }
  };

  async function reserve(signal) {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const time = now();
      const today = pacificDay(time);
      if (today !== day) { day = today; dayCount = 0; }
      if (time < cooldownUntil) {
        throw httpError(`Gemini free-tier limit reached; retrying after ${Math.ceil((cooldownUntil - time) / 1000)}s.`, 429, "llm_rate_limited");
      }
      if (dayCount >= rpd) throw httpError("Gemini daily free-tier request budget is used up.", 429, "llm_daily_limit");
      while (recent.length && time - recent[0] >= 60000) recent.shift();
      if (recent.length < rpm) {
        recent.push(time);
        dayCount += 1;
        persist();
        return;
      }
      const waitMs = recent[0] + 60000 - time;
      if (waitMs > maxWaitMs) throw httpError("Gemini per-minute free-tier limit reached.", 429, "llm_rate_limited");
      await sleep(waitMs, signal);
    }
  }

  return {
    // Requests are reserved one at a time so concurrent callers cannot overshoot the minute window.
    acquire(signal) {
      const turn = queue.then(() => reserve(signal));
      queue = turn.catch(() => {});
      return turn;
    },
    noteQuotaError(error) {
      cooldownUntil = Math.max(cooldownUntil, now() + retryDelayMs(error, cooldownMs));
    },
    get state() {
      const time = now();
      return { rpm, rpd, usedToday: dayCount, day, lastMinute: recent.filter(at => time - at < 60000).length,
        coolingDownMs: Math.max(0, cooldownUntil - time) };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Clients

function createGeminiClient({ client, models = GEMINI_DEFAULT_MODELS, limiter }) {
  async function createChat(request, options = {}) {
    let lastError = null;
    for (const model of models) {
      await limiter.acquire(options.signal);
      let adapted = adaptChatRequestForGemini(request, model);
      try {
        try {
          return await client.chat.completions.create(adapted, options);
        } catch (error) {
          if (Number(error?.status) !== 400 || adapted.response_format?.type !== "json_schema") throw error;
          adapted = jsonSchemaAsPrompt(adapted);
          await limiter.acquire(options.signal);
          return await client.chat.completions.create(adapted, options);
        }
      } catch (error) {
        lastError = error;
        if (isQuotaExceeded(error)) {
          limiter.noteQuotaError(error);
          throw error;
        }
        if (!isOverloaded(error) || options.signal?.aborted) throw error;
      }
    }
    throw lastError || httpError("No Gemini model is configured.", 503, "llm_no_model");
  }

  return {
    chat: { completions: { create: createChat } },
    responses: {
      create: async (request, options) => chatToResponsesResponse(await createChat(responsesToChatRequest(request), options))
    }
  };
}

function createLlmProviders({ env = process.env, OpenAI = require("openai"), cacheDir = null, openaiModel = "" } = {}) {
  const geminiModels = [...new Set([...listFromEnv(env.GEMINI_MODEL), ...listFromEnv(env.GEMINI_FALLBACK_MODELS)])];
  const gemini = {
    id: "gemini",
    label: "Gemini",
    configured: Boolean(env.GEMINI_API_KEY),
    models: geminiModels.length ? geminiModels : GEMINI_DEFAULT_MODELS,
    client: null,
    limiter: null
  };
  if (gemini.configured) {
    gemini.limiter = createRequestLimiter({
      rpm: positiveNumber(env.GEMINI_RPM, 10),
      rpd: positiveNumber(env.GEMINI_RPD, 900),
      stateFile: cacheDir ? path.join(cacheDir, "gemini-daily-requests.json") : null
    });
    gemini.client = createGeminiClient({
      client: new OpenAI({ apiKey: env.GEMINI_API_KEY, baseURL: env.GEMINI_BASE_URL || GEMINI_BASE_URL }),
      models: gemini.models,
      limiter: gemini.limiter
    });
  }
  const openai = {
    id: "openai",
    label: "OpenAI",
    configured: Boolean(env.OPENAI_API_KEY),
    models: [openaiModel],
    client: env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null,
    limiter: null
  };
  const byId = { openai, gemini };
  const requestedDefault = String(env.LLM_DEFAULT_PROVIDER || "").toLowerCase();
  const defaultId = byId[requestedDefault]?.configured ? requestedDefault
    : openai.configured ? "openai" : gemini.configured ? "gemini" : "openai";

  return {
    defaultId,
    ids: PROVIDER_IDS,
    resolve(id) {
      const key = String(id || "").toLowerCase();
      return byId[key] ? key : defaultId;
    },
    get(id) {
      return byId[this.resolve(id)];
    },
    isConfigured(id) {
      return Boolean(byId[String(id || "").toLowerCase()]?.configured);
    },
    // What clients may show: never the keys.
    describe() {
      return PROVIDER_IDS.map(id => {
        const provider = byId[id];
        return { id, label: provider.label, configured: provider.configured, model: provider.models[0] || "",
          ...(provider.limiter ? { freeTier: provider.limiter.state } : {}) };
      });
    }
  };
}

module.exports = { PROVIDER_IDS, GEMINI_BASE_URL, GEMINI_DEFAULT_MODELS, adaptChatRequestForGemini,
  responsesToChatRequest, chatToResponsesResponse, jsonSchemaAsPrompt, isOverloaded, isQuotaExceeded,
  retryDelayMs, pacificDay, createRequestLimiter, createGeminiClient, createLlmProviders };
