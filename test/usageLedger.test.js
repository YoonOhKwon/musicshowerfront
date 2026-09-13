"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUsageLedger } = require("../lib/usageLedger");

test("every call through a purpose client is appended with time, purpose and both usage shapes", async t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "usage.jsonl");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  let clock = 1000;
  const ledger = createUsageLedger({ file, now: () => (clock += 250) });
  const client = {
    chat: { completions: { create: async () => ({ choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
        prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 12 } } }) } },
    responses: { create: async () => { throw Object.assign(new Error("boom"), { usage: { input_tokens: 9, output_tokens: 0 } }); } }
  };
  await ledger.clientFor(client, "english-surface").chat.completions.create({ model: "m" });
  await assert.rejects(ledger.clientFor(client, "language-pool").responses.create({ model: "m" }), /boom/);
  const [ok, failed] = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual({ purpose: ok.purpose, ok: ok.ok, inputTokens: ok.inputTokens, cachedInputTokens: ok.cachedInputTokens,
    outputTokens: ok.outputTokens, reasoningTokens: ok.reasoningTokens, totalTokens: ok.totalTokens, latencyMs: ok.latencyMs, t: ok.t },
    { purpose: "english-surface", ok: true, inputTokens: 100, cachedInputTokens: 30, outputTokens: 40,
      reasoningTokens: 12, totalTokens: 140, latencyMs: 250, t: 1250 });
  assert.equal(failed.purpose, "language-pool");
  assert.equal(failed.ok, false);
  assert.equal(failed.inputTokens, 9);
  assert.equal(ledger.clientFor(null, "x"), null);
});
