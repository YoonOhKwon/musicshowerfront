"use strict";
// Run lib/loopEvidence.js over several 30-second windows of local tracks to choose thresholds.
//   node scripts/calibrate-loop-evidence.cjs "C:/music/a.mp3" horns drums
const fs = require("node:fs/promises");
const path = require("node:path");
const { resampleWindowedSinc } = require("../js/ml/audioPreprocessing");
const { analyzeLoopEvidence } = require("../lib/loopEvidence");

async function main() {
  const { default: decode } = await import("audio-decode");
  for (const name of process.argv.slice(2)) {
    const file = /[\\/]|\.\w{3,4}$/.test(name) ? path.resolve(name) : path.join(__dirname, `../test/fixtures/audio/${name}.mp3`);
    const audio = await decode(await fs.readFile(file));
    const mono = new Float32Array(audio.channelData[0].length);
    for (const channel of audio.channelData) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.channelData.length;
    const pcm = resampleWindowedSinc(mono, audio.sampleRate, 16000);
    const rows = [];
    for (let start = 15; start + 30 <= pcm.length / 16000; start += 30) {
      const began = Date.now();
      const result = analyzeLoopEvidence(pcm.subarray(start * 16000, (start + 30) * 16000), 16000);
      rows.push({ start, ms: Date.now() - began, ...result });
    }
    console.log(`\n${path.basename(file)}`);
    for (const row of rows) console.log(`  @${row.start}s ${row.ms}ms bpm ${row.tempoBpm} beat ${row.beatConfidence} loop ${row.loopRepetition} (${row.loopBars} bar) sidechain ${row.sidechain}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
