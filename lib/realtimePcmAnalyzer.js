"use strict";

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

class RealtimePcmAnalyzer {
  constructor({ sampleRate = 16000, windowSeconds = 0.75 } = {}) {
    this.sampleRate = Math.max(8000, Number(sampleRate) || 16000);
    this.windowSize = Math.max(2048, Math.round(this.sampleRate * windowSeconds));
    this.pending = [];
    this.pendingLength = 0;
    this.previousRms = 0;
    this.revision = 0;
    this.lastSignature = "";
  }

  push(samples) {
    if (!(samples instanceof Float32Array) || !samples.length) return null;
    this.pending.push(samples);
    this.pendingLength += samples.length;
    if (this.pendingLength < this.windowSize) return null;

    const frame = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const chunk of this.pending) {
      frame.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    return this.analyze(frame);
  }

  analyze(frame) {
    let sumSquares = 0;
    let peak = 0;
    let crossings = 0;
    let differenceEnergy = 0;
    let low = 0;
    let lowEnergy = 0;
    const lowAlpha = Math.exp(-2 * Math.PI * 180 / this.sampleRate);

    for (let index = 0; index < frame.length; index += 1) {
      const sample = Number.isFinite(frame[index]) ? frame[index] : 0;
      const previous = index ? frame[index - 1] : sample;
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (index && (sample >= 0) !== (previous >= 0)) crossings += 1;
      const difference = sample - previous;
      differenceEnergy += difference * difference;
      low = (1 - lowAlpha) * sample + lowAlpha * low;
      lowEnergy += low * low;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, frame.length));
    const differenceRms = Math.sqrt(differenceEnergy / Math.max(1, frame.length));
    const lowRms = Math.sqrt(lowEnergy / Math.max(1, frame.length));
    const bassRatio = rms > 0.0001 ? clamp01(lowRms / rms * 2.2) : 0;
    const brightness = rms > 0.0001 ? clamp01(differenceRms / rms * 1.8) : 0;
    const zcr = crossings / Math.max(1, frame.length - 1);
    const transient = clamp01(Math.max(0, rms - this.previousRms) * 18 + Math.max(0, peak - rms * 2) * 0.8);
    this.previousRms = rms;

    const features = {
      rms: clamp01(rms * 4),
      bass: bassRatio,
      high: brightness,
      transient,
      kick: clamp01(bassRatio * transient * 1.4),
      snare: clamp01(brightness * transient),
      vocal: clamp01((1 - Math.abs(brightness - 0.42) * 2) * (1 - bassRatio * 0.35)),
      peak: clamp01(peak),
      zcr: clamp01(zcr * 12)
    };
    const tokens = this.tokensFor(features);
    const signature = JSON.stringify(tokens);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.revision += 1;
    }
    return { features, tokens, revision: this.revision, live: rms > 0.002 };
  }

  tokensFor(features) {
    if (features.rms < 0.015) return [];
    const tokens = [];
    const add = (text, layer = "FACT") => tokens.push({ text, layer, type: "fragment", glow: 1 });

    if (features.rms > 0.62) add("높은 에너지");
    else if (features.rms > 0.24) add("단단한 음압");
    else add("여유 있는 다이내믹");

    if (features.bass > 0.68) add("두터운 저역");
    else if (features.bass > 0.4) add("선명한 베이스 중심");
    if (features.high > 0.64) add("밝게 열린 고역", "LIVE");
    else if (features.high < 0.28) add("어두운 톤 밸런스");
    if (features.transient > 0.58) add("또렷한 어택", "LIVE");
    else if (features.transient < 0.16) add("부드러운 트랜지언트");
    if (features.kick > 0.28) add("저역 펄스", "LIVE");
    if (features.vocal > 0.55) add("중역 중심의 질감");
    return tokens.slice(0, 12);
  }
}

module.exports = { RealtimePcmAnalyzer };
