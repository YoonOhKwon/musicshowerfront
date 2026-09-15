"use strict";

// Append-only record of every OpenAI call: when it ran, what it was for, and what it cost in tokens.
// The realtime word pipeline makes several kinds of calls (Korean realization, English surfaces,
// grounded association, the general language pool); without a timestamped ledger their usage over a
// listening session cannot be analysed. One JSON object per line.

const fs = require("node:fs");
const path = require("node:path");

function usageFields(usage = {}) {
  // Chat Completions reports prompt/completion tokens; the Responses API reports input/output tokens.
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  return {
    inputTokens,
    cachedInputTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) || 0,
    outputTokens,
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens
  };
}

// Test runs (node --test sets NODE_TEST_CONTEXT) never append to the real ledger.
const DEFAULT_LEDGER = process.env.NODE_TEST_CONTEXT ? "" : (process.env.MUSIC_SHOWER_USAGE_LEDGER || "llm-usage.jsonl");

function createUsageLedger({ file = DEFAULT_LEDGER, now = Date.now } = {}) {
  const target = file ? path.resolve(file) : null;
  const write = entry => {
    if (!target) return;
    try {
      fs.appendFileSync(target, `${JSON.stringify(entry)}\n`);
    } catch {
      // Accounting must never break the word pipeline.
    }
  };

  async function record(purpose, api, request, call, provider = "openai") {
    const startedAt = now();
    try {
      const response = await call();
      write({ at: new Date(startedAt).toISOString(), t: startedAt, purpose, api, provider,
        model: response?.model || request?.model || "", ok: true, latencyMs: now() - startedAt, finishReason: response?.choices?.[0]?.finish_reason || response?.status || null,
        ...usageFields(response?.usage) });
      return response;
    } catch (error) {
      write({ at: new Date(startedAt).toISOString(), t: startedAt, purpose, api, provider,
        model: request?.model || "", ok: false, latencyMs: now() - startedAt, error: String(error?.message || error).slice(0, 160),
        ...usageFields(error?.usage) });
      throw error;
    }
  }

  // A client with the same call surface the callers already use, tagged with a purpose and the
  // provider (openai / gemini) that answered.
  function clientFor(client, purpose, provider = "openai") {
    if (!client) return null;
    return {
      chat: { completions: { create: (request, options) =>
        record(purpose, "chat.completions", request, () => client.chat.completions.create(request, options), provider) } },
      responses: { create: (request, options) =>
        record(purpose, "responses", request, () => client.responses.create(request, options), provider) }
    };
  }

  return { clientFor, record, file: target };
}

module.exports = { createUsageLedger, usageFields };
