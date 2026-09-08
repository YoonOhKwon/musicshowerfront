"use strict";

const crypto = require("node:crypto");
const Review = require("./directAudioReview");

function pcmToWav(samples, sampleRate) {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

async function analyzeStreamAudio({ samples, sampleRate, sessionId, trackEpoch, requestId,
  segmentId, activeAudioMs, firstImpression, signal }) {
  const headers = {
    "Content-Type": "audio/wav", "X-Music-Shower-Session": sessionId,
    "X-Music-Shower-Track-Epoch": String(trackEpoch),
    "X-Music-Shower-Request-Id": requestId, "X-Music-Shower-Segment": String(segmentId),
    "X-Music-Shower-Active-Ms": String(Math.round(activeAudioMs))
  };
  if (firstImpression) headers["X-Music-Shower-Listen-Depth"] = "first-impression";
  const deadline = AbortSignal.timeout(180000);
  const combined = AbortSignal.any([signal, deadline]);
  const cancel = () => {
    fetch("http://localhost:5005/cancel", {
      method: "POST", headers, signal: AbortSignal.timeout(2000)
    }).catch(() => {});
  };
  combined.addEventListener("abort", cancel, { once: true });
  try {
    combined.throwIfAborted();
    const body = pcmToWav(samples, sampleRate);
    const response = await fetch("http://localhost:5005/analyze", {
      method: "POST", headers, body, signal: combined
    });
    if (!response.ok) throw new Error(`Flamingo HTTP ${response.status}`);
    const result = await response.json();
    const observationId = `flam-${requestId}`;
    const review = Review.reviewCaption({ ...result, provider: "music-flamingo",
      audioSha256: crypto.createHash("sha256").update(body).digest("hex"),
      observationId, audioSegmentId: String(segmentId), sessionId, trackEpoch, requestId, activeAudioMs }, {});
    return { ...review, observationId, segmentId, trackEpoch,
      observations: Review.toObservations(review, { trackEpoch, requestId }) };
  } finally {
    combined.removeEventListener("abort", cancel);
  }
}

module.exports = { analyzeStreamAudio, pcmToWav };
