// Root-cause tracer for `POST /api/language-pool` failures (section 11).
// Walks the exact production path -- fixture state -> snapshot -> validateLanguageInput ->
// createLanguageRequest -> upstream call -> parseLanguageResponse -- and reports where it broke.
// Without --live it stays offline and only audits request construction; with --live it makes ONE
// paid call and prints the real upstream status/code/type plus the measured token cost, which is
// what section 11-5 needs in order to right-size max_output_tokens instead of guessing.
const path = require("node:path");
const { profile } = require("../test/fixtures/languageProfiles");
const Snapshot = require("../js/semantic/semanticSnapshot");
const { createLanguageRequest, createLanguageService, parseLanguageResponse,
  validateLanguageInput, callMode, CALL_TUNING } = require("../lib/languageService");

const FIXTURE = process.env.DOCTOR_FIXTURE || "futurefunk";
// "pool-low" is the FAST path the running app actually spams; that is the request shape whose
// failure the user sees as a repeating 502, so it is the default subject of this diagnosis.
const REASON = process.env.DOCTOR_REASON || "pool-low";

function estimateInputTokens(request) {
  const text = request.input.map(item => typeof item.content === "string"
    ? item.content : item.content.map(part => part.text || "").join("")).join("");
  // Deliberately coarse: ~3.4 chars/token for mixed Korean+JSON. Used only to tell "small" from
  // "huge", never reported as an exact billing figure.
  return { characters: text.length, approxTokens: Math.round(text.length / 3.4) };
}

function describeRequest(body) {
  const clean = validateLanguageInput(body);
  const mode = callMode(clean.reason);
  const request = createLanguageRequest(body);
  const schema = request.text.format.schema;
  return {
    callMode: mode,
    model: request.model,
    reasoningEffort: request.reasoning.effort,
    maxOutputTokens: request.max_output_tokens,
    timeoutMs: CALL_TUNING[mode].timeoutMs,
    requestMode: clean.requestMode,
    candidateCount: clean.candidateCount,
    schemaFacets: Object.keys(schema.properties).length,
    schemaMaxItemsPerFacet: Math.max(...Object.values(schema.properties).map(facet => facet.maxItems)),
    payload: estimateInputTokens(request)
  };
}

function classifyFailure(error) {
  const upstreamStatus = Number(error.status) || null;
  const timedOut = Boolean(error.timedOut) || error.name === "APIConnectionTimeoutError" ||
    /timed? ?out/i.test(String(error.message || ""));
  return {
    stage: error.stage || "upstream-call",
    upstreamStatus,
    upstreamErrorType: error.upstreamErrorType || error.name || "Error",
    upstreamCode: error.code || error.error?.code || null,
    upstreamParam: error.param || error.error?.param || null,
    timedOut,
    elapsedMs: error.elapsedMs ?? null,
    message: String(error.message || "").slice(0, 400),
    // This is the mapping server.js applies. Printing it here makes it obvious whether the
    // browser's "502" is a real gateway problem or an upstream 4xx that got flattened.
    serverWouldReturn: upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600
      ? upstreamStatus : (timedOut ? 504 : 502)
  };
}

async function main() {
  const live = process.argv.includes("--live");
  require("dotenv").config({ quiet: true, path: path.resolve(__dirname, "../.env") });
  const state = profile(FIXTURE);
  const body = { snapshot: Snapshot.serialize(state), recentPhrases: [], reason: REASON,
    sessionId: 1, semanticEpoch: 1, candidateCount: 24 };

  const report = {
    fixture: FIXTURE,
    env: {
      // Presence only. The key itself is never printed or logged (section 11-2).
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "configured" : "missing",
      OPENAI_LANGUAGE_MODEL: process.env.OPENAI_LANGUAGE_MODEL || "(unset)",
      OPENAI_MODEL: process.env.OPENAI_MODEL || "(unset)",
      OPENAI_LANGUAGE_REASONING_EFFORT: process.env.OPENAI_LANGUAGE_REASONING_EFFORT || "(unset)"
    },
    request: describeRequest(body),
    live: null
  };

  if (!live) {
    console.log(JSON.stringify(report, null, 2));
    console.log("\nOffline audit only. Re-run with --live to make ONE paid call and capture the real upstream error.");
    return;
  }

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --live.");
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_LANGUAGE_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-sol";
  const startedAt = Date.now();

  // Call the raw SDK rather than the service so an upstream `incomplete` response is visible as
  // itself, before parseLanguageResponse turns it into a 502.
  try {
    const request = createLanguageRequest(body, { model });
    const response = await client.responses.create(request,
      { timeout: CALL_TUNING[callMode(REASON)].timeoutMs, maxRetries: 0 });
    const usage = response.usage || {};
    report.live = {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      responseStatus: response.status,
      incompleteReason: response.incomplete_details?.reason || null,
      model: response.model,
      outputTextChars: (response.output_text || "").length,
      usage: {
        inputTokens: usage.input_tokens ?? null,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
        totalTokens: usage.total_tokens ?? null
      },
      // The number section 11-5 asks for: what the response ACTUALLY needed versus the budget.
      outputTokenHeadroom: Number.isFinite(usage.output_tokens)
        ? report.request.maxOutputTokens - usage.output_tokens : null
    };
    try {
      const parsed = parseLanguageResponse(response);
      report.live.parsed = { candidates: parsed.candidates.length, rejectedTexts: parsed.rejectedTexts.length };
    } catch (parseError) {
      parseError.stage = "response-parse";
      report.live.ok = false;
      report.live.failure = classifyFailure(parseError);
    }
  } catch (error) {
    error.elapsedMs = Date.now() - startedAt;
    report.live = { ok: false, elapsedMs: error.elapsedMs, failure: classifyFailure(error) };
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.live && report.live.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`language-pool doctor failed: ${error.code || ""} ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { describeRequest, classifyFailure };
