// Production detectors that distinguish unavailable from "not detected".
// Numeric fields stay null when a detector cannot run or confidence is too low for FACT.
const ProductionEvidence = (() => {
  const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
  const FACT_CONFIDENCE = 0.64;

  function report({ value = null, confidence = 0, available = false, reason = null,
    evidenceWindow = null, stability = null } = {}) {
    const ready = available && Number.isFinite(value) && confidence >= FACT_CONFIDENCE;
    return {
      value: ready ? clamp(value) : null,
      confidence: available ? clamp(confidence) : 0,
      available: Boolean(available),
      reason: available ? null : (reason || "unavailable"),
      evidenceWindow: evidenceWindow || null,
      stability: Number.isFinite(stability) ? clamp(stability) : null
    };
  }

  function numeric(entry) {
    return entry?.available && Number.isFinite(entry.value) ? entry.value : null;
  }

  function stereoWidth(context = {}) {
    const stereo = context.stereo || {};
    const channels = Number(stereo.channels || context.channelCount || 0);
    if (!(channels >= 2) && !Number.isFinite(stereo.correlation) && !Number.isFinite(stereo.sideRatio)) {
      return report({ available: false, reason: "mono_input" });
    }
    if (stereo.available === false || stereo.reason === "mono_input") {
      return report({ available: false, reason: "mono_input" });
    }
    const correlation = Number(stereo.correlation);
    const sideRatio = Number(stereo.sideRatio);
    if (!Number.isFinite(correlation) && !Number.isFinite(sideRatio)) {
      return report({ available: false, reason: "mono_input" });
    }
    const decorrelation = Number.isFinite(correlation) ? clamp(1 - Math.max(-1, Math.min(1, correlation))) : null;
    const side = Number.isFinite(sideRatio) ? clamp(sideRatio) : null;
    const value = decorrelation != null && side != null ? decorrelation * 0.55 + side * 0.45
      : decorrelation != null ? decorrelation : side;
    const agreement = decorrelation != null && side != null
      ? 1 - Math.abs(decorrelation - side) : 0.62;
    return report({
      value,
      confidence: 0.55 + agreement * 0.35,
      available: true,
      evidenceWindow: stereo.windowMs || 80,
      stability: stereo.stability ?? agreement
    });
  }

  function reverb(features = {}, frames = []) {
    const recent = (frames || []).slice(-12).filter(frame => Number.isFinite(frame.rms));
    if (recent.length < 8) return report({ available: false, reason: "insufficient_window" });
    const rms = recent.map(frame => frame.rms);
    const peaks = [];
    for (let index = 1; index + 2 < rms.length; index++) {
      if (rms[index] > rms[index - 1] && rms[index] >= rms[index + 1] && rms[index] > 0.008) peaks.push(index);
    }
    if (peaks.length < 2) return report({ available: false, reason: "no_decay_anchor" });
    const decays = [];
    for (const peak of peaks.slice(-4)) {
      const after = rms.slice(peak, peak + 4);
      if (after.length < 3) continue;
      const start = after[0];
      const tail = after[after.length - 1];
      if (start <= 1e-6) continue;
      decays.push(clamp(tail / start));
    }
    if (!decays.length) return report({ available: false, reason: "no_decay_anchor" });
    const persist = decays.reduce((sum, value) => sum + value, 0) / decays.length;
    const flux = recent.map(frame => Number(frame.flux) || 0);
    const smear = flux.length ? 1 - Math.min(1, flux.reduce((sum, value) => sum + value, 0) / flux.length) : 0.4;
    const sustain = Number(features.sustainedness ?? features.textureSustain);
    const transient = Number(features.transientDensity);
    const proxies = [persist, smear];
    if (Number.isFinite(sustain)) proxies.push(sustain);
    if (Number.isFinite(transient)) proxies.push(clamp(1 - transient));
    const value = proxies.reduce((sum, item) => sum + item, 0) / proxies.length;
    const spread = Math.max(...proxies) - Math.min(...proxies);
    const confidence = clamp(0.42 + (1 - spread) * 0.4 + Math.min(0.15, peaks.length * 0.03));
    return report({
      value,
      confidence,
      available: true,
      evidenceWindow: recent.length,
      stability: clamp(1 - spread)
    });
  }

  function distortion(features = {}) {
    const crestDb = Number(features.crestFactorDb);
    const flatness = Number(features.flatness);
    const peak = Number(features.peak);
    const rms = Number(features.rms);
    const brightness = Number(features.brightness ?? (Number.isFinite(features.centroid) ? features.centroid / 8000 : null));
    const clip = Number.isFinite(peak) ? clamp((peak - 0.92) / 0.08) : 0;
    if (!Number.isFinite(crestDb) && !Number.isFinite(flatness) && !clip) {
      return report({ available: false, reason: "insufficient_waveform" });
    }
    const lowCrest = Number.isFinite(crestDb) ? clamp((8 - crestDb) / 8) : 0;
    const noisy = Number.isFinite(flatness) ? clamp(flatness) : 0;
    // Brightness alone is not distortion: a clean bright synth can be wide-band without clipping.
    const withoutBrightness = clamp(lowCrest * 0.45 + noisy * 0.35 + clip * 0.2);
    const brightnessOnly = Number.isFinite(brightness) && brightness >= 0.7 && withoutBrightness < 0.35;
    if (brightnessOnly) {
      return report({
        value: withoutBrightness,
        confidence: 0.35,
        available: true,
        reason: null,
        evidenceWindow: 1,
        stability: 0.4
      });
    }
    const confidence = clip >= 0.5 || lowCrest >= 0.55
      ? 0.58 + Math.min(0.3, withoutBrightness * 0.35)
      : 0.4 + withoutBrightness * 0.2;
    return report({
      value: withoutBrightness,
      confidence,
      available: true,
      evidenceWindow: 1,
      stability: clamp(1 - Math.abs(lowCrest - noisy))
    });
  }

  function analyze(features = {}, frames = [], context = {}) {
    const reports = {
      stereoWidth: stereoWidth(context),
      reverb: reverb(features, frames),
      distortion: distortion(features)
    };
    return {
      reports,
      stereoWidth: numeric(reports.stereoWidth),
      reverb: numeric(reports.reverb),
      distortion: numeric(reports.distortion)
    };
  }

  return { analyze, report, numeric, stereoWidth, reverb, distortion, FACT_CONFIDENCE };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ProductionEvidence;
