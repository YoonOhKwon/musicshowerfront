"use strict";
// Token usage as a function of time, from the ledger written by lib/usageLedger.js.
//
//   node scripts/analyze-llm-usage.cjs llm-usage.jsonl --session session.json --bin 30 [--out report.json]
//
// --session  a measure-word-diversity.cjs report: its timeline sets t=0 and marks capture and
//            association events, and only calls inside the session window are counted.
// --price-in / --price-cached / --price-out  optional USD per 1M tokens for a cost column.
const fs = require("node:fs");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const ledgerFile = args.find(arg => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--")) || "llm-usage.jsonl";
const binSeconds = Number(option("bin", 30));
const session = option("session") ? JSON.parse(fs.readFileSync(option("session"), "utf8")) : null;
const prices = { input: Number(option("price-in", NaN)), cached: Number(option("price-cached", NaN)), output: Number(option("price-out", NaN)) };

const entries = fs.readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const timeline = session?.timeline || [];
const start = timeline[0]?.t ?? Math.min(...entries.map(entry => entry.t));
const end = timeline.length ? timeline[timeline.length - 1].t + 60000 : Math.max(...entries.map(entry => entry.t + entry.latencyMs));
const calls = entries.filter(entry => entry.t >= start && entry.t <= end)
  .map(entry => ({ ...entry, seconds: (entry.t - start) / 1000 }));
const durationSeconds = Math.max(1, (Math.max(end - 60000, ...calls.map(call => call.t + call.latencyMs)) - start) / 1000);

const sum = (list, key) => list.reduce((total, item) => total + (Number(item[key]) || 0), 0);
const round = (value, digits = 1) => Number(value.toFixed(digits));
const cost = list => Number.isFinite(prices.input) && Number.isFinite(prices.output)
  ? round(((sum(list, "inputTokens") - sum(list, "cachedInputTokens")) * prices.input +
      sum(list, "cachedInputTokens") * (Number.isFinite(prices.cached) ? prices.cached : prices.input) +
      sum(list, "outputTokens") * prices.output) / 1e6, 4) : null;

const purposes = [...new Set(calls.map(call => call.purpose))];
const byPurpose = Object.fromEntries(purposes.map(purpose => {
  const mine = calls.filter(call => call.purpose === purpose);
  return [purpose, {
    calls: mine.length, failed: mine.filter(call => !call.ok).length,
    inputTokens: sum(mine, "inputTokens"), cachedInputTokens: sum(mine, "cachedInputTokens"),
    outputTokens: sum(mine, "outputTokens"), reasoningTokens: sum(mine, "reasoningTokens"),
    totalTokens: sum(mine, "totalTokens"),
    tokensPerCall: mine.length ? Math.round(sum(mine, "totalTokens") / mine.length) : 0,
    reasoningShareOfOutput: sum(mine, "outputTokens") ? round(sum(mine, "reasoningTokens") / sum(mine, "outputTokens"), 2) : 0,
    meanLatencySeconds: mine.length ? round(sum(mine, "latencyMs") / mine.length / 1000) : 0,
    costUsd: cost(mine)
  }];
}));

const bins = [];
for (let from = 0; from < durationSeconds; from += binSeconds) {
  const mine = calls.filter(call => call.seconds >= from && call.seconds < from + binSeconds);
  bins.push({ from, to: from + binSeconds, calls: mine.length, totalTokens: sum(mine, "totalTokens"),
    byPurpose: Object.fromEntries(purposes.map(purpose => [purpose, sum(mine.filter(call => call.purpose === purpose), "totalTokens")])) });
}
let cumulative = 0;
for (const bin of bins) bin.cumulativeTokens = (cumulative += bin.totalTokens);

// Capture completions and association calls from the session timeline, as seconds from t=0.
const events = [];
for (let index = 1; index < timeline.length; index++) {
  const previous = timeline[index - 1], current = timeline[index];
  const seconds = round((current.t - start) / 1000);
  if (current.captures > previous.captures) events.push({ seconds, event: `capture ${current.captures}`, audioSeconds: round(current.activeAudioMs / 1000) });
  if (current.associationCalls > previous.associationCalls) events.push({ seconds, event: `association ${current.associationCalls}` });
}
const captureCount = Math.max(0, ...timeline.map(entry => entry.captures));
const totalTokens = sum(calls, "totalTokens");
const minutes = durationSeconds / 60;

const report = {
  ledger: ledgerFile, windowSeconds: round(durationSeconds), callCount: calls.length, captures: captureCount,
  totals: { inputTokens: sum(calls, "inputTokens"), cachedInputTokens: sum(calls, "cachedInputTokens"),
    outputTokens: sum(calls, "outputTokens"), reasoningTokens: sum(calls, "reasoningTokens"), totalTokens, costUsd: cost(calls) },
  rates: { tokensPerMinute: Math.round(totalTokens / minutes), tokensPerHourProjected: Math.round(totalTokens / minutes * 60),
    tokensPerCapture: captureCount ? Math.round(totalTokens / captureCount) : null, callsPerMinute: round(calls.length / minutes, 2) },
  byPurpose, events, bins,
  calls: calls.map(call => ({ seconds: round(call.seconds), purpose: call.purpose, ok: call.ok, totalTokens: call.totalTokens,
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, reasoningTokens: call.reasoningTokens,
    latencySeconds: round(call.latencyMs / 1000), finishReason: call.finishReason, error: call.error }))
};

if (option("out")) fs.writeFileSync(option("out"), JSON.stringify(report, null, 2));
const width = 40, peak = Math.max(1, ...bins.map(bin => bin.totalTokens));
console.log(`window ${report.windowSeconds}s · calls ${calls.length} · captures ${captureCount} · total ${totalTokens} tokens`);
console.log(`rates ${JSON.stringify(report.rates)}`);
console.log("\nby purpose");
for (const [purpose, stats] of Object.entries(byPurpose)) console.log(`  ${purpose.padEnd(22)} ${JSON.stringify(stats)}`);
console.log(`\ntokens per ${binSeconds}s (cumulative)`);
for (const bin of bins) {
  const marks = events.filter(event => event.seconds >= bin.from && event.seconds < bin.to).map(event => event.event).join(", ");
  console.log(`  ${String(bin.from).padStart(4)}s ${"#".repeat(Math.round(bin.totalTokens / peak * width)).padEnd(width)} ${String(bin.totalTokens).padStart(6)} (${bin.cumulativeTokens})${marks ? `  <- ${marks}` : ""}`);
}
