"use strict";
// Measure how varied the realtime word pool is for bundled fixtures, end to end:
// PCM -> RealtimeMusicSession -> Music Flamingo -> Korean realization -> final pool.
//
//   node scripts/measure-word-diversity.cjs --captures 4 --out before.json
//
// Audio is pushed faster than realtime but paused while a capture is analyzing, so every
// Flamingo window hears its own stretch of music. A simulated display reports one word per
// pushed second (like front3's spawner), which exercises the backend's repetition memory.
const fs = require("node:fs/promises");
const path = require("node:path");
const { WebSocket } = require("ws");
const { resampleWindowedSinc } = require("../js/ml/audioPreprocessing");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const URL = option("url", "ws://127.0.0.1:3000/ws/music-shower");
const ORIGIN = option("origin", "http://localhost:5173");
const CAPTURES = Number(option("captures", 4));
const FIXTURES = option("fixtures", "outfoxing,horns").split(",");
const TIMEOUT_MS = Number(option("timeout", 20 * 60)) * 1000;
const OUT = option("out", "");
// "en" asks the backend for English surfaces too, like front3's English word mode.
const LANGUAGE = option("language", "ko");
// The backend defaults to "free" (no OpenAI calls); measurements of language quality and token use need "token".
const TOKEN_MODE = option("token-mode", "token");
// --realtime N streams N seconds at playback speed instead of pausing for each capture.
const REALTIME_SECONDS = Number(option("realtime", 0));
// Seconds to wait after the last capture so a pending association call can publish.
const SETTLE_MS = Number(option("settle", 3)) * 1000;
const SAMPLE_RATE = 16000;
const BUSY = new Set(["analyzing", "realizing", "forensic"]);

