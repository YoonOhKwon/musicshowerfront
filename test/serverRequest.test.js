const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMusicAnalysisRequest,
  musicProfileSchema,
  BUILD_VERSION,
  trimPcmWavToLastSeconds,
  normalizeLiveWordToken
} = require("../server");

test("server exposes a build identifier for stale-process diagnosis", () => {
  assert.equal(BUILD_VERSION, "2026.09.13.token-mode-v37");
});

test("Sol request keeps medium reasoning and an explicit reusable prompt prefix", () => {
  const request = createMusicAnalysisRequest({ audio: {}, rhythm: {} }, 10000);
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.reasoning.effort, "medium");
  assert.equal(request.max_output_tokens, 10000);
  assert.deepEqual(request.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.deepEqual(
    request.input[0].content[0].prompt_cache_breakpoint,
    { mode: "explicit" }
  );
});

test("structured output omits unused prose while retaining visual semantics", () => {
  const properties = musicProfileSchema.properties;
  assert.equal(properties.summary, undefined);
  assert.equal(properties.words.minItems, 8);
  assert.equal(properties.words.maxItems, 12);
  assert.ok(properties.genreProfile);
  assert.ok(properties.instrumentationProfile);
  assert.ok(properties.moodProfile);
  assert.ok(properties.visualProfile);
});

function pcmWav(sampleFrames, sampleRate = 100) {
  const output = Buffer.alloc(44 + sampleFrames * 2);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(sampleFrames * 2, 40);
  for (let index = 0; index < sampleFrames; index++) output.writeInt16LE(index, 44 + index * 2);
  return output;
}

test("oversized PCM WAV uploads are trimmed to the latest 30 seconds", () => {
  const source = pcmWav(4000, 100); // 40 seconds
  const trimmed = trimPcmWavToLastSeconds(source, 30);
  assert.equal(trimmed.length, 44 + 3000 * 2);
  assert.equal(trimmed.readUInt32LE(40), 3000 * 2);
  assert.equal(trimmed.readInt16LE(44), 1000, "the retained audio must begin at second 10, not replay the stale opening");
  assert.equal(trimmed.readInt16LE(trimmed.length - 2), 3999);
});

test("short or unknown audio payloads pass through unchanged", () => {
  const short = pcmWav(2000, 100);
  const unknown = Buffer.from("not a wav");
  assert.equal(trimPcmWavToLastSeconds(short, 30), short);
  assert.equal(trimPcmWavToLastSeconds(unknown, 30), unknown);
});

test("live word pool bridge exposes only the visual token contract", () => {
  assert.deepEqual(normalizeLiveWordToken({
    text: "  새벽의   잔향  ", layer: "aesthetic", type: "fragment", glow: 9, secret: "drop-me"
  }), {
    text: "새벽의 잔향", layer: "AESTHETIC", type: "fragment", glow: 4
  });
  assert.equal(normalizeLiveWordToken({ text: "   " }), null);
});
