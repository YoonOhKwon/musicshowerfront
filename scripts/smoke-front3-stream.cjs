"use strict";
// Exercise the actual front3 Vite proxy and deployed backend with a bundled audio fixture.
const fs = require("node:fs/promises");
const path = require("node:path");
const { WebSocket } = require("ws");
const { resampleWindowedSinc } = require("../js/ml/audioPreprocessing");

async function main() {
  // Paid validation is opt-in, just like the music picker. Default smoke incurs no OpenAI calls.
  const tokenMode = process.argv.includes("--tokens") ? "token" : "free";
  const { default: decode } = await import("audio-decode");
  const audio = await decode(await fs.readFile(path.join(__dirname, "../test/fixtures/audio/outfoxing.mp3")));
  const mono = new Float32Array(audio.channelData[0].length);
  for (const channel of audio.channelData) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.channelData.length;
  const pcm = resampleWindowedSinc(mono, audio.sampleRate, 16000).subarray(0, 13 * 16000);
  const socket = new WebSocket("ws://127.0.0.1:5173/ws/music-shower");
  let gotPcmFeatures = false;
  let gotFinalPool = false;
  let lastStatus = "";
  let completed = false;
  const timer = setTimeout(() => finish(new Error("No realized Flamingo pool within 240 seconds")), 240000);
  const finish = error => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    socket.close();
    if (error) { console.error(error.message); process.exitCode = 1; }
  };
  socket.on("error", finish);
  socket.on("message", async data => {
    if (completed) return;
    const message = JSON.parse(data);
    if (message.type === "ready") {
      if (!message.tokenModeControl) return finish(new Error("Backend does not support token mode; no audio sent"));
      socket.send(JSON.stringify({ type: "start", tokenMode, sampleRate: 16000, channels: 1, format: "f32le" }));
    }
    if (message.type === "started") {
      if (message.tokenMode !== tokenMode) return finish(new Error("Token mode mismatch"));
      for (let offset = 0; offset < pcm.length && socket.readyState === WebSocket.OPEN; offset += 16000) {
        socket.send(Buffer.from(pcm.subarray(offset, offset + 16000).buffer, pcm.byteOffset + offset * 4,
          Math.min(16000, pcm.length - offset) * 4));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    if (message.type === "features" && message.live) gotPcmFeatures = true;
    if (message.type !== "word_pool") return;
    gotFinalPool ||= message.poolSource === "music-shower-final" && message.tokens.length > 0;
    const status = JSON.stringify(message.analysis);
    if (message.analysis.status !== lastStatus) {
      lastStatus = message.analysis.status;
      console.log(`pool=${message.tokens.length} stage=${status}`);
    }
    if (message.analysis.error) return finish(new Error(JSON.stringify(message.analysis.error)));
    const flamingo = message.tokens.filter(item => item.sourceFamily === "directAudio" &&
      (tokenMode === "free" || /[가-힣]/.test(item.text)));
    if (gotPcmFeatures && gotFinalPool && flamingo.length && message.analysis.status === "listening") {
      console.log(JSON.stringify({ ok: true, tokenMode: message.analysis.tokenMode,
        openAIEnabled: message.analysis.openAIEnabled, poolSource: message.poolSource,
        tokens: message.tokens.length, flamingo: flamingo.map(({ text, layer }) => ({ text, layer })) }, null, 2));
      finish();
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
