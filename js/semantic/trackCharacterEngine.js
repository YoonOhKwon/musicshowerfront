const TrackCharacter = (() => {
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
  const mix = (left, right, amount) => left + (right - left) * clamp(amount);

  function safeRatio(numerator, denominator, scale = 1) {
    return clamp((Number(numerator) || 0) / Math.max(1e-6, Number(denominator) || 0) / scale);
  }

  function fingerprint(profile = {}) {
    return [
      profile.rhythm?.pulseRegularity,
      profile.rhythm?.onsetDensity,
      profile.rhythm?.rhythmicComplexity,
      profile.rhythm?.breakbeatLikelihood,
      profile.harmony?.tonalness,
      profile.harmony?.chromaEntropy,
      profile.harmony?.harmonicMotion,
      profile.timbre?.brightness,
      profile.timbre?.warmth,
      profile.timbre?.roughness,
      profile.timbre?.noisiness,
      profile.timbre?.transientSharpness,
      profile.texture?.density,
      profile.texture?.sustainedness,
      profile.texture?.granularness,
      profile.dynamics?.dynamicRange,
      profile.dynamics?.compressionDensity,
      profile.space?.spaciousness,
      profile.production?.subWeight,
      profile.production?.masterBrightness,
      profile.structure?.repetition,
      profile.structure?.sectionNovelty
    ].map(value => clamp(value));
  }

  function distance(left, right) {
    const a = left?.fingerprint || fingerprint(left);
    const b = right?.fingerprint || fingerprint(right);
    if (!a?.length || !b?.length) return 1;
    const length = Math.min(a.length, b.length);
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Math.abs(a[index] - b[index]);
    return sum / length;
  }

  function rawProfile({ audio = {}, advanced = {}, rhythm = {}, temporal = {}, novelty = {} } = {}) {
    const timbre = advanced.timbre || {};
    const dynamics = advanced.dynamics || {};
    const descriptors = advanced.instrumentationEvidence?.descriptors || {};
    const chroma = advanced.harmony?.chroma || {};
    const rms = dynamics.rms || {};
    const energy = dynamics.realtimeEnergy || dynamics.energy || {};
    const flux = advanced.spectrum?.flux || {};
    const centroid = advanced.spectrum?.centroid || {};
    const spread = timbre.spread || {};
    const flatness = timbre.flatness || {};
    const sharpness = timbre.sharpness || {};
    const pulseRegularity = clamp(rhythm.confidence ?? audio.beatConfidence);
    const onsetDensity = clamp((rhythm.onsetRate ?? audio.onsetRate) / 4.2);
    const intervalVariation = safeRatio(rhythm.beatIntervalStd, rhythm.beatIntervalMean, 0.32);
    const rhythmicComplexity = clamp(onsetDensity * 0.42 + intervalVariation * 0.3 + clamp(flux.std * 32) * 0.28);
    const speed = clamp(((rhythm.bpm || audio.bpm || 90) - 65) / 130);
    const breakbeatLikelihood = clamp(rhythmicComplexity * 0.52 + onsetDensity * 0.26 + speed * 0.22 - pulseRegularity * 0.16);
    const brightness = clamp(audio.high * 0.55 + clamp((audio.centroid ?? centroid.mean) / 9000) * 0.45);
    const warmth = clamp(audio.bass * 0.5 + (1 - brightness) * 0.28 + descriptors.lowShare * 0.22);
    const noisiness = clamp((flatness.mean || audio.flatness) * 0.72 + clamp((audio.zcr || 0) / 0.3) * 0.28);
    const roughness = clamp(noisiness * 0.46 + clamp(flux.mean * 22) * 0.3 + clamp(spread.mean / 7000) * 0.24);
    const transientSharpness = clamp(descriptors.transientDensity * 0.5 + clamp(sharpness.mean / 5) * 0.25 + clamp(flux.p90 * 18) * 0.25);
    const dynamicRange = clamp((rms.p90 - rms.p10) / Math.max(0.01, rms.mean * 1.8));
    const crestFactor = clamp((audio.crestFactorDb || 0) / 24);
    const compressionDensity = Number.isFinite(audio.compressionEstimate) ? clamp(audio.compressionEstimate) : null;
    const pumping = clamp(descriptors.bassVariation * pulseRegularity * 1.3);
    const density = clamp((energy.mean || audio.energy) * 1.8 + descriptors.midShare * 0.28 + onsetDensity * 0.18);
    const sustainedness = clamp(descriptors.sustain);
    const granularness = clamp(noisiness * 0.44 + transientSharpness * 0.36 + rhythmicComplexity * 0.2);
    const acousticElectronic = clamp(
      (advanced.instrumentationEvidence?.candidates || []).find(item => item.id === "synthPad")?.score * 0.5 +
      noisiness * 0.2 + compressionDensity * 0.3
    );
    const spaciousness = clamp(advanced.localMood?.spaciousness ?? audio.spaciousness ?? 0.5);
    const perceivedDepth = clamp(spaciousness * 0.62 + sustainedness * 0.2 + (1 - transientSharpness) * 0.18);
    const tonalness = clamp(chroma.confidence ?? audio.tonalFocus);
    const chromaEntropy = clamp(chroma.entropy ?? (1 - tonalness));
    const harmonicMotion = clamp(descriptors.chromaMotion);
    const key = chroma.dominantNotes?.[0] || null;
    const sectionNovelty = clamp(novelty.score);
    const embeddingAgreement = clamp(temporal.embeddingAgreement);

    const profile = {
      confidence: clamp((advanced.samples || 0) / 120) * 0.55 + clamp(temporal.observations / 5) * 0.45,
      rhythm: {
        bpm: Number(rhythm.bpm || audio.bpm) || 0,
        pulseRegularity,
        onsetDensity,
        rhythmicComplexity,
        breakbeatLikelihood
      },
      harmony: {
        tonalness,
        dominantPitchClass: key?.note || null,
        keyEstimate: null,
        keyConfidence: 0,
        chromaEntropy,
        harmonicMotion
      },
      timbre: { brightness, warmth, roughness, noisiness, spectralDensity: density, transientSharpness },
      texture: { density, sustainedness, granularness, acousticElectronic, layeredness: clamp(density * 0.58 + spaciousness * 0.2 + harmonicMotion * 0.22) },
      dynamics: { dynamicRange, crestFactor, compressionDensity, pumping, dropIntensity: clamp(sectionNovelty * Math.max(0, audio.energy - (energy.median || 0)) * 3.5) },
      space: { spaciousness, perceivedDepth },
      production: {
        cleanLoFi: clamp(1 - noisiness * 0.62 - roughness * 0.18 + brightness * 0.2),
        saturation: clamp(roughness * 0.42 + compressionDensity * 0.36 + warmth * 0.22),
        subWeight: clamp(audio.bass ?? descriptors.lowShare),
        masterBrightness: brightness
      },
      structure: {
        repetition: embeddingAgreement,
        sectionNovelty,
        buildupLikelihood: clamp(sectionNovelty * 0.42 + onsetDensity * 0.24 + brightness * 0.14 + pulseRegularity * 0.2),
        breakdownLikelihood: clamp(sectionNovelty * 0.46 + (1 - density) * 0.34 + spaciousness * 0.2),
        dropLikelihood: clamp(sectionNovelty * 0.4 + pumping * 0.28 + density * 0.2 + pulseRegularity * 0.12)
      }
    };
    profile.fingerprint = fingerprint(profile);
    return profile;
  }

  function smoothObject(previous, next, amount) {
    if (!previous) return typeof structuredClone === "function" ? structuredClone(next) : JSON.parse(JSON.stringify(next));
    const output = Array.isArray(next) ? [] : {};
    for (const [key, value] of Object.entries(next)) {
      if (typeof value === "number" && Number.isFinite(value)) output[key] = mix(previous[key] ?? value, value, amount);
      else if (value && typeof value === "object") output[key] = smoothObject(previous[key], value, amount);
      else output[key] = value;
    }
    return output;
  }

  class Engine {
    constructor({ historySize = 48, smoothing = 0.28 } = {}) {
      this.historySize = historySize;
      this.smoothing = smoothing;
      this.reset();
    }

    reset() {
      this.current = null;
      this.history = [];
    }

    update(input) {
      const raw = rawProfile(input);
      this.current = smoothObject(this.current, raw, this.smoothing);
      this.current.fingerprint = fingerprint(this.current);
      this.history.push(this.current.fingerprint.slice());
      if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
      return this.current;
    }
  }

  return { Engine, rawProfile, fingerprint, distance };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TrackCharacter;