async function loadPcm() {
  const { default: decode } = await import("audio-decode");
  const parts = [];
  for (const name of FIXTURES) {
    // A bare name is a bundled fixture; anything with a path separator or extension is a local file.
    const file = /[\\/]|\.\w{3,4}$/.test(name) ? path.resolve(name) : path.join(__dirname, `../test/fixtures/audio/${name}.mp3`);
    const audio = await decode(await fs.readFile(file));
    const mono = new Float32Array(audio.channelData[0].length);
    for (const channel of audio.channelData) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.channelData.length;
    parts.push(resampleWindowedSinc(mono, audio.sampleRate, SAMPLE_RATE));
  }
  const pcm = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { pcm.set(part, offset); offset += part.length; }
  return pcm;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const countBy = (items, key) => items.reduce((acc, item) => ((acc[key(item)] = (acc[key(item)] || 0) + 1), acc), {});

async function main() {
  const pcm = await loadPcm();
  const socket = new WebSocket(URL, { headers: { Origin: ORIGIN } });
  const pools = [];
  const errors = [];
  const used = [];
  const flamingoConceptsAfterCapture = [];
  const timeline = [];
  let analysis = {};
  let tokens = [];
  let trackEpoch = 1;
  let lastCaptures = 0;
  let done = false;

  const finish = async reason => {
    if (done) return;
    done = true;
    socket.close();
    const allTokens = pools.flat();
    const flamingo = allTokens.filter(item => item.sourceFamily === "directAudio");
    const recentRepeats = used.filter((text, index) => used.slice(Math.max(0, index - 40), index).includes(text)).length;
    const report = {
      reason,
      fixtures: FIXTURES,
      activeAudioSeconds: Math.round((analysis.activeAudioMs || 0) / 1000),
      captures: analysis.captures || 0,
      errors,
      finalPool: { size: tokens.length, layers: countBy(tokens, item => item.layer || "?"),
        flamingo: tokens.filter(item => item.sourceFamily === "directAudio").length },
      distinct: {
        texts: new Set(allTokens.map(item => item.text)).size,
        flamingoTexts: new Set(flamingo.map(item => item.text)).size,
        flamingoConcepts: new Set(flamingo.map(item => item.canonicalText || item.text)).size,
        textsByLayer: Object.fromEntries(Object.entries(countBy([...new Map(allTokens.map(item => [item.text, item])).values()],
          item => item.layer || "?"))),
      },
      newFlamingoConceptsPerCapture: flamingoConceptsAfterCapture,
      display: { shown: used.length, distinct: new Set(used).size,
        repeatShareWithin40: used.length ? +(recentRepeats / used.length).toFixed(3) : 0 },
      flamingoConceptSample: [...new Set(flamingo.map(item => `${item.layer}:${item.canonicalText || item.text}`))].slice(0, 40),
      association: analysis.association || null,
      timeline: timeline.filter((entry, index) => index === 0 || entry.status !== timeline[index - 1].status ||
        entry.captures !== timeline[index - 1].captures || entry.associationCalls !== timeline[index - 1].associationCalls),
      finalTokens: tokens.map(item => `${item.layer}/${item.category || "?"}/${item.sourceFamily || "local"}: ${item.text}${item.textEn ? ` / ${item.textEn}` : ""}`),
    };
    const json = JSON.stringify(report, null, 2);
    if (OUT) await fs.writeFile(OUT, json);
    console.log(json);
  };

  const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
  socket.on("error", error => { errors.push(String(error.message)); finish("socket error"); });
  socket.on("close", () => { clearTimeout(timer); finish("closed"); });
  socket.on("message", data => {
    const message = JSON.parse(data);
    if (message.type === "ready") {
      trackEpoch = message.trackEpoch || 1;
      socket.send(JSON.stringify({ type: "start", sampleRate: SAMPLE_RATE, channels: 1, format: "f32le", tokenMode: TOKEN_MODE }));
      socket.send(JSON.stringify({ type: "word_language", language: LANGUAGE }));
    }
    if (message.type === "started") stream().catch(error => { errors.push(String(error)); finish("stream error"); });
    if (message.type !== "word_pool") return;
    tokens = message.tokens || [];
    analysis = message.analysis || {};
    pools.push(tokens);
    timeline.push({ t: Date.now(), activeAudioMs: analysis.activeAudioMs || 0, status: analysis.status,
      captures: analysis.captures || 0, pool: tokens.length, associationCalls: analysis.association?.calls || 0 });
    if (analysis.error) {
      const last = errors[errors.length - 1];
      const text = `${analysis.error.stage}: ${analysis.error.code || ""} ${analysis.error.message}`.trim();
      if (last !== text) { errors.push(text); console.log(`[error] ${text}`); }
    }
    if ((analysis.captures || 0) > lastCaptures) {
      lastCaptures = analysis.captures;
      console.log(`[capture ${lastCaptures}] pool=${tokens.length} status=${analysis.status}`);
    }
  });

  async function stream() {
    let offset = 0;
    let seenFlamingo = new Set();
    let recordedCaptures = 0;
    const attempts = () => (analysis.captures || 0) + errors.filter(text => text.startsWith("flamingo")).length;
    const startedAt = Date.now();
    while (!done) {
      if (REALTIME_SECONDS) {
        // Real playback: one second of audio per wall-clock second, whatever the backend is doing.
        if (offset / SAMPLE_RATE >= REALTIME_SECONDS || (Date.now() - startedAt) / 1000 >= REALTIME_SECONDS) {
          await sleep(SETTLE_MS);
          return finish("done");
        }
      } else if (BUSY.has(analysis.status)) { await sleep(250); continue; }
      if ((analysis.captures || 0) > recordedCaptures) {
        recordedCaptures = analysis.captures;
        const current = new Set(pools.flat().filter(item => item.sourceFamily === "directAudio").map(item => item.canonicalText || item.text));
        flamingoConceptsAfterCapture.push([...current].filter(text => !seenFlamingo.has(text)).length);
        seenFlamingo = current;
      }
      if (!REALTIME_SECONDS && attempts() >= CAPTURES && !BUSY.has(analysis.status)) {
        await sleep(SETTLE_MS); // let the final realization and association publish
        for (let waited = 0; analysis.association?.pending && waited < 90000; waited += 500) await sleep(500);
        return finish("done");
      }
      const chunk = pcm.subarray(offset % (pcm.length - SAMPLE_RATE), offset % (pcm.length - SAMPLE_RATE) + SAMPLE_RATE);
      socket.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      offset += SAMPLE_RATE;
      if (tokens.length) {
        const recent = new Set(used.slice(-18));
        const choices = tokens.filter(item => !recent.has(item.text));
        const pick = (choices.length ? choices : tokens)[Math.floor(Math.random() * (choices.length || tokens.length))];
        used.push(pick.text);
        socket.send(JSON.stringify({ type: "word_used", text: pick.text, trackEpoch }));
      }
      await sleep(REALTIME_SECONDS ? Math.max(0, startedAt + offset / SAMPLE_RATE * 1000 - Date.now()) : 40);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
