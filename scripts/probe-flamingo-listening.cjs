"use strict";
// Compare Music Flamingo listening prompts and window lengths on the same audio.
//
//   node scripts/probe-flamingo-listening.cjs --out probe.json "C:/music/a.mp3" "C:/music/b.mp3" --control horns
//
// Requires the Flamingo server's loopback-only /probe endpoint. Nothing here feeds the word pool.
// The keyword tally in the report is for reading the results only; no production code uses it.
const fs = require("node:fs/promises");
const path = require("node:path");
const { resampleWindowedSinc } = require("../js/ml/audioPreprocessing");
const { pcmToWav } = require("../lib/streamDeepAnalysis");

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const valueArgs = new Set(["--out", "--control", "--start", "--only"].flatMap(flag => { const i = args.indexOf(flag); return i >= 0 ? [i, i + 1] : []; }));
const tracks = args.filter((arg, index) => !valueArgs.has(index) && !arg.startsWith("--"));
const control = option("control", "");
const START_SECONDS = Number(option("start", 45));
const OUT = option("out", "probe.json");
// --only ID limits the run to one variant (e.g. the production forensic prompt).
const ONLY = option("only", "");

const productionSource = require("node:fs").readFileSync(path.join(__dirname, "flamingo_server.py"), "utf8");
const CURRENT_PROMPT = productionSource.split('PROMPT = """')[1].split('""".strip()')[0].trim() +
  "\nLISTENING STAGE: INDEPENDENT BLIND LISTEN (60s audible time). Judge only this audio window and preserve ambiguity where it does not discriminate among plausible readings.";

const RICH_CAPTION = `Write a rich, detailed description of how this recording was made. For each prominent sound, say what it is and how it was produced or sourced, and how it has been processed, edited, or arranged. Describe any vocals: language, delivery, and any treatment. Then describe the genre and the cultural or historical context the production points to. Be specific about what you actually hear.`;

const FORENSICS = `Answer each question from what you hear in this audio. For every answer name the audible cue, and answer "unsure" when the audio does not decide it.
1. Is any part taken from a pre-existing recording (a sample or loop) rather than performed or programmed for this track? Which parts?
2. Are there vocals? If so, what language, and are they pitch-shifted, time-stretched, chopped, or filtered?
3. Does a phrase or bar repeat identically as a loop?
4. What processing is audible on the main loop or groove (for example filtering, sidechain pumping, saturation, bit reduction)?
5. What period does the recording and production character of any source material suggest, separately from the newer production around it?`;

const PRODUCTION_FORENSIC = productionSource.split('FORENSIC_PROMPT = """')[1].split('""".strip()')[0].trim();
const VARIANTS = [
  { id: "F-forensic-production-30s", prompt: PRODUCTION_FORENSIC, seconds: 30, maxTokens: 320 },
  { id: "A-json-current-30s", prompt: CURRENT_PROMPT, seconds: 30, maxTokens: 1024 },
  { id: "B-rich-caption-30s", prompt: RICH_CAPTION, seconds: 30, maxTokens: 700 },
  { id: "C-forensics-30s", prompt: FORENSICS, seconds: 30, maxTokens: 600 },
  { id: "G-forensics-soft-30s", prompt: FORENSICS.replace("answer \"unsure\" when the audio does not decide it.",
    "answer \"unsure\" when the audio does not decide it. Begin each answer with its number and yes, no, or unsure."), seconds: 30, maxTokens: 600 },
  { id: "D-forensics-90s", prompt: FORENSICS, seconds: 90, maxTokens: 600 },
  { id: "E-rich-caption-90s", prompt: RICH_CAPTION, seconds: 90, maxTokens: 700 }
];
const CONTROL_VARIANTS = new Set(["A-json-current-30s", "C-forensics-30s", "D-forensics-90s", "F-forensic-production-30s", "G-forensics-soft-30s"]);
const TALLY = { sampling: /\bsampl|\bloop|chopp|\bchop/i, pitchOrTime: /pitch|time-stretch|stretched|sped[- ]up|chipmunk/i,
  processing: /filter|sidechain|pump|saturat|bit[- ]?crush|lo-?fi/i, language: /japanese|english|korean|language/i,
  era: /\b(?:19|20)?[5-9]0s\b|eighties|seventies|nineties|decade/i };

async function mono16k(file) {
  const { default: decode } = await import("audio-decode");
  const audio = await decode(await fs.readFile(file));
  const mono = new Float32Array(audio.channelData[0].length);
  for (const channel of audio.channelData) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audio.channelData.length;
  return resampleWindowedSinc(mono, audio.sampleRate, 16000);
}

// Plain http without a response deadline: a probe waits behind any live /analyze call for the single
// inference lock, which can exceed fetch's 300-second header timeout.
function probe(wav, variant) {
  return new Promise((resolve, reject) => {
    const request = require("node:http").request({ host: "127.0.0.1", port: 5005, path: "/probe", method: "POST",
      headers: { "Content-Type": "audio/wav", "Content-Length": wav.length,
        "X-Probe-Prompt": Buffer.from(variant.prompt, "utf8").toString("base64"),
        "X-Probe-Max-Tokens": String(variant.maxTokens) } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`probe HTTP ${response.statusCode}`));
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      });
    });
    request.on("error", reject);
    request.end(wav);
  });
}

async function main() {
  const chosen = ONLY ? VARIANTS.filter(variant => variant.id === ONLY) : VARIANTS;
  const inputs = [...tracks.map(file => ({ file, variants: chosen })),
    ...(control ? [{ file: path.join(__dirname, `../test/fixtures/audio/${control}.mp3`), variants: chosen.filter(v => CONTROL_VARIANTS.has(v.id)) }] : [])];
  const results = [];
  for (const input of inputs) {
    const pcm = await mono16k(input.file);
    for (const variant of input.variants) {
      const start = Math.min(START_SECONDS * 16000, Math.max(0, pcm.length - variant.seconds * 16000));
      const wav = pcmToWav(pcm.subarray(start, start + variant.seconds * 16000), 16000);
      const { text, seconds } = await probe(wav, variant);
      const tally = Object.fromEntries(Object.entries(TALLY).map(([key, pattern]) => [key, pattern.test(text)]));
      results.push({ track: path.basename(input.file), variant: variant.id, inferenceSeconds: seconds, chars: text.length, tally, text });
      console.log(`${path.basename(input.file)} | ${variant.id} | ${seconds}s | ${JSON.stringify(tally)}`);
      await fs.writeFile(OUT, JSON.stringify(results, null, 2));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
